import { CliError } from "@wirecat/cli-core"
import type { Messenger } from "../cli/messenger/context.js"
import { parseLocator } from "../domain/locator.js"
import { dateRange, timezoneOf } from "../search/lucene/dates.js"
import { parseLucene } from "../search/lucene/parser.js"
import { PRESET_VERSION } from "../search/lucene/presets.js"
import { FIELD_VERSION, validateAst, validateFields } from "../search/lucene/registry.js"
import { hasStems, hasText, isStemmed, type QueryExecution, type ResolvedNode } from "../search/lucene/resolved.js"
import { type QueryAst, type QueryNode, queryError, walkQuery } from "../search/lucene/types.js"
import { inSource, sourceOf } from "../search/query.js"
import { createStemmer, DEFAULT_STEMMERS, type Stemmer } from "../search/stem.js"
import type { StemsState } from "../store/sqlite/stems.js"
import {
  type AccountKey,
  CHAT_LIST_KEY,
  type ChatCompleteness,
  type ChatStats,
  type MessageStore,
} from "../store/store.js"
import { mailAround, mergeMail, withMailThreads } from "./mail-search.js"
import { chatAmong, type SearchFound, type SearchQuery, senderAmong } from "./messages.js"
import { accountsOfKind, MAIL } from "./search-kind.js"

const MAIL_FIELDS = new Set(["to", "cc", "bcc", "subject", "mailbox"])

import type { SearchRefreshed } from "./search-refresh.js"

export interface QueryMetadata {
  language: "lucene-v1"
  discovery?: {
    method: "lexical-partial"
    candidateDepth: number
    candidates: number
    repliesAdded: number
    truncated: boolean
    terms: string[]
    queries: string[]
  }
  version: 1
  fieldsVersion: number
  presetVersion: number
  timezone: string
  order: "newest" | "relevance"
  /** Present when a `text` term or phrase was stemmed: which stemmer, and each word's stem. */
  stemming?: QueryStemming
}
export type QueryStemming =
  | { applied: true; analyzer: string; terms: { word: string; stem: string; stemmer: string }[] }
  /**
   * The stems were not ready, so words matched their own forms only: `building` until the fill ends
   * (`store migrate` finishes it now), `stemmer_unknown` when a newer tool chose stemmers this one lacks.
   */
  | { applied: false; reason: "building" | "stemmer_unknown"; done: number; total: number; pending: number }
export interface SearchCoverage {
  state: "complete" | "partial" | "unknown" | "stale"
  /** The oldest `store fetch` of the chats in scope; `null` when one of them was never fetched. */
  lastSyncedAt: string | null
  /** Every account in scope has handed the store its whole chat list at least once. */
  inventoryComplete: boolean
  accounts: AccountKey[]
  chat?: string
  coveredChats: number
  /** Stored messages in the chats searched. */
  messages: number
  /** The chats searched, by what the store holds of them; `behind` misses messages newer than it holds. */
  chats: { complete: number; partial: number; neverFetched: number; behind: number; withGaps: number }
  /** Up to ten chats a fetch would improve, most recently active first. */
  attention: {
    chatId: string
    title: string | null
    state: ChatCompleteness["state"]
    gaps: boolean
    behind: boolean
  }[]
  /** The one command that would most improve this answer; `null` when the archive holds what it can. */
  next: string | null
}
const positiveSources = (node: QueryNode): string[] =>
  node.kind === "predicate"
    ? node.field === "in"
      ? [node.value.toLowerCase()]
      : []
    : node.clauses.filter(({ occur }) => occur !== "mustNot").flatMap(({ node }) => positiveSources(node))
export interface Prepared {
  wordsReady: boolean
  stemsReady: boolean
  stemming?: QueryStemming
  execution: QueryExecution
  timezone: string
  scopeAccounts: AccountKey[]
  selectedChat?: { account: AccountKey; chatId: string }
}
export const prepareLucene = async (
  store: MessageStore,
  account: AccountKey,
  request: SearchQuery,
  messenger: Partial<Pick<Messenger, "savedChatId" | "app">>,
): Promise<Prepared> => {
  if (!Number.isInteger(request.limit) || request.limit < 1 || request.limit > QUERY_PAGE_LIMIT)
    queryError("invalid_limit", { start: 0, end: 0 }, `use 1–${QUERY_PAGE_LIMIT} results`)
  if (
    request.context !== undefined &&
    (!Number.isInteger(request.context) || request.context < 0 || request.context > 20)
  )
    queryError("invalid_context", { start: 0, end: 0 }, "use 0–20 surrounding messages")
  if (request.ast !== undefined && request.text !== undefined)
    queryError("query_conflict", { start: 0, end: 0 }, "give text or AST, not both")
  if (request.ast !== undefined && request.exact)
    queryError("query_conflict", { start: 0, end: 0 }, "an AST names its fields — use field exact instead of exact")
  const ast: QueryAst =
    request.ast !== undefined
      ? validateAst(request.ast)
      : request.text === undefined
        ? {
            version: 1,
            language: "lucene-v1",
            root: {
              kind: "predicate",
              field: "date",
              operator: "range",
              value: "*",
              upper: "*",
              lowerInclusive: true,
              upperInclusive: true,
              span: { start: 0, end: 0 },
            },
          }
        : validateFields(parseLucene(request.text, { defaultField: request.exact ? "exact" : "text" }))
  const timezone = timezoneOf(request.timezone)
  const stored = await store.accounts()
  // A fresh store has no row yet for the account it runs as; "every account" still means that one.
  const held = stored.some((one) => one.provider === account.provider && one.account === account.account)
    ? stored
    : [account, ...stored]
  const providers = [...new Set([account.provider, ...held.map(({ provider }) => provider)])]
  const leaves = walkQuery(ast.root)
  const sources = positiveSources(ast.root).map((value) => sourceOf("in:", value, providers))
  for (const leaf of leaves.filter(({ field }) => field === "in")) sourceOf("in:", leaf.value, providers)
  const source = request.source === undefined ? undefined : sourceOf("--source", request.source, providers)
  if (request.accounts !== undefined && (request.source !== undefined || sources.length > 0))
    throw new CliError("validation_error", "this search reads the accounts it was given — not with in: or --source")
  if (request.accounts?.length === 0) throw new CliError("validation_error", "a search names at least one account")
  if (request.senders !== undefined && leaves.some(({ field }) => field === "from"))
    throw new CliError("validation_error", "--from and from: together — name the people once")
  const accounts = accountsOfKind(
    request.kind,
    request.accounts ??
      (source !== undefined
        ? held.filter(({ provider }) => inSource(source, provider))
        : sources.length
          ? held.filter(({ provider }) => sources.some((source) => inSource(source, provider)))
          : [account]),
    held,
    source ?? (sources.includes("email") ? "email" : sources[0]),
    messenger.app?.command,
  )
  const scopeAccounts = accounts.map(({ provider, account }) => ({ provider, account }))
  const chatLookup = scopeAccounts.some(({ provider }) => provider === MAIL) ? withMailThreads(store) : store
  const mailField = leaves.find(({ field }) => MAIL_FIELDS.has(field))
  if (mailField && !scopeAccounts.some(({ provider }) => provider === MAIL))
    queryError("unsupported_field", mailField.span, `${mailField.field}: is a mail field — search mail reads it`)
  const globalChat =
    request.chat === undefined ? undefined : await chatAmong(messenger, chatLookup, scopeAccounts, request.chat)
  const resolve = async (node: QueryNode): Promise<ResolvedNode> => {
    if (node.kind === "boolean")
      return {
        ...node,
        clauses: await Promise.all(node.clauses.map(async ({ occur, node }) => ({ occur, node: await resolve(node) }))),
      }
    if (node.field === "chat")
      return { ...node, resolution: { chat: await chatAmong(messenger, chatLookup, scopeAccounts, node.value) } }
    if (node.field === "to" || node.field === "cc" || node.field === "bcc")
      return { ...node, resolution: { sender: await senderAmong(store, scopeAccounts, node.value) } }
    if (node.field === "from")
      return node.value.toLowerCase() === "me"
        ? { ...node, resolution: { outgoing: true } }
        : { ...node, resolution: { sender: await senderAmong(store, scopeAccounts, node.value) } }
    if (node.field === "date")
      return {
        ...node,
        resolution: {
          date: dateRange(
            node.value,
            node.operator === "range" ? (node.upper ?? "*") : node.value,
            node.operator === "range" ? node.lowerInclusive === true : true,
            node.operator === "range" ? node.upperInclusive === true : true,
            timezone,
            node.span,
          ),
        },
      }
    return node
  }
  const root = await resolve(ast.root)
  const chats = leaves.filter(({ field }) => field === "chat")
  const selectedChat =
    globalChat ??
    (chats.length === 1 && requiresChat(ast.root, chats[0] as QueryNode)
      ? await chatAmong(messenger, chatLookup, scopeAccounts, (chats[0] as { value: string }).value)
      : undefined)
  if (leaves.some(({ field }) => field === "topic")) {
    if (!globalChat && (chats.length !== 1 || !requiresChat(ast.root, chats[0] as QueryNode)))
      queryError("topic_scope", { start: 0, end: 0 }, "name one required chat or use --chat")
  }
  const wordsReady = (await store.searchIndexState())?.ready === true
  if (hasText(ast.root) && !wordsReady) await indexNotReady(store, messenger.app?.command)
  const stems = await store.stemsState()
  const stemsReady = stems?.ready === true
  const { stemmer, unstemmed } = hasStems(ast.root) ? await searchStemming(store, messenger.app?.command) : {}
  const execution: QueryExecution = {
    root,
    accounts: scopeAccounts,
    limit: request.limit,
    ...(request.senders === undefined ? {} : { senders: request.senders }),
    ...(selectedChat ? { chat: selectedChat } : {}),
    ...(request.signal ? { signal: request.signal } : {}),
    newest: request.newest,
    ...(stemmer ? { stemmer } : {}),
    ...(unstemmed ? { unstemmed: true } : {}),
    ...(request.only ? { only: request.only } : {}),
  }
  return {
    execution,
    timezone,
    wordsReady,
    stemsReady,
    ...(stemmer ? { stemming: stemmingOf(ast.root, stemmer) } : unstemmed ? { stemming: unstemmed } : {}),
    scopeAccounts,
    ...(selectedChat ? { selectedChat } : {}),
  }
}
/**
 * The stemmer a search with stemmed words runs with. While the stems are built, or chosen by a newer
 * tool, none: a half-built stem index would silently drop matches, while the word index answers each
 * word's own form. Stems waiting for the owner's `store reindex` still refuse.
 */
export const searchStemming = async (
  store: MessageStore,
  command?: string,
): Promise<{ stemmer?: Stemmer; unstemmed?: QueryStemming }> => {
  const stems = await store.stemsState()
  // Ready means the setting is one this build knows, so `null` cannot reach here.
  if (stems?.ready) return { stemmer: createStemmer((await store.stemmers()) ?? DEFAULT_STEMMERS) }
  if (stems?.cause !== "building" && stems?.cause !== "stemmer_unknown") return stemsNotReady(stems, command)
  return {
    unstemmed: {
      applied: false,
      reason: stems.cause,
      done: Math.min(stems.filledThrough, stems.watermark),
      total: stems.watermark,
      pending: stems.pending,
    },
  }
}
/** Sets the stemming `searchStemming` chose on an execution built without `prepareLucene`. */
export const stemExecution = async (execution: QueryExecution, store: MessageStore): Promise<void> => {
  if (!hasStems(execution.root)) return
  const { stemmer, unstemmed } = await searchStemming(store)
  if (stemmer) execution.stemmer = stemmer
  if (unstemmed) execution.unstemmed = true
}
const stemmingOf = (root: QueryNode, stemmer: Stemmer): QueryStemming => ({
  applied: true,
  analyzer: stemmer.identity,
  terms: walkQuery(root)
    .filter(isStemmed)
    .flatMap(({ value }) => stemmer.explain(value)),
})
const stemsNotReady = (state: StemsState | undefined, command: string | undefined): never => {
  const cli = command ? `${command} ` : ""
  const exact = "search exact forms with --exact or exact:"
  if (!state)
    throw new CliError(
      "validation_error",
      `this store has no stems yet — \`${cli}store migrate\` builds them, or ${exact}`,
      {
        reason: "index_not_ready",
        index: "message_stems",
      },
    )
  const details = {
    reason: "index_not_ready",
    index: "message_stems",
    cause: state.cause,
    done: state.filledThrough,
    total: state.watermark,
    pending: state.pending,
    built: state.built,
    wanted: state.wanted,
  }
  if (state.cause === "stemmer_changed")
    throw new CliError(
      "validation_error",
      `the stems were built by ${state.built}, and the store now asks for ${state.wanted} — run \`${cli}store reindex\` (or \`${cli}store migrate\`), or ${exact}`,
      details,
    )
  if (state.cause === "stemmer_unknown")
    throw new CliError(
      "validation_error",
      `the store asks for stemmers this tool does not know — upgrade this tool, or ${exact}`,
      details,
    )
  const percent = Math.floor((Math.min(state.filledThrough, state.watermark) / Math.max(state.watermark, 1)) * 100)
  throw new CliError(
    "validation_error",
    `stems are ${percent}% built${state.pending > 0 ? `, ${state.pending} messages queued` : ""} — run \`${cli}store migrate\`, or ${exact}`,
    details,
  )
}
const indexNotReady = async (store: MessageStore, command: string | undefined): Promise<never> => {
  const state = await store.searchIndexState()
  const migrate = `\`${command ? `${command} ` : ""}store migrate\``
  const progress = !state
    ? "this store file has no word index yet"
    : state.pendingNormalization > 0
      ? `${state.pendingNormalization} messages still wait to be normalized before their words are indexed`
      : `the word index is about ${Math.floor((state.filledThrough / Math.max(state.watermark, 1)) * 100)}% built (message ${state.filledThrough} of ${state.watermark})`
  throw new CliError(
    "validation_error",
    `the word index is not ready: ${progress}. ${state ? `Each search builds a little more; ${migrate} finishes it now` : `${migrate} builds it`}. Searches without words (has:, kind:, date:) work meanwhile`,
    { reason: "index_not_ready" },
  )
}
export const coverageOf = async (
  store: MessageStore,
  { scopeAccounts, selectedChat }: Prepared,
  messenger: Partial<Pick<Messenger, "app" | "history" | "provider">> = {},
): Promise<{ completeness: (ChatCompleteness & AccountKey)[]; coverage: SearchCoverage }> => {
  const completeness: (ChatCompleteness & AccountKey)[] = []
  const stats = new Map<string, ChatStats>()
  let inventoryComplete = scopeAccounts.length > 0
  let ownInventory = true
  for (const selected of scopeAccounts) {
    if (!(await store.syncState(selected, CHAT_LIST_KEY))) {
      inventoryComplete = false
      if (messenger.provider === undefined || selected.provider === messenger.provider) ownInventory = false
    }
    const chatIds = selectedChat
      ? selected.provider === selectedChat.account.provider && selected.account === selectedChat.account.account
        ? [selectedChat.chatId]
        : []
      : (await store.chats(selected, {})).items.map(({ id }) => id)
    completeness.push(...(await store.chatCompleteness(selected, chatIds)).map((chat) => ({ ...chat, ...selected })))
    const wanted = new Set(chatIds)
    for (const one of await store.chatStats(selected))
      if (wanted.has(one.chatId)) stats.set(statKey(selected, one.chatId), one)
  }
  // Only this messenger's chats can be fetched by its command; another source's say nothing about it.
  const own = completeness.filter(({ provider }) => messenger.provider === undefined || provider === messenger.provider)
  const behind = (chat: ChatCompleteness) => chat.upToDate === false
  const needs = (chat: ChatCompleteness) => chat.state !== "complete" || chat.gaps || behind(chat)
  const recent = (chat: ChatCompleteness & AccountKey) => stats.get(statKey(chat, chat.chatId))?.newestAt ?? ""
  const attention = own
    .filter(needs)
    .sort((one, other) => recent(other).localeCompare(recent(one)))
    .slice(0, 10)
    .map((chat) => ({
      chatId: chat.chatId,
      title: stats.get(statKey(chat, chat.chatId))?.title ?? null,
      state: chat.state,
      gaps: chat.gaps,
      behind: behind(chat),
    }))
  const neverFetched = own.filter(({ state }) => state === "unknown").length
  const behindCount = own.filter(behind).length
  // A chat held back to a window stays partial for good, so only what a fetch would change is advised.
  const command = messenger.history === "store" ? undefined : messenger.app?.command
  const next =
    command === undefined
      ? null
      : selectedChat
        ? neverFetched || behindCount
          ? `${command} store fetch ${selectedChat.chatId}`
          : null
        : neverFetched || behindCount || !ownInventory
          ? `${command} store fetch --all --background`
          : null
  const state =
    selectedChat && completeness.length > 0 && completeness.every(({ state }) => state === "complete")
      ? "complete"
      : completeness.some(({ state }) => state !== "unknown")
        ? "partial"
        : "unknown"
  return {
    completeness,
    coverage: {
      state,
      lastSyncedAt: oldestFetch(completeness),
      inventoryComplete,
      accounts: scopeAccounts,
      ...(selectedChat ? { chat: selectedChat.chatId } : {}),
      coveredChats: completeness.length,
      messages: [...stats.values()].reduce((sum, one) => sum + one.messages, 0),
      chats: {
        complete: own.filter(({ state }) => state === "complete").length,
        partial: own.filter(({ state }) => state === "partial").length,
        neverFetched,
        behind: behindCount,
        withGaps: own.filter(({ gaps }) => gaps).length,
      },
      attention,
      next,
    },
  }
}
const statKey = (account: AccountKey, chatId: string) => JSON.stringify([account.provider, account.account, chatId])
const queryOf = (timezone: string, newest?: boolean, stemming?: QueryStemming): QueryMetadata => ({
  language: "lucene-v1",
  version: 1,
  fieldsVersion: FIELD_VERSION,
  presetVersion: PRESET_VERSION,
  timezone,
  order: newest ? "newest" : "relevance",
  ...(stemming ? { stemming } : {}),
})
export const searchLucene = async (
  store: MessageStore,
  account: AccountKey,
  request: SearchQuery,
  messenger: Partial<Pick<Messenger, "savedChatId" | "app" | "history" | "provider">> = {},
): Promise<SearchFound> => {
  const prepared = await prepareLucene(store, account, request, messenger)
  const execute = store.matchQuery
  if (!execute)
    throw new CliError("validation_error", "this store does not support the Lucene profile — upgrade cli-messaging")
  const mailAccounts = prepared.scopeAccounts.filter(({ provider }) => provider === MAIL)
  const inMailTables = async () => {
    try {
      return await execute({ ...prepared.execution, accounts: mailAccounts, corpus: "mail" })
    } catch (error) {
      // A messenger field (`kind:`, `topic:`) leaves mail out of a search that names messenger accounts too.
      if (request.kind !== "mail" && error instanceof CliError && error.code === "validation_error")
        return { items: [], hasMore: false }
      throw error
    }
  }
  const found = !prepared.scopeAccounts.length
    ? { items: [], hasMore: false }
    : mailAccounts.length
      ? mergeMail(await execute(prepared.execution), await inMailTables(), request.limit, request.newest)
      : await execute(prepared.execution)
  const { completeness, coverage } = await coverageOf(store, prepared, messenger)
  const items = await Promise.all(
    found.items.map(async (hit) => {
      if (!request.context) return hit
      const locator = parseLocator(hit.locator)
      return {
        ...hit,
        context:
          (locator.provider === MAIL ? await mailAround(store, hit, request.context) : undefined) ??
          (await store.around({ provider: locator.provider, account: locator.account }, hit.chatId, hit.id, {
            before: request.context,
            after: request.context,
          })),
      }
    }),
  )
  return {
    ...found,
    items,
    corrections: [],
    wordsReady: prepared.wordsReady,
    stemsReady: prepared.stemsReady,
    completeness,
    query: queryOf(prepared.timezone, request.newest, prepared.stemming),
    coverage,
  }
}
const QUERY_PAGE_LIMIT = 1000
const oldestFetch = (chats: ChatCompleteness[]): string | null =>
  chats.length === 0 || chats.some(({ fetchedAt }) => fetchedAt === null)
    ? null
    : (chats.map(({ fetchedAt }) => fetchedAt as string).sort()[0] as string)
const requiresChat = (node: QueryNode, chat: QueryNode): boolean =>
  node === chat ||
  (node.kind === "boolean" && node.clauses.some((clause) => clause.occur === "must" && requiresChat(clause.node, chat)))

export type StatsGrouping = "chat" | "sender" | "day" | "hour"
export interface StatsRow {
  key: string
  name: string | null
  account?: AccountKey
  count: number
}
export interface MessageStats {
  refreshed?: SearchRefreshed
  by: StatsGrouping
  items: StatsRow[]
  total: number
  hasMore: boolean
  query: QueryMetadata
  coverage: SearchCoverage
  completeness: (ChatCompleteness & AccountKey)[]
}
export const calendarKey = (zone: string, by: "day" | "hour") => {
  const format = new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    ...(by === "hour" ? { hour: "2-digit", hourCycle: "h23" } : {}),
  } as Intl.DateTimeFormatOptions)
  return (time: number) => {
    const part = Object.fromEntries(format.formatToParts(time).map(({ type, value }) => [type, value]))
    return `${part.year}-${part.month}-${part.day}${by === "hour" ? `T${part.hour}` : ""}`
  }
}
/** Distinct matching messages counted by chat, sender, or calendar day/hour in the query's timezone. */
export const statsLucene = async (
  store: MessageStore,
  account: AccountKey,
  request: SearchQuery & { by: StatsGrouping },
  messenger: Partial<Pick<Messenger, "savedChatId" | "app" | "history" | "provider">> = {},
): Promise<MessageStats> => {
  const prepared = await prepareLucene(store, account, request, messenger)
  const count = store.countQuery
  if (!count)
    throw new CliError("validation_error", "this store does not support the Lucene profile — upgrade cli-messaging")
  const { by } = request
  const calendar = by === "day" || by === "hour"
  const groups = prepared.scopeAccounts.length ? await count(prepared.execution, calendar ? "time" : by) : []
  let rows: StatsRow[]
  if (calendar) {
    const keyOf = calendarKey(prepared.timezone, by)
    const totals = new Map<string, number>()
    for (const { id, count } of groups) {
      const key = keyOf(Number(id))
      totals.set(key, (totals.get(key) ?? 0) + count)
    }
    rows = [...totals].sort(([a], [b]) => a.localeCompare(b)).map(([key, count]) => ({ key, name: null, count }))
  } else
    rows = groups
      .map(({ provider, account, id, name, outgoing, count }) => ({
        key: id ?? (outgoing ? "me" : "unknown"),
        name,
        ...(provider === undefined || account === undefined ? {} : { account: { provider, account } }),
        count,
      }))
      .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key))
  const { completeness, coverage } = await coverageOf(store, prepared, messenger)
  return {
    by,
    items: rows.slice(0, request.limit),
    total: groups.reduce((sum, { count }) => sum + count, 0),
    hasMore: rows.length > request.limit,
    query: queryOf(prepared.timezone, request.newest, prepared.stemming),
    coverage,
    completeness,
  }
}
