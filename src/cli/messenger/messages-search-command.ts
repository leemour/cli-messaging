import { CliError } from "@wirecat/cli-core"
import { Command } from "commander"
import { parseLocator } from "../../domain/locator.js"
import { renderMessages } from "../../render/messages.js"
import { renderThreadLinks } from "../../render/thread-context.js"
import type { SearchFound } from "../../services/messages.js"
import { NO_MAIL, type SearchKind } from "../../services/search-kind.js"
import { environmentOf } from "../context.js"
import { positiveCount } from "../paging.js"
import { archiveSummary } from "./archive-summary.js"
import { type Messenger, messengerContext } from "./context.js"
import { backendOptions, backendRequest, noteServer } from "./search-backend-options.js"
import { syncOptions, syncRequest } from "./search-sync-options.js"
import { threadOptions, threadRequest } from "./thread-options.js"

const TYPES = { text: "NOT has:attachment", voice: "has:voice", file: "has:file" } as const
type MessageType = keyof typeof TYPES

const typeOf = (value: string): MessageType => {
  if (!Object.hasOwn(TYPES, value)) throw new CliError("validation_error", "--type takes text, voice or file")
  return value as MessageType
}

/** `search messages`, or with `mail` the same leaf over the mailboxes only — never both, so they do not overlap. */
export const messagesSearchCommand = (messenger: Messenger, kind: SearchKind = "messages"): Command => {
  const mail = kind === "mail"
  const base = new Command(kind)
  const command = mail ? base : backendOptions(threadOptions(syncOptions(base)), messenger)
  command
    .description(
      mail
        ? "search the mail imported into the local store — memo mail import brings it in"
        : messenger.serverSearch
          ? "search messenger messages in the local store and on the messenger's server (--backend); optionally fetches new messages with --sync-first; --discover searches the archive only"
          : "search messenger messages in the local store — what was read, fetched or kept by serve; optionally fetches new messages with --sync-first; --discover searches the archive only",
    )
    .argument(
      "[query...]",
      mail
        ? 'strict Lucene query: words, "phrases", AND/OR/NOT, field groups and date ranges'
        : 'strict Lucene query: words, "phrases", AND/OR/NOT, field groups and date ranges; --language legacy keeps discovery; with --saved, more words AND-ed to it',
    )
    .option(
      "--chat <chat>",
      mail
        ? "only this mail thread, by id or subject"
        : `only this chat — the same as chat: in the query; ${messenger.chatArgument}`,
    )
  if (mail)
    command.option("--account <address>", "only this mail account, by its address; every mail account when unset")
  else
    command
      .option(
        "--source <messenger>",
        "every account of this messenger held in the store; personal, bots or all — the same as in: in the query",
      )
      .option("--type <text|voice|file>", "only messages of this type: text alone, a voice message, or a file", typeOf)
  command
    .option("--limit <n>", "how many", positiveCount("--limit"))
    .option("--newest", "newest first instead of best first")
    .option(
      "--exact",
      "bare words and quotes match their exact form only, as exact:word does; text: still matches every form",
    )
    .option("--context <n>", "messages before and after each hit; 2 in the terminal, 0 otherwise", wholeCount)
  if (!mail) {
    command.option(
      "--discover",
      "find partial lexical matches and eligible replies in the local archive; results are evidence, not confirmed answers",
    )
    command.option("--language <lucene|legacy>", "the query language: strict Lucene or legacy discovery", languageOf)
  }
  command.option("--timezone <zone>", "the IANA timezone for calendar date boundaries")
  if (mail) return command.action(searchAction(messenger, kind))
  return command
    .addHelpText(
      "after",
      `Search reads the local archive: a chat never fetched is not searched. Prepare it once with
\`${messenger.app.command} store fetch --all --background\` (the last 90 days of every chat); the answer's
coverage says what was searched and coverage.next what would improve it. Mail is \`${messenger.app.command} search mail\`;
everything at once is \`${messenger.app.command} search all\`.
Search guide: https://github.com/WireCatLabs/cli-messaging/blob/main/docs/search/query-language.md`,
    )
    .option("--regex", "the words are one regular expression, case-insensitive, tested against every stored text")
    .option("--saved <name|id>", "run a saved search or an earlier run; options typed here replace its own")
    .action(searchAction(messenger, kind))
}

const searchAction = (messenger: Messenger, kind: SearchKind) =>
  async function (this: Command, given: string[]) {
    const context = messengerContext(this, messenger)
    const type = this.opts<{ type?: MessageType }>().type
    const words =
      type === undefined ? given : given.length === 0 ? [TYPES[type]] : [`(${given.join(" ")}) AND ${TYPES[type]}`]
    const {
      chat,
      account,
      source,
      regex,
      language,
      discover,
      timezone,
      newest,
      exact,
      context: around,
      limit: typedLimit,
      saved,
    } = this.opts<{
      chat?: string
      account?: string
      source?: string
      regex?: boolean
      discover?: boolean
      language?: "lucene" | "legacy"
      timezone?: string
      newest?: boolean
      exact?: boolean
      context?: number
      limit?: number
      saved?: string
    }>()
    if (saved === undefined && words.length === 0)
      throw new CliError("validation_error", "give a query, or --saved <name> to run a saved search")
    if (saved !== undefined && regex)
      throw new CliError("validation_error", "--regex is kept with the saved search; not with --saved")
    const controller = new AbortController()
    context.track({ close: async () => controller.abort() })
    const external = environmentOf(this).signal
    const signal = external ? AbortSignal.any([external, controller.signal]) : controller.signal
    const typed = {
      ...(chat === undefined ? {} : { chat }),
      ...(source === undefined ? {} : { source }),
      ...(account === undefined ? {} : { mailAccount: account }),
      ...(discover === undefined ? {} : { discover }),
      ...(language === undefined ? {} : { language }),
      ...(timezone === undefined ? {} : { timezone }),
      ...(newest ? { newest: true } : {}),
      ...(exact ? { exact: true } : {}),
      ...(around === undefined ? {} : { context: around }),
      ...(typedLimit === undefined ? {} : { limit: typedLimit }),
    }
    let limit = context.settings.limit
    const found: SearchFound = await context
      .withServices(async (services) => {
        if (saved === undefined) {
          const pattern = regex ? patternOf(words.join(" ")) : undefined
          return services.messages.search({
            kind,
            ...syncRequest(this, context),
            ...backendRequest(this),
            ...threadRequest(this),
            ...typed,
            ...(pattern ? { pattern } : { text: words.join(" ") }),
            limit,
            signal,
            language: language ?? (pattern ? "legacy" : "lucene"),
            newest: newest === true,
            context: around ?? (context.format === "pretty" ? 2 : 0),
          })
        }
        const { id, params, pattern } = await services.searches.resolve(saved, { ...typed, text: words.join(" ") })
        limit = params.limit ?? limit
        return services.messages.search({
          kind,
          ...syncRequest(this, context),
          ...backendRequest(this),
          ...threadRequest(this),
          ...(pattern ? { pattern } : params.text === undefined ? {} : { text: params.text }),
          ...(params.ast === undefined ? {} : { ast: params.ast }),
          ...(params.chat === undefined ? {} : { chat: params.chat }),
          ...(params.source === undefined ? {} : { source: params.source }),
          ...(params.timezone === undefined ? {} : { timezone: params.timezone }),
          limit,
          signal,
          language: params.language ?? (pattern ? "legacy" : "lucene"),
          newest: params.newest === true,
          ...(params.discover === undefined ? {} : { discover: params.discover }),
          ...(params.exact ? { exact: true } : {}),
          context: params.context ?? (context.format === "pretty" ? 2 : 0),
          saved: id,
        })
      })
      .catch((error: unknown) => {
        // Nothing to search is an empty answer, as `search all` treats it, not a failure.
        if (!(error instanceof CliError && error.details.reason === NO_MAIL)) throw error
        context.renderer.note(error.message)
        return { items: [], hasMore: false, corrections: [], completeness: [], wordsReady: true }
      })
    for (const hit of found.items) {
      if (hit.thread?.fallback) context.renderer.note(`thread context uses time neighbours: ${hit.thread.fallback}`)
      if (hit.thread?.stale) context.renderer.note("thread graph may be stale; stale links were not followed")
      if (hit.thread?.stopped.length) context.renderer.note(`thread context stopped: ${hit.thread.stopped.join(", ")}`)
    }
    noteServer(context, found.server)
    const { command } = messenger.app
    for (const { from, to } of found.corrections) context.renderer.note(`${from} → ${to.join(", ")}`)
    const stemming = found.query?.stemming
    const forms = (stemming?.applied ? stemming.terms : []).filter(({ stemmer }) => stemmer !== "none")
    if (forms.length > 0)
      context.renderer.note(
        `also found other forms: ${forms.map(({ word, stem, stemmer }) => `${word} → ${stem}* (${stemmer})`).join(", ")} — --exact for the exact words only`,
      )
    if (stemming?.applied === false)
      context.renderer.note(
        stemming.reason === "building"
          ? `other forms of words are not searched yet: the stems are ${Math.floor((stemming.done / Math.max(stemming.total, 1)) * 100)}% built — \`${command} store migrate\` finishes them`
          : "other forms of words are not searched: the store asks for stemmers this tool does not know — upgrade this tool",
      )
    if (!found.wordsReady) {
      context.renderer.note(
        found.query
          ? `the word index is still being built, so a search by words fails until \`${command} store migrate\` finishes it`
          : `the word index is still being built, so a search by words reads pieces of words until \`${command} store migrate\` finishes it`,
      )
    }
    const incomplete = found.completeness.filter((chat) => chat.state !== "complete")
    const chats = incomplete.filter((chat) => chat.provider !== "email").length
    const summary = found.coverage ? archiveSummary(found.coverage, found.items.length) : undefined
    if (summary) context.renderer.note(summary)
    else if (!found.coverage && chats > 0) {
      context.renderer.note(
        `${chats} of the chats searched are not held in full — \`${command} store fetch <chat>\` fetches one`,
      )
    }
    if (incomplete.some((chat) => chat.provider === "email")) {
      context.renderer.note(
        "mail search covers imported messages only; older or unimported mail may be missing — `memo mail import --since <date>` imports more",
      )
    }
    if (context.format === "pretty") {
      const options = {
        color: context.color,
        verbosity: context.settings.detail,
        senderColors: context.settings.senderColors,
        profile: context.profile,
        provider: messenger.provider,
        locale: messenger.app.locale,
      }
      const hits = found.items.map((hit) => ({ hit, at: parseLocator(hit.locator) }))
      const spans = new Set(hits.map(({ at }) => `${at.provider}/${at.account}`)).size > 1
      context.streams.data(
        hits
          .map(({ hit, at }) => {
            const title = hit.chatTitle ?? hit.chatId
            const links = hit.thread ? renderThreadLinks(hit.thread) : ""
            return `${spans ? `${at.provider} · ${title}` : title}  ${hit.locator}\n${renderMessages(hit.thread?.items ?? hit.context ?? [hit], options)}${links ? `\n${links}` : ""}`
          })
          .join("\n\n"),
      )
      const elsewhere = [...new Set(hits.map(({ at }) => at.provider))].filter((one) => one !== messenger.provider)
      if (elsewhere.length > 0) {
        context.renderer.note(
          `hits in ${elsewhere.join(", ")} open in that messenger's own CLI, by the locator: messages context msg:…`,
        )
      }
      if (found.items.length === 0)
        context.renderer.note(
          found.server && !found.server.skipped
            ? "nothing found in the local store or on the messenger's server"
            : "nothing found — only what is in the local store is searched",
        )
      return
    }
    if (context.format === "jsonl") context.renderer.stream(found.items)
    else context.renderer.result({ ...found, page: 1, limit })
  }

const patternOf = (source: string): RegExp => {
  try {
    return new RegExp(source, "iu")
  } catch {
    throw new CliError("validation_error", "not a regular expression — check JavaScript syntax or use Lucene regex")
  }
}

export const wholeCount = (value: string): number => {
  if (!/^\d+$/.test(value.trim())) {
    throw new CliError("validation_error", `--context takes a whole number from 0 upwards, not "${value}"`)
  }
  return Number(value)
}

export const languageOf = (value: string): "lucene" | "legacy" => {
  if (value !== "lucene" && value !== "legacy")
    throw new CliError("validation_error", "--language takes lucene or legacy")
  return value
}
