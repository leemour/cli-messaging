import { setTimeout as sleep } from "node:timers/promises"
import { CliError } from "@wirecat/cli-core"
import type { Fetching } from "../cli/messenger/context.js"
import { capability } from "../cli/messenger/port.js"
import type { ActionableError } from "../cli/recovery.js"
import type { Chat, ChatKind, Id, Message } from "../domain/models.js"
import {
  type AccountKey,
  type ChatStats,
  fetchedKey,
  historyStartKey,
  type MessageStore,
  type Range,
} from "../store/store.js"
import { type Estimate, estimateBackfill } from "./backfill-estimate.js"
import { actionable, batchProgress } from "./batch.js"
import type { ServiceDeps } from "./deps.js"

import { storedChatId } from "./messages.js"
import { patiently } from "./patience.js"
import { type CatchUpOptions, type CatchUpResult, catchUpSearch, validateCatchUp } from "./search-catchup.js"

/** NEED-505 A: a messenger that pushes its history answers a request for older messages later, through `serve`. */
const pushed = (deps: ServiceDeps, what: string) => {
  if (deps.reads === "store") {
    throw new CliError(
      "validation_error",
      `${what} asks for older history, and this messenger pushes its history instead — keep ` +
        `\`${deps.messenger.app.command} serve\` running`,
    )
  }
}

/** The most messages a provider hands out per history request — Telegram's cap. */
export const PAGE = 100

/** How `store fetch` reads a messenger's history, where it says nothing of its own. */
export const FETCHING: Fetching = { page: PAGE, maxPageSize: PAGE, pause: "1s", maxPages: 10, orderBy: "id" }

/**
 * What a held stretch is keyed by, for `store fetch` and `download --all` alike: the message id, or its
 * send time in milliseconds. Not a safe integer means the messenger's ids do not order a chat.
 */
export const keyOf =
  (fetching: Fetching = FETCHING) =>
  (message: Message): number =>
    fetching.orderBy === "time" ? Date.parse(message.timestamp) : Number(message.id)

export interface FetchOptions {
  catchUp?: CatchUpOptions | false
  onRequest?: () => void
  window?: { from: number; to: number }
  /** Messages in this run. */
  limit: number
  /** Messages per request. */
  pageSize: number
  pauseMs: number
  /** Stop after the page that reaches a message older than this, epoch milliseconds. */
  sinceMs?: number
  /** Stop once the store holds this many of the chat's newest messages. */
  last?: number
  note: (message: string) => void
  stop: AbortSignal
  onPage: (progress: { fetched: number; chatId: string; oldest: number }) => void
}

/** A type, not an interface: a job keeps it as a plain record. */
export type Fetched = {
  issue?: ActionableError
  resume?: { before?: string }
  prepared?: CatchUpResult
  windowComplete?: boolean
  requests?: number
  chat: Id | null
  fetched: number
  complete: boolean
  ranges: Range[]
  reachedSince?: true
  reachedLast?: true
  stopped?: true
}

const done = (one: { complete: boolean; error?: string; stopped?: true }) => one.complete && !one.error && !one.stopped

export type FetchedAll = {
  batch?: ReturnType<ReturnType<typeof batchProgress>["result"]>
  chats: number
  fetched: number
  /** Every chat reached the window or its start, and the run was not stopped. */
  complete: boolean
  stopped?: true
  items: {
    chat: Id
    title: string | null
    fetched: number
    complete: boolean
    stopped?: true
    error?: string
    issue?: ActionableError
  }[]
}

/** The local store of messages: what it holds, filling it from the messenger, and reading it out. */
export interface ArchiveService {
  /** Per chat, or for one: what is stored, and the stretches held completely. From the store alone. */
  status(chat?: string): Promise<(ChatStats & { held: Range[] })[]>
  /** The stretches held of a chat already found by id. */
  held(chatId: Id): Promise<Range[]>
  /** One chat's stored messages, oldest first, and its title. */
  /** `since` is an ISO time: only what was sent then or later. */
  export(chat: string, options?: { since?: string }): Promise<{ title: string; messages: Message[] }>
  /** The chats an export to a folder covers: those named, or every stored chat, of these kinds if given. */
  exportable(options: { chats?: string[]; kinds?: readonly ChatKind[] }): Promise<{
    account: AccountKey
    chats: { id: Id; title: string | null }[]
  }>
  /**
   * A chat's messages for an export to a folder: every stored one, or with `after` (an earlier
   * `mark`) only what changed since, with the ids deleted since. `mark` is taken before reading, so
   * a message saved during the read shows again next time rather than never.
   */
  changes(chatId: Id, after?: string): Promise<{ messages: Message[]; deleted: Id[]; mark: string }>
  /** What a full fetch would still cost, from the store alone. */
  estimate(
    chat: string,
    options: { limit: number; pageSize: number; pauseMs: number },
  ): Promise<Estimate & { chat: Id }>
  /**
   * A chat's history into the store, newest to oldest, **resumable**: after every page the stretch
   * it covered is recorded, so a stop loses nothing and the next run jumps over what is held. Keyed
   * by `keyOf`: whole-number ids, or send times where the messenger orders by time.
   */
  fetch(chat: string, options: FetchOptions): Promise<Fetched>
  /**
   * Every chat of the account, most recently active first, each as `fetch` would — the run that
   * prepares the archive for search. A chat that fails is counted and the run goes on.
   */
  fetchAll(options: FetchOptions): Promise<FetchedAll>
  /** The chats this account has left, with their messages; `clear` deletes them. From the store alone. */
  left(options?: { clear?: boolean }): Promise<{ chats: number; messages: number }>
}

export const archiveService = (deps: ServiceDeps): ArchiveService => {
  const found = async (chat: string) => {
    const store = await deps.store()
    const account = await deps.account()
    return { store, account, chatId: await storedChatId(deps.messenger, chat, store, account) }
  }

  return {
    status: async (chat) => {
      const store = await deps.store()
      const account = await deps.account()
      const only = chat === undefined ? undefined : await storedChatId(deps.messenger, chat, store, account)
      const stats = await store.chatStats(account, only)
      return Promise.all(stats.map(async (one) => ({ ...one, held: await store.ranges(account, one.chatId) })))
    },

    held: async (chatId) => (await deps.store()).ranges(await deps.account(), chatId),

    left: async (options) => (await deps.store()).leftChats(await deps.account(), options),

    export: async (chat, { since } = {}) => {
      const { store, account, chatId } = await found(chat)
      const window = { limit: Number.MAX_SAFE_INTEGER, ...(since === undefined ? {} : { since }) }
      return {
        title: (await store.chatStats(account, chatId))[0]?.title ?? chatId,
        messages: (await store.messages(account, chatId, window)).items,
      }
    },

    exportable: async ({ chats, kinds }) => {
      const store = await deps.store()
      const account = await deps.account()
      if (chats !== undefined && chats.length > 0) {
        const named = await Promise.all(chats.map((chat) => storedChatId(deps.messenger, chat, store, account)))
        const titles = new Map((await store.chatStats(account)).map((one) => [one.chatId, one.title]))
        return { account, chats: [...new Set(named)].map((id) => ({ id, title: titles.get(id) ?? null })) }
      }
      const stored = (await store.chats(account, {})).items
      return {
        account,
        chats: stored
          .filter((chat) => kinds === undefined || kinds.includes(chat.kind))
          .map(({ id, title }) => ({ id, title })),
      }
    },

    changes: async (chatId, after) => {
      const store = await deps.store()
      const account = await deps.account()
      const mark = new Date().toISOString()
      if (after !== undefined) return { ...(await store.changes(account, chatId, after)), mark }
      const { items } = await store.messages(account, chatId, { limit: Number.MAX_SAFE_INTEGER })
      return { messages: items, deleted: [], mark }
    },

    estimate: async (chat, { limit, pageSize, pauseMs }) => {
      pushed(deps, "--estimate")
      const fetching = deps.messenger.fetching ?? FETCHING
      if (fetching.orderBy === "time") {
        throw new CliError(
          "validation_error",
          "--estimate counts the message ids missing between what is held; this messenger's ids do not count messages",
        )
      }
      const { store, account, chatId } = await found(chat)
      const newest = Number((await store.messages(account, chatId, { limit: 1 })).items[0]?.id)
      return {
        chat: chatId,
        ...estimateBackfill({
          ranges: await store.ranges(account, chatId),
          held: (await store.chatStats(account, chatId))[0]?.messages ?? 0,
          newest: Number.isSafeInteger(newest) ? newest : undefined,
          page: pageSize,
          maxPages: Math.ceil(limit / pageSize),
          pauseMs,
        }),
      }
    },

    fetch: async (chat, options) => {
      const requested = options.catchUp ?? (deps.searchCatchUp ? {} : undefined)
      if (requested) validateCatchUp(deps, requested)
      if (deps.withConnection && !deps.offline && deps.reads !== "store")
        return deps.withConnection((adapter) =>
          archiveService({ ...deps, withConnection: undefined, connection: async () => adapter }).fetch(chat, options),
        )
      pushed(deps, "`store fetch`")
      options.stop.throwIfAborted()
      const connection = await deps.connection()
      const history = capability(connection, "history", "read a chat's history")
      const self = connection.self()
      if (self === null) throw new CliError("authentication_error", "not logged in — nothing to fetch for")
      if (self !== (await deps.account()).account)
        throw new CliError("authentication_error", "the connection belongs to another account")
      if (options.stop.aborted) return { chat: null, fetched: 0, complete: false, ranges: [], stopped: true }
      const result = await fetchInto({
        history: (window) => history(chat, { ...window, reactions: false }),
        store: await deps.store(),
        account: { provider: deps.messenger.provider, account: self },
        fetching: deps.messenger.fetching ?? FETCHING,
        ...options,
      })
      return requested && result.chat
        ? { ...result, prepared: await catchUpSearch(deps, result.chat, requested, options.stop) }
        : result
    },

    fetchAll: async (options) => {
      if (deps.withConnection && !deps.offline && deps.reads !== "store")
        return deps.withConnection((adapter) =>
          archiveService({ ...deps, withConnection: undefined, connection: async () => adapter }).fetchAll(options),
        )
      pushed(deps, "`store fetch --all`")
      const connection = await deps.connection()
      const list = capability(connection, "chats", "list its chats")
      const chats: Chat[] = []
      for (let offset = 0; ; ) {
        const page = await patiently(() => list({ offset, limit: 100 }), options.note, options.stop)
        chats.push(...page.items)
        offset += page.items.length
        if (!page.hasMore || page.items.length === 0) break
      }
      chats.sort((one, other) => (other.lastMessageAt ?? "").localeCompare(one.lastMessageAt ?? ""))
      const own = archiveService({ ...deps, withConnection: undefined, connection: async () => connection })
      const answer: FetchedAll = { chats: chats.length, fetched: 0, complete: false, items: [] }
      const batch = batchProgress(deps.env)
      for (const chat of chats) {
        if (options.stop.aborted || batch.stopped) {
          answer.stopped = true
          break
        }
        try {
          const one = await own.fetch(chat.id, options)
          if (one.issue) batch.fail(chat.id, "history", one.issue)
          else batch.ok()
          answer.fetched += one.fetched
          answer.items.push({
            chat: chat.id,
            title: chat.title,
            fetched: one.fetched,
            // Reaching the window is what --all asked for; older history was not.
            complete: one.complete || one.reachedSince === true || one.reachedLast === true,
            ...(one.issue ? { error: one.issue.code, issue: one.issue } : {}),
            ...(one.stopped ? { stopped: true as const } : {}),
          })
        } catch (error) {
          // The stop is the run's, not this chat's: it ends the walk instead of being counted as a failure.
          if (options.stop.aborted) {
            answer.stopped = true
            break
          }
          const issue = batch.fail(chat.id, "history", error)
          answer.items.push({ chat: chat.id, title: chat.title, fetched: 0, complete: false, error: issue.code, issue })
        }
      }
      if (batch.failed > 0) answer.batch = batch.result()
      answer.complete = !answer.stopped && answer.items.length === chats.length && answer.items.every(done)
      return answer
    },
  }
}

/** One page of a chat's history, newest first, older than `before` when it is given. */
export type HistoryPage = (window: {
  limit: number
  before?: string
}) => Promise<{ items: Message[]; hasMore: boolean }>

export interface FetchInto extends FetchOptions {
  history: HistoryPage
  store: MessageStore
  account: AccountKey
  fetching: Fetching
}

/** The fetch loop, over any history and store: the personal account's service and a bot's command share it. */
export const abortable = async <T>(read: () => Promise<T>, signal: AbortSignal): Promise<T> => {
  signal.throwIfAborted()
  let listener: () => void = () => {}
  const interrupted = new Promise<never>((_resolve, reject) => {
    listener = () => reject(signal.reason ?? new DOMException("history read aborted", "AbortError"))
    signal.addEventListener("abort", listener, { once: true })
  })
  try {
    return await Promise.race([read(), interrupted])
  } finally {
    signal.removeEventListener("abort", listener)
  }
}

export const fetchInto = async ({
  history,
  store,
  account,
  fetching,
  limit,
  pageSize,
  pauseMs,
  sinceMs,
  last,
  note,
  stop,
  onPage,
  window,
  onRequest,
}: FetchInto): Promise<Fetched> => {
  if (window && (!Number.isSafeInteger(window.from) || !Number.isSafeInteger(window.to + 1) || window.from > window.to))
    throw new CliError("validation_error", "invalid history window")
  const byTime = fetching.orderBy === "time"
  const keyed = keyOf(fetching)
  let before =
    window === undefined
      ? undefined
      : byTime
        ? new Date(window.to + (fetching.beforeInclusive ? 0 : 1)).toISOString()
        : String(window.to + 1)
  let requests = 0
  let windowComplete = false
  let chatId: Id | undefined
  let top: number | undefined
  let fetched = 0
  // By time a page reaches back into the moment the last one ended at, so its ids repeat.
  const seen = new Set<Id>()
  let idle = 0
  let reachedStart = false
  let reachedSince = false
  let reachedLast = false
  let issue: ActionableError | undefined

  while (fetched < limit && !stop.aborted) {
    let page: Awaited<ReturnType<HistoryPage>>
    try {
      page = await patiently(
        () => {
          requests += 1
          onRequest?.()
          const read = () => history({ limit: Math.min(pageSize, limit - fetched), ...(before ? { before } : {}) })
          return window ? abortable(read, stop) : read()
        },
        note,
        stop,
      )
    } catch (error) {
      if (stop.aborted) break
      issue = actionable(error)
      // Before the first page there is nothing to resume, and only a wait is worth reporting as partial.
      if (chatId === undefined && !issue.retryable) throw error
      break
    }
    if ((page as { partial?: boolean }).partial) break
    const first = page.items[0]
    if (!first) {
      if (window === undefined) reachedStart = true
      break
    }
    chatId ??= first.chatId
    const keys = page.items.map(keyed)
    if (keys.some((key) => !Number.isSafeInteger(key))) {
      throw new CliError(
        "validation_error",
        "this messenger's message ids do not order a chat, so it cannot fetch its history",
      )
    }
    const low = Math.min(...keys)
    top ??= window?.to ?? Math.max(...keys)
    const fresh = page.items.filter((message) => !seen.has(message.id)).length
    for (const message of page.items) seen.add(message.id)
    fetched += fresh
    // This run's pages are contiguous, so everything from `low` to its first message is held.
    const coveredFrom = window === undefined ? low : Math.max(window.from, low + (byTime && page.hasMore ? 1 : 0))
    const held = coveredFrom <= top ? await store.markRange(account, chatId, coveredFrom, top) : { from: low, to: top }
    if (window !== undefined && (low < window.from || (!byTime && low === window.from))) {
      await store.markRange(account, chatId, window.from, window.to)
      windowComplete = true
      onPage({ fetched, chatId, oldest: window.from })
      break
    }
    if (window === undefined && before === undefined) await store.setSyncState(account, fetchedKey(chatId), String(top))
    onPage({ fetched, chatId, oldest: held.from })
    // Nothing new: by id the messenger ignored `before`; by time a second such page did after the step past.
    // Repeats do not count towards the limit, so without this the run would never end.
    idle = fresh === 0 ? idle + 1 : 0
    if (idle > (byTime ? 1 : 0) || (window !== undefined && byTime && fresh === 0)) break
    if (!page.hasMore) {
      if (window === undefined) reachedStart = true
      break
    }
    if (sinceMs !== undefined && page.items.some((message) => Date.parse(message.timestamp) < sinceMs)) {
      reachedSince = true
      break
    }
    const oldestAt = page.items.reduce(
      (at, message) => (message.timestamp < at ? message.timestamp : at),
      first.timestamp,
    )
    const fromAt = held.from === low ? oldestAt : await timeOfKey(store, account, chatId, held.from, byTime, oldestAt)
    if (last !== undefined && (await store.countMessages(account, chatId, { since: fromAt })) >= last) {
      reachedLast = true
      break
    }
    // Two messages can share a millisecond, and the page may have ended between them: ask up to and including
    // it. A page with nothing new means that moment holds a whole page, so step past it rather than loop.
    const boundary = window === undefined ? held.from : low
    before = byTime
      ? new Date(boundary + (fresh > 0 && !(window && fetching.beforeInclusive) ? 1 : 0)).toISOString()
      : String(boundary)
    note(`${fetched} messages so far, back to ${held.from}`)
    const wait = fetching.jitter ? pauseMs * (1 + Math.random()) : pauseMs
    await sleep(wait, undefined, { signal: stop }).catch(() => {})
  }

  const ranges = chatId === undefined ? [] : await store.ranges(account, chatId)
  // What a search says about completeness: a stretch held from the chat's very first message.
  if (reachedStart && chatId !== undefined && ranges[0]) {
    await store.setSyncState(account, historyStartKey(chatId), String(ranges[0].from))
  }
  return {
    chat: chatId ?? null,
    fetched,
    complete: reachedStart && ranges.length === 1,
    ranges,
    ...(issue ? { issue, resume: { ...(before === undefined ? {} : { before }) } } : {}),
    ...(window === undefined ? {} : { windowComplete, requests }),
    ...(reachedSince ? { reachedSince: true as const } : {}),
    ...(reachedLast ? { reachedLast: true as const } : {}),
    ...(stop.aborted ? { stopped: true as const } : {}),
  }
}

/** When the message a held stretch starts at was sent: by time the key is the time; by id, the stored message says. */
const timeOfKey = async (
  store: MessageStore,
  account: AccountKey,
  chatId: Id,
  key: number,
  byTime: boolean,
  fallback: string,
): Promise<string> => {
  if (byTime) return new Date(key).toISOString()
  const [message] = await store.around(account, chatId, String(key), { before: 0, after: 0 }).catch(() => [])
  return message?.timestamp ?? fallback
}
