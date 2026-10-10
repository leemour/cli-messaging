import { CliError } from "@wirecat/cli-core"
import * as v from "valibot"
import type { Messenger } from "../../cli/messenger/context.js"
import { searchNotes } from "../../services/notes-search.js"
import type { SearchedResource } from "../../services/search-all.js"
import { meetingAccountOf, RESOURCES_SEARCHED_WITH_MEETINGS } from "../../services/search-all-meetings.js"
import { searchServices } from "../search-sync.js"
import { type AnyTool, limit, READ, tool } from "../tool.js"
import {
  answerMessagesSearch,
  MESSAGES_SEARCH_DESCRIPTION,
  type MessagesSearchArgs,
  mailSearchInput,
  messagesSearchInput,
} from "./search.js"

const text = v.pipe(v.string(), v.minLength(1), v.description("the query, in the strict Lucene language"))
const exact = v.optional(
  v.pipe(v.boolean(), v.description("bare words and quotes match their exact form only; meaning is not searched")),
)
const timezone = v.optional(v.pipe(v.string(), v.description("the IANA timezone for calendar date boundaries")))

/** One tool per `search` leaf; `search_all` is the one an agent reaches for first. */
export const searchTools = (messenger: Messenger): Record<string, AnyTool> => ({
  search_all: tool({
    title: "Search everything",
    description:
      "Start here to find anything by text: messenger messages, mail and notes held in the local store, merged best " +
      "first. Each item says its kind (message, mail, note), ref (msg:… or note:…), provider and account. A query " +
      "field one kind lacks skips that kind and `skipped` says why; `only` narrows the kinds. With `meetings`, one " +
      "meeting account's transcripts, chat and summaries join in as kind meeting, with meetingId, scope, id and " +
      "startMs instead of a ref, and a null timestamp when the start is unknown; true picks the one stored account " +
      "that holds meetings and refuses when several do. An empty answer means the store does not hold it, not that " +
      "it was never written. Returns { query, items, hasMore, searched, skipped, notes?, meetings? }; hasMore is " +
      "null when a bounded meeting scan could not tell.",
    input: v.object({
      text,
      only: v.optional(
        v.pipe(
          v.array(v.picklist(RESOURCES_SEARCHED_WITH_MEETINGS)),
          v.minLength(1),
          v.description("only these kinds: messages, mail, notes; meetings together with `meetings`"),
        ),
      ),
      meetings: v.optional(
        v.pipe(
          v.union([v.boolean(), v.pipe(v.string(), v.minLength(1))]),
          v.description(
            "also search one meeting account: provider:account, or true for the one stored account that holds meetings",
          ),
        ),
      ),
      exact,
      timezone,
      limit,
    }),
    annotations: { ...READ, openWorldHint: Boolean(messenger.serverSearch) },
    stored: (store, account, args, defaults, connect) => {
      const meetings = args.meetings === false ? undefined : args.meetings
      if (meetings === undefined && args.only?.includes("meetings"))
        throw new CliError("validation_error", "only: meetings needs meetings")
      const meetingAccount = typeof meetings === "string" ? meetingAccountOf(meetings) : undefined
      const services = searchServices(messenger, store, account, defaults, messenger.serverSearch ? connect : undefined)
      const request = {
        text: args.text,
        limit: args.limit ?? defaults.limit,
        ...(args.exact ? { exact: true } : {}),
        ...(args.timezone === undefined ? {} : { timezone: args.timezone }),
        env: defaults.env,
        ...(defaults.signal === undefined ? {} : { signal: defaults.signal }),
      }
      return meetings === undefined
        ? services.messages.searchAll({
            ...request,
            ...(args.only === undefined
              ? {}
              : { only: args.only.filter((one): one is SearchedResource => one !== "meetings") }),
          })
        : services.messages.searchAllWithMeetings({
            ...request,
            ...(args.only === undefined ? {} : { only: args.only }),
            ...(meetingAccount === undefined ? {} : { meetingAccount }),
          })
    },
  }),

  search_messages: tool({
    title: "Search messenger messages",
    description: MESSAGES_SEARCH_DESCRIPTION,
    input: messagesSearchInput(messenger),
    annotations: { ...READ, openWorldHint: Boolean(messenger.serverSearch) },
    stored: (store, account, args, defaults, connect) => {
      const network = args.sync_first || (Boolean(messenger.serverSearch) && args.backend !== "archive")
      const services = searchServices(messenger, store, account, defaults, network ? connect : undefined)
      return answerMessagesSearch(services.messages, args, defaults, services.searches)
    },
  }),

  search_mail: tool({
    title: "Search mail",
    description:
      "Search the mail imported into the local store (memo mail import), in the same query language as " +
      "search_messages; one mail thread is one chat. Returns { items, page, limit, hasMore, completeness, query }.",
    input: mailSearchInput(messenger),
    annotations: { ...READ, openWorldHint: false },
    stored: (store, account, args, defaults) => {
      const services = searchServices(messenger, store, account, defaults)
      return answerMessagesSearch(services.messages, args as MessagesSearchArgs, defaults, undefined, "mail")
    },
  }),

  search_notes: tool({
    title: "Search notes",
    description:
      "Search the notes — written in memo, or imported from a notes folder — by words and, with the local text " +
      "model, by meaning. Each hit says which found it (foundBy) and what it links to; `linked` lists the people, " +
      "entities and notes the hits link most. Returns { query, by, meaningSkipped?, hits, hasMore, nextOffset?, linked }.",
    input: v.object({
      text,
      type: v.optional(
        v.pipe(v.picklist(["internal", "file"]), v.description("internal: written in memo; file: from a notes folder")),
      ),
      folders: v.optional(v.pipe(v.array(v.string()), v.description("only these notes folders, by id"))),
      tag: v.optional(v.pipe(v.string(), v.description("only notes with this tag"))),
      filter: v.optional(v.pipe(v.string(), v.description("a query every hit must also match"))),
      offset: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(1000))),
      exact,
      timezone,
      limit,
    }),
    annotations: { ...READ, openWorldHint: false },
    stored: (store, _account, args, defaults) =>
      searchNotes(store, args.text, {
        limit: args.limit ?? defaults.limit,
        command: messenger.app.command,
        env: defaults.env,
        ...(args.offset === undefined ? {} : { offset: args.offset }),
        ...(args.type === undefined ? {} : { source: args.type }),
        ...(args.folders === undefined ? {} : { folderIds: args.folders }),
        ...(args.tag === undefined ? {} : { tag: args.tag }),
        ...(args.filter === undefined ? {} : { filter: args.filter }),
        ...(args.exact ? { exact: true } : {}),
        ...(args.timezone === undefined ? {} : { timezone: args.timezone }),
      }),
  }),
})
