import { CliError, singleLine } from "@wirecat/cli-core"
import type { MediaOption, Messenger } from "../cli/messenger/context.js"
import { type After, capability, type Download, type MessengerAdapter, type Sent } from "../cli/messenger/port.js"
import { threadIdOf } from "../cli/messenger/thread.js"
import type { DownloadedFile } from "../domain/attachments.js"
import { type FormattedText, validateFormattedText, visibleFormattedText } from "../domain/formatting.js"
import { formatLocator, parseLocator } from "../domain/locator.js"
import { type MessageLink, messageLinkTarget, validatePermalink } from "../domain/message-link.js"
import type { Chat, Deletion, Discussion, Id, Message, Page, Provider, WindowedMessage } from "../domain/models.js"
import { isId, pickChat, pickPerson } from "../resolve.js"
import { inSource, parseQuery, sourceOf } from "../search/query.js"
import { type Match, search } from "../search/search.js"
import { codeOf, guardedWrite, type Operated } from "../sends/guarded.js"
import type { PermissionKey } from "../sends/permissions.js"
import { sendAsCheck } from "../sends/send-as.js"
import { newOperationId, newSendId } from "../sends/send-id.js"
import type { Upload } from "../sends/upload.js"
import type {
  AccountKey,
  ChatCompleteness,
  MessageStore,
  SearchCommand,
  SearchScope,
  StoredHit,
  WordQuery,
} from "../store/store.js"
import { fromStore, nothingStored, PUSHED, type ServiceDeps } from "./deps.js"
import { searchDiscovery } from "./messages-discovery.js"
import {
  type MessageStats,
  type QueryMetadata,
  type SearchCoverage,
  type StatsGrouping,
  searchLucene,
  statsLucene,
} from "./messages-search.js"
import { type SearchAllFound, type SearchAllRequest, searchAll } from "./search-all.js"
import {
  type SearchAllIncludingMeetingsFound,
  type SearchAllWithMeetingsRequest,
  searchAllWithMeetings,
} from "./search-all-meetings.js"
import { accountsOfKind, type SearchKind } from "./search-kind.js"
import { refreshSearch, type SearchRefreshed, type SyncOptions, withRefresh } from "./search-refresh.js"
import { type SearchParams, searchRecordOf } from "./searches.js"
import {
  type Backend,
  type HitSource,
  type ServerOptions,
  type ServerSearched,
  type ServerStep,
  searchServer,
  sourceKey,
} from "./server-search.js"
import { readThreadContext, type ThreadContext, type ThreadOptions, threadBounds } from "./thread-context.js"

export interface ListWindow {
  limit: number
  before?: string
  /** Read back from this moment, epoch milliseconds. */
  beforeTime?: number
  /** Read forward from this message or moment, parsed by the caller in its own words (`afterOf`). */
  after?: After
  /** Only this forum topic. */
  threadId?: string
}

export interface AroundWindow {
  before: number
  after: number
}

export interface SearchQuery {
  thread?: ThreadOptions
  syncFirst?: SyncOptions
  /** Where to search: the local archive, the messenger's server, or both (the default). */
  backend?: Backend
  server?: ServerOptions
  /** Only these messages of the account it runs as — `--backend server` searches what the server returned. */
  only?: { chatId: Id; id: Id }[]
  /** Strict Lucene by default; legacy discovery is explicit through language or a RegExp pattern. */
  text?: string
  discover?: boolean
  language?: "lucene" | "legacy"
  timezone?: string
  ast?: unknown
  signal?: AbortSignal
  pattern?: RegExp
  chat?: string
  /** A messenger the store holds, or `all` — the same as `in:` in the query. The account it runs as when unset. */
  source?: string
  /** These accounts instead of the one it runs as, already checked by the caller; not with `source` or `in:`. */
  accounts?: AccountKey[]
  /** `messages` leaves mail out and refuses `in:email`; `mail` reads the mailboxes only. Every kind when unset. */
  kind?: SearchKind
  /** Any of these senders, already resolved by the caller; not with `from:`. */
  senders?: { provider: Provider; id: Id }[]
  limit: number
  /** Newest first instead of best first. */
  newest?: boolean
  /** Bare words and quotes match their exact form only: the default field becomes `exact`. */
  exact?: boolean
  /** Messages before and after each hit, from the store. */
  context?: number
  /** The saved search this run came from (`--saved`), by id: its row counts the run too. */
  saved?: string
}

export type FoundMessage = StoredHit & {
  discovery?: { coverage: number; matchedTerms: string[]; missingTerms: string[]; parent?: string }
  match?: Match
  score?: number | null
  exact?: boolean
  source?: HitSource
  context?: WindowedMessage[]
  thread?: ThreadContext
}

export interface SearchFound extends Page<FoundMessage> {
  refreshed?: SearchRefreshed
  server?: ServerSearched
  query?: QueryMetadata
  coverage?: SearchCoverage
  corrections: { from: string; to: string[] }[]
  /** Per chat of the page: how much of its history the store holds. */
  completeness: (ChatCompleteness & AccountKey)[]
  /** `false` while the word index is being built: the answer came from the substring index. */
  wordsReady: boolean
  /** The same for the stems, in strict search: `false` until a stemmed search may run. */
  stemsReady?: boolean
}

export interface SendRequest {
  chat: string
  /** As typed: with `markdown`, the marks are taken out before it is sent or measured. */
  text: string
  sendId?: string
  replyTo?: string
  threadId?: string
  silent?: boolean
  noPreview?: boolean
  markdown?: boolean
  /** The text is HTML; not with `markdown`. */
  html?: boolean
  /** ISO time to send it at; refused together with `sendId`. */
  at?: string
  attachments?: Upload[]
  /** The level it is checked against, where it is not `messages.send`: a rule's reply is `replies.send`. */
  key?: PermissionKey
  /** Who sent it, in the send journal: `rule:<id>`. */
  origin?: string
  spoiler?: boolean
  captionAbove?: boolean
  /** A sticker by id, sent alone. */
  sticker?: Id
  /** One of the ids `chats.sendAs` lists for this chat. */
  sendAs?: Id
  /** A post of `chat`, a channel: the message goes to the post's discussion as a reply to it. */
  commentTo?: Id
}

/** One message in a chat, as typed. */
export interface MessageTarget {
  chat: string
  message: string
}

export interface Pinned {
  chatId: Id
  messageId: Id
  pinned: boolean
}

export interface Reacted {
  chatId: Id
  messageId: Id
  /** `null` once it is taken off. */
  reaction: string | null
}

/** max-cli's: many at once is what a ban for automation looks like. */
export const DELETE_AT_ONCE = 10

/** How long a search may spend building the word index, then the stems, first (phase 2 plan S3: about 200 ms). */
export const SEARCH_FILL_MS = 200

export const statsStore = async (
  store: MessageStore,
  account: AccountKey,
  request: SearchQuery & { by: StatsGrouping },
  messenger: Saved = {},
): Promise<MessageStats> => {
  const stop = Date.now() + SEARCH_FILL_MS
  await store.fillSearchIndex({ until: () => Date.now() >= stop })
  await store.fillStems({ until: () => Date.now() >= stop })
  return statsLucene(store, account, request, messenger)
}

/** What a store search reads of the messenger: its saved-messages chat, and its command for a hint. */
type Saved = Partial<Pick<Messenger, "savedChatId" | "app">>

/** Every write goes through the guard: asked before it goes, told after, on every outcome. */
export interface MessagesService {
  list(chat: string, window: ListWindow): Promise<Page<Message>>
  around(chat: string, message: string | undefined, window: AroundWindow): Promise<WindowedMessage[]>
  thread(chat: string, message?: Id, options?: ThreadOptions): Promise<ThreadContext>
  link(chat: string, message?: string): Promise<MessageLink>
  /** A channel post's comments, from the messenger; `discussion` says where they live. */
  comments(
    chat: string,
    post: string,
    window: { limit: number; before?: string },
  ): Promise<Page<Message> & { discussion: Discussion }>
  /** The files of one message. Always from the messenger, whatever its history is read from. */
  download(chat: string, message: Id): Promise<Download>
  /**
   * Records in the local store where the files went, so their text can be read later. Only a
   * message the store holds; answers how many attachments it recorded.
   */
  keepDownloaded(chat: string, message: Id, files: readonly DownloadedFile[]): Promise<number>
  /** From the local store only; never asks the messenger. */
  search(query: SearchQuery): Promise<SearchFound>
  /** Messages, mail and notes at once; messages with the same server step `search` takes. */
  searchAll(request: SearchAllRequest): Promise<SearchAllFound>
  /** `searchAll` plus one meeting account's transcripts, chat and summaries. */
  searchAllWithMeetings(request: SearchAllWithMeetingsRequest): Promise<SearchAllIncludingMeetingsFound>
  /** Counts of what a strict query matches, by chat, sender, day or hour; from the local store only. */
  stats(query: SearchQuery & { by: StatsGrouping }): Promise<MessageStats>
  /** A reply is a send with `replyTo`. */
  send(request: SendRequest): Promise<Operated<Sent>>
  /** With `markdown` or `html`, the marks are taken out as a send takes them. */
  edit(
    target: MessageTarget & { text: string; markdown?: boolean; html?: boolean },
  ): Promise<Operated<{ message: Message }>>
  /** Each message counts toward the hourly limit. */
  delete(request: { chat: string; messages: string[]; forEveryone: boolean }): Promise<Operated<Deletion>>
  /** Guarded against the chat it goes to: that is where somebody new reads it. */
  forward(
    target: MessageTarget & { to: string; silent: boolean; sendId?: string; sendAs?: Id; threadId?: Id },
  ): Promise<Operated<{ sendId: string; message: Message }>>
  /** Counts toward the hourly limit only when it notifies. */
  pin(target: MessageTarget & { notify: boolean }): Promise<Operated<Pinned>>
  unpin(target: MessageTarget): Promise<Operated<Pinned>>
  /** `null` takes the reaction off. A reaction never counts toward the hourly limit. */
  react(target: MessageTarget & { emoji: string | null }): Promise<Operated<Reacted>>
}

export const messagesService = (deps: ServiceDeps): MessagesService => {
  const { guard } = deps
  const inStore = async <T>(read: (store: MessageStore, account: AccountKey) => Promise<T>): Promise<T> =>
    read(await deps.store(), await deps.account())

  const serverThenStore = async (store: MessageStore, account: AccountKey, query: SearchQuery) => {
    const server = await searchServer(deps, query)
    const only =
      query.backend === "server" && server
        ? [...server.sources.keys()].map((key) => {
            const [chatId, id] = JSON.parse(key) as [Id, Id]
            return { chatId, id }
          })
        : undefined
    const found = await searchStore(store, account, only ? { ...query, only } : query, deps.messenger)
    return { found, server }
  }

  const unifiedMessages =
    (store: MessageStore, account: AccountKey) =>
    async (query: SearchQuery): Promise<SearchFound> => {
      await topUp(store)
      const { found, server } = await serverThenStore(store, account, query)
      return withServer(found, server)
    }

  /**
   * Only a run that answered is kept: a refused query is the caller's typo, not a search. The answer is
   * already in hand, so a history write that fails — the store busy under `serve` — never fails the search.
   */
  const remember = async (store: MessageStore, command: SearchCommand, query: SearchQuery & { by?: StatsGrouping }) => {
    if (deps.history === false) return
    await store
      .recordSearch(searchRecordOf(command, paramsOf(command, query)), {
        ...(query.saved === undefined ? {} : { saved: query.saved }),
      })
      .catch(() => undefined)
  }

  const pinning = async (
    { chat, message }: MessageTarget,
    pinned: boolean,
    notify: boolean,
  ): Promise<Operated<Pinned>> => {
    const connection = await deps.connection()
    const act = pinned
      ? capability(connection, "pin", "pin a message")
      : capability(connection, "unpin", "unpin a message")
    const { id: chatId } = await connection.resolve(chat)
    const operationId = newOperationId()
    await guardedWrite(
      guard,
      { operationId, chatId, kind: "pin", key: pinned ? "messages.pin" : "messages.unpin", messageId: message, notify },
      () => act(chatId, message, { notify }),
    )
    return { operationId, chatId, messageId: message, pinned }
  }

  const topicPage = async (
    chat: string,
    threadId: string,
    { limit, before, beforeTime, after }: ListWindow,
  ): Promise<Page<Message>> => {
    if (beforeTime !== undefined || after !== undefined)
      throw new CliError("validation_error", "a topic is read back from its newest message, or from --before-id")
    if (threadId === "1")
      throw new CliError(
        "validation_error",
        "the General topic's messages carry no topic id — read the whole chat without --topic",
      )
    const window = { limit, ...(before === undefined ? {} : { before }) }
    if (fromStore(deps)) {
      return inStore(async (store, account) =>
        store.messages(account, await readChatId(deps, chat, store, account), { ...window, threadId }),
      )
    }
    return capability(await deps.connection(), "topicHistory", "read one forum topic")(chat, threadId, window)
  }

  return {
    list: async (chat, { limit, before, beforeTime, after, threadId: typedThread }) => {
      const threadId = threadIdOf(typedThread)
      if (threadId !== undefined) return topicPage(chat, threadId, { limit, before, beforeTime, after })
      if (beforeTime !== undefined) {
        if (deps.offline)
          throw new CliError("validation_error", "reading back from a time asks the messenger; not with --offline")
        if (fromStore(deps)) throw new CliError("validation_error", `${PUSHED}, which pages back from a message only`)
        const connection = await deps.connection()
        return capability(connection, "historyBefore", "read back from a time")(chat, { limit, time: beforeTime })
      }
      if (after !== undefined) {
        if (deps.offline)
          throw new CliError("validation_error", "reading forward asks the messenger; the store pages only backwards")
        if (fromStore(deps)) throw new CliError("validation_error", `${PUSHED}, which pages only backwards`)
        const connection = await deps.connection()
        return capability(connection, "historyAfter", "read forward from a message")(chat, { limit, after })
      }
      const window = { limit, ...(before === undefined ? {} : { before }) }
      if (fromStore(deps)) {
        return inStore(async (store, account) =>
          store.messages(account, await readChatId(deps, chat, store, account), window),
        )
      }
      return capability(await deps.connection(), "history", "read a chat's history")(chat, window)
    },

    around: async (reference, message, window) => {
      const target = messageLinkTarget(reference, message, deps.messenger.provider)
      if (target.account !== undefined) {
        const account = await deps.account()
        if (account.provider !== deps.messenger.provider || target.account !== account.account)
          throw new CliError("validation_error", "that locator belongs to another account; select its profile first")
      }
      if (fromStore(deps)) {
        return inStore(async (store, account) =>
          store.around(account, await readChatId(deps, target.chat, store, account), target.message, window),
        )
      }
      return capability(await deps.connection(), "around", "read the messages around one")(
        target.chat,
        target.message,
        window,
      )
    },

    thread: (reference, message, options) =>
      inStore(async (store, account) => {
        const target = messageLinkTarget(reference, message, deps.messenger.provider)
        if (
          account.provider !== deps.messenger.provider ||
          (target.account !== undefined && target.account !== account.account)
        )
          throw new CliError("validation_error", "that locator belongs to another account; select its profile first")
        return readThreadContext(
          store,
          account,
          await storedChatId(deps.messenger, target.chat, store, account),
          target.message,
          options,
        )
      }),

    comments: async (chat, typedPost, window) => {
      const post = typedPost.trim()
      if (post === "") throw new CliError("validation_error", "which post? give its message id in the channel")
      if (deps.offline)
        throw new CliError("validation_error", "comments are read from the messenger; not with --offline")
      const connection = await deps.connection()
      const discussionOf = capability(connection, "discussionOf", "read comments on a channel post")
      const comments = capability(connection, "comments", "read comments on a channel post")
      const { id: channelId } = await connection.resolve(chat)
      const discussion = await discussionOf(channelId, post)
      return { discussion, ...(await comments(channelId, post, window)) }
    },

    link: async (reference, message) => {
      const target = messageLinkTarget(reference, message, deps.messenger.provider)
      const account = await deps.account()
      if (
        account.provider !== deps.messenger.provider ||
        (target.account !== undefined && target.account !== account.account)
      )
        throw new CliError("validation_error", "that locator belongs to another account; select its profile first")
      if (fromStore(deps)) {
        const store = await deps.store()
        const chat = await readChatId(deps, target.chat, store, account)
        const found = await store.around(account, chat, target.message, { before: 0, after: 0 })
        if (!found.some((item) => item.id === target.message && item.chatId === chat))
          throw new CliError("not_found", "no such message in this account's stored chat")
        return {
          locator: formatLocator({ ...account, chat, message: target.message }),
          url: null,
          access: "unavailable",
          reason: deps.offline ? "offline" : "unsupported_provider",
        }
      }
      const connection = await deps.connection()
      if (connection.self() !== account.account)
        throw new CliError(
          "authentication_error",
          "the connected account differs from the recorded profile; refresh the session before linking",
        )
      const { id: chat } = await connection.resolve(target.chat)
      const locator = formatLocator({ ...account, chat, message: target.message })
      if (connection.permalink)
        return { locator, ...validatePermalink(await connection.permalink(chat, target.message)) }
      const found = await capability(connection, "around", "read a message")(chat, target.message, {
        before: 0,
        after: 0,
      })
      if (!found.some((item) => item.id === target.message && item.chatId === chat))
        throw new CliError("not_found", "no such message in this chat")
      return { locator, url: null, access: "unavailable", reason: "unsupported_provider" }
    },

    download: async (chat, message) =>
      capability(await deps.connection(), "download", "download attachments")(chat, message),

    keepDownloaded: (chat, message, files) =>
      inStore(async (store, account) => {
        const chatId =
          (await storedChatId(deps.messenger, chat, store, account).catch(() => undefined)) ??
          (await (await deps.connection()).resolve(chat)).id
        return store.keepDownloads(account, chatId, message, files)
      }),

    search: (request) => {
      if (request.discover && request.backend === "server")
        throw new CliError("validation_error", "discovery searches the local archive; use backend archive")
      const query: SearchQuery = {
        ...request,
        language: request.language ?? (request.pattern ? "legacy" : "lucene"),
        // Mail is only ever in the local store, and a saved search replays as `search messages`.
        ...(request.kind === "mail" || request.discover ? { backend: "archive" as const } : {}),
      }
      return inStore(async (store, account) => {
        if (query.thread) threadBounds(query.thread)
        const refreshed = await refreshSearch(deps, query)
        // The server step reads the indexes to translate the query, so they are topped up first.
        if (query.backend !== undefined && query.backend !== "archive") await topUp(store)
        const { found, server } = await serverThenStore(store, account, query)
        if (query.kind !== "mail") await remember(store, "search", query)
        return withServer(withRefresh(found, refreshed), server)
      })
    },

    searchAll: (request) =>
      inStore((store, account) => searchAll(store, account, request, deps.messenger, unifiedMessages(store, account))),

    searchAllWithMeetings: (request) =>
      inStore((store, account) =>
        searchAllWithMeetings(store, account, request, deps.messenger, unifiedMessages(store, account)),
      ),

    stats: (request) => {
      const query: SearchQuery & { by: StatsGrouping } = {
        ...request,
        language: request.language ?? (request.pattern ? "legacy" : "lucene"),
      }
      return inStore(async (store, account) => {
        const refreshed = await refreshSearch(deps, query)
        const stats = await statsStore(store, account, query, deps.messenger)
        await remember(store, "stats", query)
        return withRefresh(stats, refreshed)
      })
    },

    send: async ({
      chat,
      text: typed,
      sendId,
      replyTo: typedReplyTo,
      threadId: typedThread,
      silent,
      noPreview,
      markdown,
      html,
      at,
      attachments = [],
      key,
      origin,
      spoiler,
      captionAbove,
      sendAs,
      commentTo,
      sticker,
    }) => {
      if (sticker !== undefined && (typed.trim() !== "" || attachments.length > 0 || markdown || html))
        throw new CliError("validation_error", "a sticker goes alone — no text, no file, no photo")
      if (commentTo !== undefined && (typedReplyTo !== undefined || typedThread !== undefined))
        throw new CliError("validation_error", "a comment answers the post itself; not with --reply-to or --topic")
      const media = { ...(spoiler ? { spoiler } : {}), ...(captionAbove ? { captionAbove } : {}) }
      checkMediaOptions(deps.messenger, Object.keys(media) as MediaOption[], attachments.length)
      const connection = await deps.connection()
      if (at !== undefined && sendId !== undefined) {
        throw new CliError(
          "validation_error",
          "a scheduled send is never repeated: it would be scheduled twice — look in `messages scheduled` instead",
        )
      }
      const prepared = await formatted(connection, typed, { markdown, html })
      const { text, spans } = deps.agentText ? visibleFormattedText(prepared) : prepared
      if (text.trim() === "" && attachments.length === 0 && sticker === undefined) {
        throw new CliError("validation_error", "nothing to send — the marks leave no text")
      }
      const threadId = threadIdOf(typedThread)
      const validate =
        threadId === undefined ? undefined : capability(connection, "validateThread", "send to a forum topic")
      const checkSendAs = sendAsCheck(connection, sendAs)
      const discussionOf =
        commentTo === undefined ? undefined : capability(connection, "discussionOf", "comment on a channel post")
      const { id: resolved } = await connection.resolve(chat)
      const discussion = discussionOf && commentTo !== undefined ? await discussionOf(resolved, commentTo) : undefined
      const chatId = discussion?.chatId ?? resolved
      const replyTo = discussion?.messageId ?? typedReplyTo
      await checkSendAs(chatId)
      const id = sendId ?? connection.newSendId?.() ?? newSendId()
      const attempt = {
        chatId,
        kind: "message" as const,
        sendId: id,
        operationId: id,
        length: text.length,
        ...(replyTo === undefined ? {} : { replyTo }),
        ...(threadId === undefined ? {} : { threadId }),
        ...(sendAs === undefined ? {} : { sendAs }),
        ...(at === undefined ? {} : { scheduledFor: at }),
        ...(key === undefined ? {} : { key }),
        ...(origin === undefined ? {} : { origin }),
        ...(attachments.length === 0
          ? {}
          : { attachments: attachments.map(({ kind, bytes }) => ({ kind, bytes: bytes.byteLength })) }),
      }
      try {
        const done = await guardedWrite(
          guard,
          attempt,
          () =>
            connection.send(chatId, text, {
              sendId: id,
              ...(replyTo === undefined ? {} : { replyTo }),
              ...(threadId === undefined ? {} : { threadId }),
              ...(silent ? { silent } : {}),
              ...(noPreview ? { noPreview } : {}),
              ...(spans.length > 0 ? { formatting: spans } : {}),
              ...(at === undefined ? {} : { at }),
              ...(attachments.length === 0 ? {} : { attachments }),
              ...(sticker === undefined ? {} : { sticker }),
              ...media,
              ...(sendAs === undefined ? {} : { sendAs }),
            }),
          (sent) => ({ messageId: sent.message.id }),
          validate === undefined || threadId === undefined
            ? undefined
            : () => validate(chatId, threadId, { ...(replyTo === undefined ? {} : { replyTo }) }),
        )
        return { ...done, operationId: id }
      } catch (error) {
        if (at !== undefined && codeOf(error) === "outcome_unknown") {
          throw new CliError(
            "outcome_unknown",
            "no answer — the message may have been scheduled. Look in `messages scheduled` before anything else; " +
              "never send it again with --send-id",
            { scheduledFor: at },
          )
        }
        throw error
      }
    },

    edit: async ({ chat, message, text: typed, markdown, html }) => {
      const connection = await deps.connection()
      const edit = capability(connection, "edit", "edit a message")
      const prepared = await formatted(connection, typed, { markdown, html })
      const { text, spans } = deps.agentText ? visibleFormattedText(prepared) : prepared
      if (text.trim() === "") throw new CliError("validation_error", "no new text — the marks leave nothing")
      const { id: chatId } = await connection.resolve(chat)
      const operationId = newOperationId()
      const edited = await guardedWrite(
        guard,
        { operationId, chatId, kind: "edit", messageId: message, length: text.length },
        () => edit(chatId, message, text, spans.length > 0 ? { formatting: spans } : {}),
      )
      return { operationId, message: edited }
    },

    delete: async ({ chat, messages, forEveryone }) => {
      const connection = await deps.connection()
      if (messages.length > DELETE_AT_ONCE) {
        throw new CliError("validation_error", `at most ${DELETE_AT_ONCE} messages at once, got ${messages.length}`)
      }
      const remove = capability(connection, "delete", "delete messages")
      const { id: chatId } = await connection.resolve(chat)
      const operationId = newOperationId()
      await guardedWrite(guard, { operationId, chatId, kind: "delete", count: messages.length, forEveryone }, () =>
        remove(chatId, messages, { forEveryone }),
      )
      return { operationId, chatId, deleted: messages, forEveryone }
    },

    forward: async ({ chat, message, to, silent, sendId, sendAs, threadId: typedThread }) => {
      const connection = await deps.connection()
      const forward = capability(connection, "forward", "forward a message")
      const threadId = threadIdOf(typedThread)
      if (threadId !== undefined && deps.messenger.forwardTopic !== true)
        throw new CliError("validation_error", "this messenger cannot forward to a forum topic")
      const validate =
        threadId === undefined ? undefined : capability(connection, "validateThread", "forward to a forum topic")
      const checkSendAs = sendAsCheck(connection, sendAs)
      const { id: fromChatId } = await connection.resolve(chat)
      const { id: toChatId } = await connection.resolve(to)
      await checkSendAs(toChatId)
      const id = sendId ?? connection.newSendId?.() ?? newSendId()
      const forwarded = await guardedWrite(
        guard,
        {
          operationId: id,
          sendId: id,
          chatId: toChatId,
          kind: "forward",
          ...(threadId === undefined ? {} : { threadId }),
          ...(sendAs === undefined ? {} : { sendAs }),
        },
        () =>
          forward(fromChatId, message, toChatId, {
            sendId: id,
            ...(silent ? { silent } : {}),
            ...(sendAs === undefined ? {} : { sendAs }),
            ...(threadId === undefined ? {} : { threadId }),
          }),
        (done) => ({ messageId: done.id }),
        validate === undefined || threadId === undefined ? undefined : () => validate(toChatId, threadId, {}),
      )
      return { operationId: id, sendId: id, message: forwarded }
    },

    pin: ({ notify, ...target }) => pinning(target, true, notify),
    unpin: (target) => pinning(target, false, false),

    react: async ({ chat, message, emoji }) => {
      const connection = await deps.connection()
      if (emoji === "") throw new CliError("validation_error", "which emoji? give one, for example 👍")
      const react = capability(connection, "react", "react to a message")
      const { id: chatId } = await connection.resolve(chat)
      const operationId = newOperationId()
      await guardedWrite(guard, { operationId, chatId, kind: "reaction", messageId: message }, () =>
        react(chatId, message, emoji),
      )
      return { operationId, chatId, messageId: message, reaction: emoji }
    },
  }
}

const withThreads = async (store: MessageStore, found: SearchFound, request: SearchQuery): Promise<SearchFound> => {
  if (!request.thread) return found
  const items: FoundMessage[] = []
  for (const hit of found.items)
    items.push({
      ...hit,
      thread: await readThreadContext(store, accountOf(hit), hit.chatId, hit.id, {
        before: request.context ?? 0,
        after: request.context ?? 0,
        ...request.thread,
        signal: request.signal,
      }),
    })
  return { ...found, items }
}

const withServer = <T extends SearchFound>(found: T, server?: ServerStep): T =>
  server
    ? {
        ...found,
        server: server.report,
        items: found.items.map((hit) => ({
          ...hit,
          source: server.sources.get(sourceKey(hit.chatId, hit.id)) ?? "archive",
        })),
      }
    : found

export const validateSearchDialect = (request: SearchQuery): void => {
  const { pattern } = request
  if (request.language !== undefined && !["lucene", "legacy"].includes(request.language))
    throw new CliError("validation_error", "--language takes lucene or legacy")
  if (pattern && (request.language === "lucene" || request.ast !== undefined || request.timezone !== undefined))
    throw new CliError("validation_error", "--regex is legacy JavaScript mode; not with Lucene, AST or timezone")
  if (request.language === "legacy" && (request.ast !== undefined || request.timezone !== undefined))
    throw new CliError("validation_error", "AST and timezone require the Lucene language")
  if (pattern && (request.source !== undefined || request.accounts !== undefined || request.senders !== undefined)) {
    throw new CliError(
      "validation_error",
      "--regex reads the account it runs as — not with --source, other accounts or senders",
    )
  }
}

/**
 * `search messages` over a store, from the account given — or from `query.accounts`, which a caller such
 * as a bot's search passes after checking it may read them.
 */
// A large file builds its word index a slice per search as well as in `store migrate` (NEED-453 A).
const topUp = async (store: MessageStore) => {
  const stop = Date.now() + SEARCH_FILL_MS
  await store.fillSearchIndex({ until: () => Date.now() >= stop })
  await store.fillStems({ until: () => Date.now() >= stop })
}

export const searchStore = async (
  store: MessageStore,
  account: AccountKey,
  request: SearchQuery,
  messenger: Saved = {},
): Promise<SearchFound> => {
  const { text, pattern, chat, source, accounts, senders, limit, newest = false, context = 0 } = request
  if (request.signal?.aborted)
    throw new CliError("validation_error", "search was aborted", { reason: "query_aborted", complete: false })
  validateSearchDialect(request)
  if (request.thread) threadBounds(request.thread)
  if (request.discover !== undefined && typeof request.discover !== "boolean")
    throw new CliError("validation_error", "discover takes a boolean")
  if (request.discover && (pattern || request.language === "legacy"))
    throw new CliError("validation_error", "discovery requires Lucene text, without legacy or regex")
  if (request.discover && request.backend === "server")
    throw new CliError("validation_error", "discovery searches the local archive; use backend archive")
  await topUp(store)
  if (request.discover) return withThreads(store, await searchDiscovery(store, account, request, messenger), request)
  if (!pattern && (request.language === "lucene" || request.ast !== undefined))
    return withThreads(store, await searchLucene(store, account, request, messenger), request)
  const found = pattern
    ? {
        ...(await store.find({
          pattern,
          signal: request.signal,
          account,
          limit,
          ...(chat === undefined ? {} : { chatId: await storedChatId(messenger, chat, store, account) }),
        })),
        corrections: [],
        wordsReady: (await store.searchIndexState())?.ready === true,
      }
    : await search(
        store,
        ...(await scopeOf(messenger, store, account, {
          text: text ?? "",
          chat,
          source,
          accounts,
          senders,
          kind: request.kind,
        })),
        { limit, newest },
      )
  const items = await Promise.all(
    found.items.map(async (hit) =>
      context > 0
        ? {
            ...hit,
            context: await store.around(accountOf(hit), hit.chatId, hit.id, { before: context, after: context }),
          }
        : hit,
    ),
  )
  return withThreads(store, { ...found, items, completeness: await completenessOf(store, found.items) }, request)
}

/**
 * The chat a store read is about. Offline, a chat with nothing kept answers empty, as it always has;
 * in store mode the store is the only source, so an empty answer would pass for "nothing was said".
 */
export const readChatId = async (
  deps: ServiceDeps,
  reference: string,
  store: MessageStore,
  account: AccountKey,
): Promise<string> => {
  if (deps.reads !== "store") return storedChatId(deps.messenger, reference, store, account)
  const chatId = await storedChatId(deps.messenger, reference, store, account).catch((error: unknown) => {
    if (codeOf(error) === "not_found") throw new CliError("not_found", nothingStored(deps.messenger))
    throw error
  })
  if ((await store.countMessages(account, chatId)) === 0) {
    throw new CliError("not_found", nothingStored(deps.messenger), { chat: chatId })
  }
  return chatId
}

/** A chat as typed, found among the stored chats the way an adapter finds it among its own. */
export const storedChatId = async (
  messenger: Saved,
  reference: string,
  store: MessageStore,
  account: AccountKey,
): Promise<string> => {
  const trimmed = reference.trim()
  if (messenger.savedChatId && ["me", "self", "saved"].includes(trimmed.toLowerCase())) {
    return messenger.savedChatId(account)
  }
  if (/^-?\d+$/.test(trimmed)) return trimmed
  const chats = (await store.chats(account, {})).items
  const exact = chats.find((one) => one.id === trimmed)
  if (exact) return exact.id
  if (trimmed.startsWith("@")) {
    const username = trimmed.slice(1).toLowerCase()
    const found = chats.find((one) => String(one.providerMetadata?.username ?? "").toLowerCase() === username)
    if (!found) throw new CliError("not_found", `no stored chat is ${trimmed}`)
    return found.id
  }
  return pickChat(trimmed, chats).id
}

const accountOf = (hit: StoredHit): AccountKey => {
  const { provider, account } = parseLocator(hit.locator)
  return { provider, account }
}

const keyOf = ({ provider, account }: AccountKey) => `${provider}/${account}`

/** Each chat's completeness from the account that holds it: a search may span several. */
const completenessOf = async (store: MessageStore, hits: StoredHit[]): Promise<(ChatCompleteness & AccountKey)[]> => {
  const chats = new Map<string, { account: AccountKey; chatIds: Set<Id> }>()
  for (const hit of hits) {
    const account = accountOf(hit)
    const held = chats.get(keyOf(account)) ?? { account, chatIds: new Set() }
    held.chatIds.add(hit.chatId)
    chats.set(keyOf(account), held)
  }
  const found = await Promise.all(
    [...chats.values()].map(async ({ account, chatIds }) =>
      (await store.chatCompleteness(account, [...chatIds])).map((one) => ({ ...one, ...account })),
    ),
  )
  return found.flat()
}

/** Several candidates in different accounts: which messenger each is in says which one was meant. */
const ambiguousAcross = (
  reference: string,
  what: string,
  candidates: { provider: Provider; id: Id; label: string }[],
) => {
  const width = Math.max(...candidates.map(({ provider, id }) => `${provider}  ${id}`.length))
  const lines = candidates.map(({ provider, id, label }) => `  ${`${provider}  ${id}`.padEnd(width)}  ${label}`)
  return new CliError(
    "validation_error",
    `"${singleLine(reference)}" matches ${candidates.length} ${what} in different accounts — ` +
      `name one by its id, or narrow the search with in:<messenger>:\n${lines.join("\n")}`,
    { candidates: candidates.map(({ provider, id }) => ({ provider, id })) },
  )
}

const missing = (error: unknown) => {
  if (codeOf(error) === "not_found") return undefined
  throw error
}

/** A chat as `--chat` names it, in whichever of the accounts holds it — one of them, or it is an error. */
export const chatAmong = async (
  messenger: Saved,
  store: MessageStore,
  accounts: AccountKey[],
  reference: string,
): Promise<{ account: AccountKey; chatId: Id }> => {
  const [only] = accounts
  if (accounts.length === 1 && only)
    return { account: only, chatId: await storedChatId(messenger, reference, store, only) }
  const found = (
    await Promise.all(
      accounts.map(async (account) => {
        const held: Chat[] = (await store.chats(account, {})).items
        const chatId = await storedChatId(messenger, reference, store, account).catch(missing)
        const chat = held.find((one) => one.id === chatId)
        return chat ? [{ account, chat }] : []
      }),
    )
  ).flat()
  const [one] = found
  if (found.length === 1 && one) return { account: one.account, chatId: one.chat.id }
  if (found.length === 0) throw new CliError("not_found", `no stored chat matches "${singleLine(reference)}"`)
  throw ambiguousAcross(
    reference,
    "chats",
    found.map(({ account, chat }) => ({
      provider: account.provider,
      id: chat.id,
      label: singleLine(chat.title ?? ""),
    })),
  )
}

/** A sender, through the names each messenger's accounts have seen; `from:` names one person. */
export const senderAmong = async (store: MessageStore, accounts: AccountKey[], reference: string) => {
  const providers = [...new Set(accounts.map(({ provider }) => provider))]
  const [only] = accounts
  try {
    if (accounts.length === 1 && only) {
      const person = pickPerson(reference, await store.people(only.provider, { account: only.account }))
      return { provider: only.provider, id: person.id }
    }
    const found = (
      await Promise.all(
        providers.map(async (provider) => {
          const ids = accounts.filter((one) => one.provider === provider).map(({ account }) => account)
          const person = await store
            .people(provider, { accounts: ids })
            .then((people) => pickPerson(reference, people))
            .catch(missing)
          return person ? [{ provider, person }] : []
        }),
      )
    ).flat()
    const [one] = found
    if (found.length === 1 && one) return { provider: one.provider, id: one.person.id }
    if (found.length === 0) {
      throw new CliError(
        "not_found",
        isId(reference) ? `no person ${reference} in what these accounts have seen` : `nobody matches "${reference}"`,
      )
    }
    throw ambiguousAcross(
      reference,
      "people",
      found.map(({ provider, person }) => ({ provider, id: person.id, label: singleLine(person.name ?? "") })),
    )
  } catch (error) {
    if (error instanceof CliError && error.code === "not_found") {
      throw new CliError("not_found", `from:${reference} — ${error.message}`)
    }
    throw error
  }
}

/**
 * The parsed query and the scope it names: the account the command runs as, or every account of the
 * messenger `in:` or `--source` names. `chat:` resolves as `--chat` does, `from:` through the names
 * `contacts search` uses, `from:me` as what the accounts sent — all inside the accounts chosen.
 */
export const scopeOf = async (
  messenger: Saved,
  store: MessageStore,
  account: AccountKey,
  {
    text,
    chat,
    source,
    accounts: given,
    senders,
    kind,
  }: Pick<SearchQuery, "chat" | "source" | "accounts" | "senders" | "kind"> & {
    text: string
  },
): Promise<[WordQuery, SearchScope]> => {
  const held = await store.accounts()
  const providers = [...new Set(held.map(({ provider }) => provider))]
  const parsed = parseQuery(text, { providers })
  if (chat !== undefined && parsed.chat !== undefined && parsed.chat !== chat) {
    throw new CliError("validation_error", `--chat and chat: name different chats: "${chat}" and "${parsed.chat}"`)
  }
  const sourced = source === undefined ? undefined : sourceOf("--source", source, providers)
  if (sourced !== undefined && parsed.in !== undefined && sourced !== parsed.in) {
    throw new CliError("validation_error", `--source and in: name different messengers: ${sourced} and ${parsed.in}`)
  }
  const wanted = parsed.in ?? sourced
  if (given !== undefined && wanted !== undefined) {
    throw new CliError("validation_error", "this search reads the accounts it was given — not with in: or --source")
  }
  if (given?.length === 0) throw new CliError("validation_error", "a search names at least one account")
  if (senders !== undefined && parsed.from !== undefined) {
    throw new CliError("validation_error", "--from and from: together — name the people once")
  }
  const accounts = accountsOfKind(
    kind,
    given ??
      (wanted === undefined || held.length === 0
        ? [account]
        : held.filter(({ provider }) => inSource(wanted, provider))),
    held,
    wanted,
    messenger.app?.command,
  )
  const named = parsed.chat ?? chat
  const scope: SearchScope = { accounts }
  if (named !== undefined) scope.chat = await chatAmong(messenger, store, accounts, named)
  if (senders !== undefined) scope.senders = senders
  if (parsed.from?.toLowerCase() === "me") scope.outgoing = true
  else if (parsed.from !== undefined) scope.sender = await senderAmong(store, accounts, parsed.from)
  if (parsed.after !== undefined) scope.after = parsed.after
  if (parsed.before !== undefined) scope.before = parsed.before
  if (parsed.has.length > 0) {
    const held = await store.attachmentKinds()
    const unknown = parsed.has.find((kind) => !["attachment", "link", ...held].includes(kind))
    if (unknown !== undefined) {
      throw new CliError(
        "validation_error",
        `has:${unknown} — the store holds no ${unknown}; it holds ${["attachment", "link", ...held].join(", ")}`,
      )
    }
    scope.has = parsed.has
  }
  return [{ required: parsed.required, excluded: parsed.excluded }, scope]
}

/** What a run is kept as: the query and options it was given — a regular expression as its source. */
const paramsOf = (command: SearchCommand, query: SearchQuery & { by?: StatsGrouping }): SearchParams => ({
  ...(query.pattern
    ? { text: query.pattern.source, regex: true }
    : query.text === undefined
      ? {}
      : { text: query.text }),
  ...(query.ast === undefined ? {} : { ast: query.ast }),
  ...(query.discover === undefined ? {} : { discover: query.discover }),
  ...(query.language === undefined ? {} : { language: query.language }),
  ...(query.chat === undefined ? {} : { chat: query.chat }),
  ...(query.source === undefined ? {} : { source: query.source }),
  ...(query.timezone === undefined ? {} : { timezone: query.timezone }),
  limit: query.limit,
  ...(command === "search"
    ? { newest: query.newest === true, ...(query.context === undefined ? {} : { context: query.context }) }
    : { by: query.by }),
})
const formatted = async (
  connection: MessengerAdapter,
  typed: string,
  { markdown, html }: { markdown?: boolean | undefined; html?: boolean | undefined },
): Promise<FormattedText> => {
  if (markdown && html) throw new CliError("validation_error", "--md and --html mark up the text two ways; use one")
  if (markdown) return validateFormattedText(await capability(connection, "formatMarkdown", "format Markdown")(typed))
  if (html) return validateFormattedText(await capability(connection, "formatHtml", "format HTML")(typed))
  return { text: typed, spans: [] }
}

const MEDIA_FLAGS: Record<MediaOption, string> = {
  spoiler: "--spoiler",
  captionAbove: "--caption-above",
  fileName: "--filename",
}

const checkMediaOptions = (messenger: Messenger, asked: MediaOption[], attachments: number): void => {
  const [first] = asked
  if (first === undefined) return
  const missing = asked.find((one) => !messenger.mediaOptions?.includes(one))
  if (missing) throw new CliError("validation_error", `this messenger has no ${MEDIA_FLAGS[missing]}`)
  if (attachments === 0) throw new CliError("validation_error", `${MEDIA_FLAGS[first]} needs a --photo or --file`)
}
