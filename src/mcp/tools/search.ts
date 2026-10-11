import { CliError } from "@wirecat/cli-core"
import * as v from "valibot"
import type { Messenger } from "../../cli/messenger/context.js"
import { parseDuration } from "../../cli/settings.js"
import type { MessagesService } from "../../services/messages.js"
import type { SearchKind } from "../../services/search-kind.js"
import type { SearchesService, SearchParams } from "../../services/searches.js"
import { syncInputs } from "../search-sync.js"
import { threadArgs, threadInputs } from "../thread-options.js"
import { chatOf, limit } from "../tool.js"

const EXACT = "bare words and quotes match their exact form only, as exact:word does; not with an AST"

export const MESSAGES_SEARCH_DESCRIPTION =
  "Use discover=true for partial lexical evidence and eligible replies to natural questions in the local archive, without model downloads; inspect each hit’s discovery.missingTerms and surrounding messages before answering. Explicit syntax stays strict, and ranking is not answer confidence. Search the local store, and the messenger's server where it can search, using the Lucene 9.12.3 profile, default AND, with strict Boolean matching. Legacy discovery is explicit with language=legacy. Text or a versioned AST, account-scoped filters, calendar timezone, term/body regex and candidate presets use one service. Empty hits still report archive coverage. `saved` runs a saved search (searches_list) or an earlier run (searches_history). With sync_first, first fetch new messages within max_chats (5), sync_time (30s), max_messages (500), under messages.sync-first permission. A failed or bounded refresh keeps local results with stale coverage and refreshed details. thread=true attaches each hit's bounded parent/reply graph, with provenance and stale-edge labels; thread_hops, thread_messages, thread_bytes, thread_within set its separate bounds. Guide: https://github.com/WireCatLabs/cli-messaging/blob/main/docs/search/query-language.md. Text words and quoted phrases match every form of their words (Snowball stems, exact forms ranked first, query.stemming says how); exact:word, or exact=true, matches the exact form only. Without discover=true, where the messenger's server can search, it is also asked by default (backend=both; archive for the local store only) within server_time (5s), under messages.server-search: its hits are saved and re-checked by the same strict query, each hit says its source (archive, server, both), and server says what the server step did. coverage says what the archive held: messages and chats searched, chats never fetched or behind, up to ten attention chats, and next — the command that would improve the answer; when next is set and nothing was found, run it (or ask the owner) before concluding the message does not exist. Returns { items, page, limit, hasMore, corrections, completeness, wordsReady, stemsReady, query, coverage, server? }."

export const backendInputs = {
  backend: v.optional(
    v.pipe(
      v.picklist(["archive", "server", "both"]),
      v.description(
        "both (default), archive, or the messenger's server; server hits are saved and re-checked by the same strict query, each hit says its source; needs messages.server-search",
      ),
    ),
  ),
  server_time: v.optional(
    v.pipe(v.string(), v.description("how long to wait for the server, default 5s, at most 60s")),
  ),
}

export const backendArgs = (args: { backend?: "archive" | "server" | "both"; server_time?: string }) => ({
  ...(args.backend === undefined ? {} : { backend: args.backend }),
  ...(args.server_time === undefined ? {} : { server: { timeMs: parseDuration(args.server_time, "server_time") } }),
})

export const messagesSearchInput = (messenger: Messenger) =>
  v.object({
    // Typed as present so the answer code reads them; offered only where the server can search.
    ...((messenger.serverSearch ? backendInputs : {}) as typeof backendInputs),
    ...threadInputs,
    ...syncInputs,
    text: v.optional(v.pipe(v.string(), v.description("the query: Lucene text or explicit legacy syntax"))),
    ast: v.optional(v.unknown()),
    discover: v.optional(
      v.pipe(
        v.boolean(),
        v.description(
          "partial lexical discovery with eligible replies in the local archive; use for questions when wording is uncertain; hits are evidence, not confirmed answers",
        ),
      ),
    ),
    language: v.optional(v.picklist(["lucene", "legacy"])),
    timezone: v.optional(v.string()),
    chat: v.optional(chatOf(messenger)),
    source: v.optional(
      v.pipe(
        v.string(),
        v.minLength(1),
        v.description("a messenger held on this machine; personal, bots or all — as in: in text"),
      ),
    ),
    type: v.optional(
      v.pipe(
        v.picklist(["text", "voice", "file"]),
        v.description("only messages of this type: text alone, a voice message, or a file"),
      ),
    ),
    newest: v.optional(v.pipe(v.boolean(), v.description("newest first instead of best first"))),
    exact: v.optional(v.pipe(v.boolean(), v.description(EXACT))),
    context: v.optional(
      v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(20), v.description("messages around each hit")),
    ),
    limit,
    saved: v.optional(
      v.pipe(
        v.string(),
        v.minLength(1),
        v.description(
          "run a saved search (name) or an earlier run (id); text is AND-ed to it, other arguments replace its own",
        ),
      ),
    ),
  })

/** `search_mail`: the mailboxes in the local store; no server, no fetching, no saved searches. */
export const mailSearchInput = (messenger: Messenger) =>
  v.object({
    text: v.optional(v.pipe(v.string(), v.description("the query, in the strict Lucene language"))),
    ast: v.optional(v.unknown()),
    timezone: v.optional(v.string()),
    chat: v.optional(chatOf(messenger)),
    newest: v.optional(v.pipe(v.boolean(), v.description("newest first instead of best first"))),
    exact: v.optional(v.pipe(v.boolean(), v.description(EXACT))),
    context: v.optional(
      v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(20), v.description("messages around each hit")),
    ),
    limit,
  })

export const syncArgs = (args: {
  sync_first?: boolean
  max_chats?: number
  sync_time?: string
  max_messages?: number
}) =>
  args.sync_first
    ? {
        syncFirst: {
          ...(args.max_chats === undefined ? {} : { maxChats: args.max_chats }),
          ...(args.sync_time === undefined ? {} : { timeMs: parseDuration(args.sync_time, "sync_time") }),
          ...(args.max_messages === undefined ? {} : { maxMessages: args.max_messages }),
        },
      }
    : {}

export type MessagesSearchArgs = v.InferOutput<ReturnType<typeof messagesSearchInput>>

const typedOf = (args: Record<string, unknown>): SearchParams =>
  Object.fromEntries(
    ["text", "discover", "language", "timezone", "chat", "source", "newest", "exact", "context", "limit", "by"].flatMap(
      (key) => (args[key] === undefined ? [] : [[key, args[key]]]),
    ),
  )

/** `saved` needs the searches service; a host that mounts the tool without it refuses `saved` rather than ignore it. */
const resolveSaved = async (
  searches: Pick<SearchesService, "resolve"> | undefined,
  args: { saved?: string; ast?: unknown } & Record<string, unknown>,
) => {
  if (args.saved === undefined) return undefined
  if (!searches) throw new CliError("validation_error", "saved searches are not available on this server")
  if (args.ast !== undefined) throw new CliError("validation_error", "with saved, give more words as text, not an AST")
  return searches.resolve(args.saved, typedOf(args))
}

const TYPES = { text: "NOT has:attachment", voice: "has:voice", file: "has:file" } as const

const withType = (text: string | undefined, type: keyof typeof TYPES | undefined) =>
  type === undefined ? text : text === undefined ? TYPES[type] : `(${text}) AND ${TYPES[type]}`

export const answerMessagesSearch = async (
  messages: Pick<MessagesService, "search">,
  given: MessagesSearchArgs,
  defaults: { limit: number; signal?: AbortSignal },
  searches?: Pick<SearchesService, "resolve">,
  kind: SearchKind = "messages",
) => {
  if (given.type !== undefined && given.ast !== undefined)
    throw new CliError("validation_error", "type narrows text; an AST names its own fields")
  const text = withType(given.text, given.type)
  const args = { ...given, ...(text === undefined ? {} : { text }) }
  const resolved = await resolveSaved(searches, args)
  if (resolved) {
    const { params, pattern } = resolved
    const size = params.limit ?? defaults.limit
    const found = await messages.search({
      kind,
      ...syncArgs(args),
      ...backendArgs(args),
      ...threadArgs(args),
      ...(pattern ? { pattern } : params.text === undefined ? {} : { text: params.text }),
      ...(params.ast === undefined ? {} : { ast: params.ast }),
      ...(params.discover === undefined ? {} : { discover: params.discover }),
      language: params.language ?? (pattern ? "legacy" : "lucene"),
      signal: defaults.signal,
      ...(params.timezone === undefined ? {} : { timezone: params.timezone }),
      limit: size,
      newest: params.newest === true,
      ...(params.exact ? { exact: true } : {}),
      context: params.context ?? 0,
      ...(params.chat === undefined ? {} : { chat: params.chat }),
      ...(params.source === undefined ? {} : { source: params.source }),
      saved: resolved.id,
    })
    return { ...found, page: 1, limit: size }
  }
  if (args.text === undefined && args.ast === undefined)
    throw new CliError("validation_error", "give search text, a versioned AST, or saved")
  const size = args.limit ?? defaults.limit
  const found = await messages.search({
    kind,
    ...syncArgs(args),
    ...backendArgs(args),
    ...threadArgs(args),
    ...(args.text === undefined ? {} : { text: args.text }),
    ...(args.ast === undefined ? {} : { ast: args.ast }),
    ...(args.discover === undefined ? {} : { discover: args.discover }),
    language: args.language ?? "lucene",
    signal: defaults.signal,
    ...(args.timezone === undefined ? {} : { timezone: args.timezone }),
    limit: size,
    newest: args.newest === true,
    ...(args.exact ? { exact: true } : {}),
    context: args.context ?? 0,
    ...(args.chat === undefined ? {} : { chat: args.chat }),
    ...(args.source === undefined ? {} : { source: args.source }),
  })
  return { ...found, page: 1, limit: size }
}

export const MESSAGES_STATS_DESCRIPTION =
  "Count what a strict Lucene query matches in the local store, by chat, sender, calendar day or hour (in the timezone). Each message is counted once; no text means every stored message. Words match every form, as in search_messages; exact=true counts exact forms only. Counts are lower bounds where coverage is not complete. sync_first optionally refreshes within max_chats, sync_time and max_messages; failed refreshes keep counts with stale coverage and refreshed details. Returns { by, items: [{ key, name, account?, count }], total, hasMore, page, limit, query, coverage, completeness }."

export const messagesStatsInput = (messenger: Messenger) =>
  v.object({
    ...syncInputs,
    text: v.optional(v.pipe(v.string(), v.minLength(1), v.description("a strict Lucene query; omit to count all"))),
    ast: v.optional(v.unknown()),
    exact: v.optional(v.pipe(v.boolean(), v.description(EXACT))),
    by: v.optional(v.picklist(["chat", "sender", "day", "hour"])),
    timezone: v.optional(v.string()),
    chat: v.optional(chatOf(messenger)),
    source: v.optional(
      v.pipe(
        v.string(),
        v.minLength(1),
        v.description("a messenger held on this machine; personal, bots or all — as in: in text"),
      ),
    ),
    limit,
    saved: v.optional(
      v.pipe(
        v.string(),
        v.minLength(1),
        v.description(
          "run a saved search (name) or an earlier run (id); text is AND-ed to it, other arguments replace its own",
        ),
      ),
    ),
  })

export const answerMessagesStats = async (
  messages: Pick<MessagesService, "stats">,
  args: v.InferOutput<ReturnType<typeof messagesStatsInput>>,
  defaults: { limit: number; signal?: AbortSignal },
  searches?: Pick<SearchesService, "resolve">,
) => {
  const resolved = await resolveSaved(searches, args)
  const params: SearchParams = resolved?.params ?? args
  if (params.regex || params.language === "legacy")
    throw new CliError(
      "validation_error",
      "stats messages show counts strict Lucene queries; this saved search is legacy",
    )
  const size = params.limit ?? defaults.limit
  const stats = await messages.stats({
    ...syncArgs(args),
    ...(params.text === undefined ? {} : { text: params.text }),
    ...(params.ast === undefined ? {} : { ast: params.ast }),
    by: params.by ?? "chat",
    language: "lucene",
    ...(params.exact ? { exact: true } : {}),
    signal: defaults.signal,
    ...(params.timezone === undefined ? {} : { timezone: params.timezone }),
    limit: size,
    ...(params.chat === undefined ? {} : { chat: params.chat }),
    ...(params.source === undefined ? {} : { source: params.source }),
    ...(resolved ? { saved: resolved.id } : {}),
  })
  return { ...stats, page: 1, limit: size }
}
