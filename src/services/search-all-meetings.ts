import { CliError } from "@wirecat/cli-core"
import type { SearchHit } from "@wirecat/cli-meetings"
import type { Messenger } from "../cli/messenger/context.js"
import { parseLucene } from "../search/lucene/parser.js"
import type { QueryNode } from "../search/lucene/types.js"
import { codeOf } from "../sends/guarded.js"
import type { AccountKey, MessageStore, StoredAccount } from "../store/store.js"
import type { SearchFound, SearchQuery } from "./messages.js"
import { RRF_K } from "./notes-search.js"
import {
  RESOURCES_SEARCHED,
  type SearchAllFound,
  type SearchAllItem,
  type SearchAllRequest,
  type SearchedResource,
  searchAll,
} from "./search-all.js"

export const RESOURCES_SEARCHED_WITH_MEETINGS = [...RESOURCES_SEARCHED, "meetings"] as const
export type ResourceWithMeetings = (typeof RESOURCES_SEARCHED_WITH_MEETINGS)[number]
export interface MeetingSearchItem {
  kind: "meeting"
  provider: string
  account: string
  accountId: number
  title: string | null
  timestamp: string | null
  text: string
  meetingId: number
  scope: SearchHit["scope"]
  id: number
  startMs: number | null
}
export interface MeetingSearchCursor {
  accountId: number
  /** The supported query's words, bound to the selected account. */
  query: string
  meetingOffset: number
  hitOffset: number
}
export interface SearchAllIncludingMeetingsRequest extends Omit<SearchAllRequest, "only"> {
  only?: readonly ResourceWithMeetings[]
  /** Defaults to the caller's selected account; other meeting accounts are explicit. */
  meetingAccount?: AccountKey
  /** Candidate meetings visited, not hit rows allocated by the store. Defaults to 100, at most 1000. */
  maxMeetings?: number
  /** Source continuation only: requires only: ["meetings"]. Offsets are not a snapshot. */
  meetingCursor?: MeetingSearchCursor
}
export interface MeetingSearchCoverage {
  accountId: number
  by: "word-prefixes"
  meetingsScanned: number
  complete: boolean
  nextCursor?: MeetingSearchCursor
}
export interface SearchAllIncludingMeetingsFound
  extends Omit<SearchAllFound, "items" | "searched" | "skipped" | "hasMore"> {
  items: (SearchAllItem | MeetingSearchItem)[]
  /** null means a bounded meeting scan did not prove whether another match exists. */
  hasMore: boolean | null
  searched: ResourceWithMeetings[]
  skipped: { resource: ResourceWithMeetings; reason: string }[]
  meetings?: MeetingSearchCoverage
}

const whole = (value: number, minimum: number, maximum: number, label: string): number => {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum)
    throw new CliError("validation_error", `${label} must be an integer from ${minimum} through ${maximum}`)
  return value
}
const cancelled = (signal?: AbortSignal) => {
  if (signal?.aborted) throw new CliError("cancelled", "search was cancelled", { complete: false })
}
const meetingQuery = (text: string, exact?: boolean): { query: string } | { reason: string } => {
  if (exact) return { reason: "meetings use word prefixes and cannot answer --exact" }
  try {
    const terms: string[] = []
    const supported = (node: QueryNode): boolean => {
      if (node.kind === "boolean") return node.clauses.every(({ occur, node }) => occur === "must" && supported(node))
      if (node.field !== "text" || node.operator !== "term" || !/^[\p{L}\p{N}]+$/u.test(node.value)) return false
      terms.push(node.value)
      return true
    }
    if (!supported(parseLucene(text).root) || !terms.length)
      return {
        reason:
          "meetings support letter/digit words joined by AND; phrases, OR/NOT, patterns and filters are unsupported",
      }
    return { query: terms.join(" ") }
  } catch (error) {
    if (codeOf(error) !== "validation_error") throw error
    return { reason: error instanceof Error ? error.message : "invalid meeting search query" }
  }
}
interface CollectedMeetings {
  items: { item: MeetingSearchItem; before: MeetingSearchCursor }[]
  coverage: Omit<MeetingSearchCoverage, "nextCursor">
  after: MeetingSearchCursor
}
const collectMeetings = async (
  store: MessageStore,
  account: AccountKey,
  request: SearchAllIncludingMeetingsRequest,
  query: string,
): Promise<CollectedMeetings> => {
  cancelled(request.signal)
  const selected = await store.storedAccount(account)
  cancelled(request.signal)
  whole(selected.id, 1, Number.MAX_SAFE_INTEGER, "meeting account id")
  if (account.scope !== undefined && selected.scope !== account.scope)
    throw new CliError("not_found", "the selected meeting account has a different scope")
  const cursor = request.meetingCursor
  if (cursor && (cursor.accountId !== selected.id || cursor.query !== query))
    throw new CliError("validation_error", "meeting cursor belongs to a different account or query")
  let meetingOffset = cursor?.meetingOffset ?? 0
  let hitOffset = cursor?.hitOffset ?? 0
  const position = (): MeetingSearchCursor => ({ accountId: selected.id, query, meetingOffset, hitOffset })
  const collected: CollectedMeetings = {
    items: [],
    coverage: { accountId: selected.id, by: "word-prefixes", meetingsScanned: 0, complete: false },
    after: position(),
  }
  const seen = new Set<string>()
  while (collected.coverage.meetingsScanned < (request.maxMeetings ?? 100)) {
    cancelled(request.signal)
    const page = await store.meetings.meetings({ accountId: selected.id, limit: 2, offset: meetingOffset })
    cancelled(request.signal)
    const meeting = page[0]
    if (!meeting) {
      collected.coverage.complete = true
      break
    }
    const hits = await store.meetings.search(query, { accountId: selected.id, limit: 1, offset: meetingOffset })
    cancelled(request.signal)
    if (
      meeting.accountId !== selected.id ||
      meeting.deletedAt !== null ||
      hits.some((hit) => hit.meetingId !== meeting.id)
    )
      throw new CliError("validation_error", "meeting archive changed during search; restart from the first page", {
        complete: false,
      })
    if (hitOffset > hits.length)
      throw new CliError("validation_error", "meeting cursor is past the current hit list; restart from the first page")
    collected.coverage.meetingsScanned++
    for (; hitOffset < hits.length; hitOffset++) {
      const hit = hits[hitOffset] as SearchHit
      const key = JSON.stringify([selected.id, hit.meetingId, hit.scope, hit.id])
      if (seen.has(key)) continue
      seen.add(key)
      collected.items.push({
        before: position(),
        item: {
          kind: "meeting",
          provider: selected.provider,
          account: selected.account,
          accountId: selected.id,
          title: meeting.title,
          timestamp: meeting.startedAt === null ? null : new Date(meeting.startedAt).toISOString(),
          text: hit.text.slice(0, 2000),
          meetingId: hit.meetingId,
          scope: hit.scope,
          id: hit.id,
          startMs: hit.startMs,
        },
      })
      if (collected.items.length > request.limit) {
        hitOffset++
        break
      }
    }
    if (hitOffset === hits.length) {
      meetingOffset++
      hitOffset = 0
      if (page.length < 2) collected.coverage.complete = true
    }
    collected.after = position()
    if (collected.coverage.complete || collected.items.length > request.limit) break
  }
  return collected
}

/** Opt-in fusion of the existing unified ranking and one explicitly scoped meeting archive. */
export const searchAllIncludingMeetings = async (
  store: MessageStore,
  account: AccountKey,
  request: SearchAllIncludingMeetingsRequest,
  messenger: Partial<Pick<Messenger, "savedChatId" | "app">> = {},
  searchMessages?: (query: SearchQuery) => Promise<SearchFound>,
): Promise<SearchAllIncludingMeetingsFound> => {
  whole(request.limit, 1, 1000, "limit")
  whole(request.maxMeetings ?? 100, 1, 1000, "maxMeetings")
  const only = request.only ?? RESOURCES_SEARCHED_WITH_MEETINGS
  if (
    !only.length ||
    only.some((resource) => !(RESOURCES_SEARCHED_WITH_MEETINGS as readonly string[]).includes(resource))
  )
    throw new CliError("validation_error", "only takes messages, mail, notes and meetings")
  if (request.meetingCursor) {
    if (only.length !== 1 || only[0] !== "meetings")
      throw new CliError("validation_error", "meeting cursor requires only: [meetings]")
    whole(request.meetingCursor.accountId, 1, Number.MAX_SAFE_INTEGER, "cursor account id")
    whole(request.meetingCursor.meetingOffset, 0, Number.MAX_SAFE_INTEGER - 2, "cursor meeting offset")
    whole(request.meetingCursor.hitOffset, 0, Number.MAX_SAFE_INTEGER, "cursor hit offset")
  }
  cancelled(request.signal)
  const legacy = await searchAll(
    store,
    account,
    { ...request, only: only.filter((one): one is SearchedResource => one !== "meetings") },
    messenger,
    searchMessages,
  )
  cancelled(request.signal)
  if (!only.includes("meetings")) return legacy
  const compiled = meetingQuery(request.text, request.exact)
  if ("reason" in compiled)
    return { ...legacy, skipped: [...legacy.skipped, { resource: "meetings", reason: compiled.reason }] }
  let meetings: CollectedMeetings
  try {
    meetings = await collectMeetings(store, request.meetingAccount ?? account, request, compiled.query)
  } catch (error) {
    if (codeOf(error) !== "not_found") throw error
    return {
      ...legacy,
      skipped: [...legacy.skipped, { resource: "meetings", reason: "the selected meeting account is not stored" }],
    }
  }
  const ranked = new Map<string, { item: SearchAllItem | MeetingSearchItem; score: number }>()
  for (const list of [legacy.items, meetings.items.map(({ item }) => item)])
    list.forEach((item, rank) => {
      const key =
        item.kind === "meeting"
          ? JSON.stringify([item.kind, item.accountId, item.meetingId, item.scope, item.id])
          : item.ref
      const held = ranked.get(key) ?? { item, score: 0 }
      held.score += 1 / (RRF_K + rank + 1)
      ranked.set(key, held)
    })
  const ordered = [...ranked.values()].sort((a, b) => b.score - a.score).map(({ item }) => item)
  const items = ordered.slice(0, request.limit)
  const returnedMeetings = items.filter((item) => item.kind === "meeting").length
  const nextCursor =
    meetings.items[returnedMeetings]?.before ?? (!meetings.coverage.complete ? meetings.after : undefined)
  return {
    ...legacy,
    items,
    hasMore: legacy.hasMore || ordered.length > request.limit ? true : meetings.coverage.complete ? false : null,
    searched: [...legacy.searched, "meetings"],
    meetings: { ...meetings.coverage, ...(nextCursor ? { nextCursor } : {}) },
  }
}

export interface SearchAllWithMeetingsRequest extends Omit<SearchAllIncludingMeetingsRequest, "meetingAccount"> {
  /** Omitted: the one stored account that holds meetings; several is a validation error, none skips meetings. */
  meetingAccount?: AccountKey
}

/** `provider:account`, split on the first colon: a meeting account's own id may hold colons. */
export const meetingAccountOf = (value: string): AccountKey => {
  const colon = value.indexOf(":")
  if (colon < 1 || colon === value.length - 1)
    throw new CliError(
      "validation_error",
      `a meeting account is provider:account, such as zoom:<account>; got "${value}"`,
    )
  return { provider: value.slice(0, colon), account: value.slice(colon + 1) }
}

const accountsWithMeetings = async (store: MessageStore) => {
  const held: StoredAccount[] = []
  for (const stored of await store.storedAccounts())
    if ((await store.meetings.meetings({ accountId: stored.id, limit: 1 })).length) held.push(stored)
  return held
}

/**
 * `search all --meetings`: never falls back to the caller's own account, which for a messenger CLI is
 * not a meeting account and would silently find nothing.
 */
export const searchAllWithMeetings = async (
  store: MessageStore,
  account: AccountKey,
  request: SearchAllWithMeetingsRequest,
  messenger: Partial<Pick<Messenger, "savedChatId" | "app">> = {},
  searchMessages?: (query: SearchQuery) => Promise<SearchFound>,
): Promise<SearchAllIncludingMeetingsFound> => {
  const only = request.only ?? RESOURCES_SEARCHED_WITH_MEETINGS
  if (request.meetingAccount || !only.includes("meetings"))
    return searchAllIncludingMeetings(store, account, request, messenger, searchMessages)
  const held = await accountsWithMeetings(store)
  if (held.length > 1) {
    const names = held.map((one) => `${one.provider}:${one.account}`)
    throw new CliError("validation_error", `several stored accounts hold meetings; name one of: ${names.join(", ")}`, {
      accounts: names,
    })
  }
  const [one] = held
  if (one)
    return searchAllIncludingMeetings(
      store,
      account,
      { ...request, meetingAccount: { provider: one.provider, account: one.account, scope: one.scope } },
      messenger,
      searchMessages,
    )
  const found = await searchAll(
    store,
    account,
    { ...request, only: only.filter((resource): resource is SearchedResource => resource !== "meetings") },
    messenger,
    searchMessages,
  )
  return { ...found, skipped: [...found.skipped, { resource: "meetings", reason: "no stored account holds meetings" }] }
}
