import { CliError } from "@wirecat/cli-core"
import type { Messenger } from "../cli/messenger/context.js"
import { parseLocator } from "../domain/locator.js"
import type { AccountKey, MessageStore } from "../store/store.js"
import { type SearchFound, type SearchQuery, searchStore } from "./messages.js"
import { RRF_K, searchNotes } from "./notes-search.js"
import type { Backend, ServerOptions, ServerSearched } from "./server-search.js"

export const RESOURCES_SEARCHED = ["messages", "mail", "notes"] as const
export type SearchedResource = (typeof RESOURCES_SEARCHED)[number]

export interface SearchAllItem {
  kind: "message" | "mail" | "note"
  /** `msg:…` for a message or a mail, `note:…` for a note. */
  ref: string
  provider: string
  /** The account it was found in; a note's folder id, or `internal` for a note written in memo. */
  account: string
  /** The chat, the mail thread's subject or the note's title. */
  title: string | null
  timestamp: string
  text: string
}

export interface SearchAllFound {
  query: string
  items: SearchAllItem[]
  hasMore: boolean
  searched: SearchedResource[]
  /** A resource the query could not be asked of, and why: a field it lacks, or nothing stored yet. */
  skipped: { resource: SearchedResource; reason: string }[]
  /** How the notes were searched, when they were. */
  notes?: { by: "words" | "words and meaning"; meaningSkipped?: string }
  /** The messenger's server step for messages, as `search messages` reports it. */
  server?: ServerSearched
}

export interface SearchAllRequest {
  text: string
  limit: number
  only?: readonly SearchedResource[]
  exact?: boolean
  timezone?: string
  /** For messages only; mail and notes are always the local store's. */
  backend?: Backend
  server?: ServerOptions
  env?: NodeJS.ProcessEnv
  signal?: AbortSignal
}

const MAX_TEXT = 2000

/** A query a resource cannot answer is skipped with its reason, never a failure of the whole search. */
const skippable = (error: unknown): error is CliError =>
  error instanceof CliError && (error.code === "validation_error" || error.code === "not_found")

/**
 * `search all`: messages, mail and notes from the local store — messages also from the messenger's
 * server, as `search messages` asks it — each list best first, merged by reciprocal rank so no
 * resource's own scores have to be compared with another's.
 */
export const searchAll = async (
  store: MessageStore,
  account: AccountKey,
  request: SearchAllRequest,
  messenger: Partial<Pick<Messenger, "savedChatId" | "app">> = {},
  searchMessages: (query: SearchQuery) => Promise<SearchFound> = (query) =>
    searchStore(store, account, query, messenger),
): Promise<SearchAllFound> => {
  if (!request.text.trim()) throw new CliError("validation_error", "say what to find")
  const only = request.only ?? RESOURCES_SEARCHED
  const command = messenger.app?.command ?? "tg"
  const lists: SearchAllItem[][] = []
  const searched: SearchedResource[] = []
  const skipped: SearchAllFound["skipped"] = []
  let hasMore = false
  let notes: SearchAllFound["notes"]
  let server: ServerSearched | undefined

  const messagesOf = async (kind: "messages" | "mail") => {
    const query: SearchQuery = {
      text: request.text,
      language: "lucene",
      kind,
      ...(kind === "messages"
        ? {
            // Server hits are matched by chat and message id, which another account can share.
            ...(request.backend === "server" ? {} : { source: "all" }),
            ...(request.backend === undefined ? {} : { backend: request.backend }),
            ...(request.server === undefined ? {} : { server: request.server }),
          }
        : {}),
      limit: request.limit,
      ...(request.exact ? { exact: true } : {}),
      ...(request.timezone === undefined ? {} : { timezone: request.timezone }),
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    }
    // Messages go the way `search messages` goes, server included, so `search all` finds whatever it finds.
    const found =
      kind === "messages" ? await searchMessages(query) : await searchStore(store, account, query, messenger)
    if (found.server) server = found.server
    hasMore ||= found.hasMore
    return found.items.map((hit): SearchAllItem => {
      const at = parseLocator(hit.locator)
      return {
        kind: kind === "mail" ? "mail" : "message",
        ref: hit.locator,
        provider: at.provider,
        account: at.account,
        title: hit.chatTitle,
        timestamp: hit.timestamp,
        text: (hit.text ?? "").slice(0, MAX_TEXT),
      }
    })
  }

  for (const resource of only) {
    try {
      if (resource === "notes") {
        const found = await searchNotes(store, request.text, {
          limit: request.limit,
          command,
          ...(request.exact ? { exact: true } : {}),
          ...(request.timezone === undefined ? {} : { timezone: request.timezone }),
          ...(request.env === undefined ? {} : { env: request.env }),
        })
        hasMore ||= found.hasMore
        notes = {
          by: found.by,
          ...(found.meaningSkipped === undefined ? {} : { meaningSkipped: found.meaningSkipped }),
        }
        lists.push(
          found.hits.map((hit) => ({
            kind: "note",
            ref: hit.ref,
            provider: "notes",
            account: hit.folderId ?? "internal",
            title: hit.title,
            timestamp: hit.modifiedAt,
            text: hit.line,
          })),
        )
      } else lists.push(await messagesOf(resource))
      searched.push(resource)
    } catch (error) {
      if (!skippable(error)) throw error
      skipped.push({ resource, reason: error.message })
    }
  }

  const ranked = new Map<string, { item: SearchAllItem; score: number }>()
  for (const list of lists)
    list.forEach((item, rank) => {
      const held = ranked.get(item.ref) ?? { item, score: 0 }
      held.score += 1 / (RRF_K + rank + 1)
      ranked.set(item.ref, held)
    })
  const ordered = [...ranked.values()].sort((a, b) => b.score - a.score).map(({ item }) => item)
  return {
    query: request.text,
    items: ordered.slice(0, request.limit),
    hasMore: hasMore || ordered.length > request.limit,
    searched,
    skipped,
    ...(notes === undefined ? {} : { notes }),
    ...(server === undefined ? {} : { server }),
  }
}
