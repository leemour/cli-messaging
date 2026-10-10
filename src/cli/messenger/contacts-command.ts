import { CliError } from "@wirecat/cli-core"
import { Command } from "commander"
import { REGISTRIES, registriesCover } from "../../botcheck/registries.js"
import { levelFor } from "../../sends/permissions.js"
import { phoneOf } from "../../services/index.js"
import { momentOf } from "../../services/moment.js"
import { maskedAccount } from "../../services/people.js"
import { CHAT_MESSAGES, CONTEXT_BYTES, CONTEXT_MESSAGES } from "../../services/person-context.js"
import { SCOPES, type Scope, TIMELINE_ITEMS } from "../../services/person-timeline.js"
import { readSecret } from "../../terminal/prompt.js"
import { positiveCount, renderPage, window, withPaging } from "../paging.js"
import { casKey } from "../registry-keys.js"
import { contactWriteCommands } from "./admin-contacts-command.js"
import { type Messenger, messengerContext } from "./context.js"
import { privatePeopleCommands } from "./private-people-command.js"

/** People this account has a one-to-one chat with, as the people service counts them. */
const collect = (value: string, previous: string[] = []) => [...previous, value]

export const contactsCommand = (messenger: Messenger): Command => {
  const contacts = new Command("contacts").description("people this account has a one-to-one chat with")

  contacts.addCommand(
    withPaging(new Command("list").description("people you have a one-to-one chat with"))
      .option("--order <recent|name>", "newest conversation first, or alphabetical", "recent")
      .option("--search <text>", "only people whose name, local alias or @username contains this")
      .option("--search-notes <text>", "only people whose private notes contain this text")
      .action(async function (this: Command) {
        const { order, search, searchNotes } = this.opts<{ order: string; search?: string; searchNotes?: string }>()
        if (order !== "recent" && order !== "name") {
          throw new CliError("validation_error", `--order is recent or name, not "${order}"`)
        }
        const context = messengerContext(this, messenger)
        const found = await context.withServices((services) =>
          services.people.list({
            order,
            ...(search ? { search } : {}),
            ...(searchNotes === undefined ? {} : { notesSearch: searchNotes }),
            ...window(context.settings),
          }),
        )
        renderPage(context, found)
      }),
  )

  contacts
    .command("show")
    .description("one person and the chats you share with them")
    .argument("<person>", "their id, @username, or part of their name")
    .option("--with-notes", "include your private notes, subject to contacts.notes.list permission")
    .action(async function (this: Command, person: string) {
      const context = messengerContext(this, messenger)
      const { withNotes } = this.opts<{ withNotes?: boolean }>()
      if (withNotes && levelFor(context.settings.permissions, "contacts.notes.list").level === "deny")
        throw new CliError("permission_error", "profile denies contacts.notes.list")
      context.renderer.result(
        await context.withServices((services) => services.people.show(person, { notes: withNotes })),
      )
    })

  contacts
    .command("profile")
    .description(
      "everything the messenger says about one person — handles, flags, last seen, when they registered — and " +
        "how many of their messages the store holds in each chat you share, the first and the last, and the " +
        "earlier names and usernames the store saw them with",
    )
    .argument("<person>", "their id, @username, or part of their name")
    .option("--show-phone", "print the whole phone number")
    .action(async function (this: Command, person: string) {
      const whole = this.opts<{ showPhone?: boolean }>().showPhone === true
      const context = messengerContext(this, messenger)
      const found = await context.withServices((services) => services.people.profile(person))
      if (found.chats.some(({ complete }) => !complete)) {
        context.renderer.note("a count is a floor where the chat is not stored whole (`complete: false`)")
      }
      context.renderer.result(whole ? found : maskedAccount(found))
    })

  contacts
    .command("context")
    .description(
      "what the store holds about one person, in every messenger linked to them: shared chats, the last " +
        "messages each way, their recent messages, where others mentioned them — never connects",
    )
    .argument("<person>", "their id, @username, or part of their name")
    .option(
      "--limit <n>",
      `at most this many messages in each list; ${CONTEXT_MESSAGES} if not given`,
      positiveCount("--limit"),
    )
    .option("--since-time <time>", "nothing older than this ISO 8601 time, or 2h / 1d ago")
    .option(
      "--chat <chat>",
      `a chat, by id or name; repeat it for more — then their newest messages in each, ${CHAT_MESSAGES} unless --limit, short unless -v`,
      collect,
    )
    .option("--refresh", "with --chat, read their newest messages in each from the messenger first")
    .action(async function (this: Command, person: string) {
      const { limit, sinceTime, chat, refresh } = this.opts<{
        limit?: number
        sinceTime?: string
        chat?: string[]
        refresh?: boolean
      }>()
      const context = messengerContext(this, messenger)
      if (chat === undefined) {
        if (refresh) throw new CliError("validation_error", "--refresh reads the chats named with --chat")
      } else {
        if (sinceTime !== undefined) throw new CliError("validation_error", "--since-time is not used with --chat")
        const found = await context.withServices((services) =>
          services.people.messagesIn(person, {
            chats: chat,
            ...(limit === undefined ? {} : { limit }),
            detail: context.settings.detail,
            fetch: refresh === true,
          }),
        )
        for (const one of found.chats) {
          if (!one.complete)
            context.renderer.note(
              `${one.chat.title ?? one.chat.id}: not stored whole, so older messages of theirs may be missing — ` +
                `\`${messenger.app.command} store fetch ${one.chat.id}\``,
            )
        }
        context.renderer.result(found)
        return
      }
      const found = await context.withServices((services) =>
        services.people.context(person, {
          messages: limit ?? CONTEXT_MESSAGES,
          bytes: CONTEXT_BYTES,
          ...(sinceTime === undefined ? {} : { since: momentOf(sinceTime, "--since-time") }),
        }),
      )
      for (const chat of found.notRead) {
        context.renderer.note(
          `${chat.title ?? chat.chatId}: ${chat.reason === "not_fetched" ? "nothing" : "only part"} of it is stored — ` +
            `\`${messenger.app.command} store fetch ${chat.chatId}\``,
        )
      }
      if (found.hasMore) context.renderer.note("cut at --limit; a larger one shows more")
      context.renderer.result(found)
    })

  contacts
    .command("timeline")
    .description(
      "everything one person took part in, in every messenger linked to them — messages they wrote or were " +
        "mentioned in, chats, mail, meetings, tasks — newest first, from the store; never connects",
    )
    .argument("<person>", "their id, @username, or part of their name")
    .option("--scope <personal|work>", "only what belongs to personal or to work accounts")
    .option("--since-time <time>", "nothing older than this ISO 8601 time, or 2h / 1d ago")
    .option("--until-time <time>", "through this ISO 8601 time, or 2h / 1d ago")
    .option("--limit <n>", `at most this many; ${TIMELINE_ITEMS} if not given`, positiveCount("--limit"))
    .action(async function (this: Command, person: string) {
      const { scope, sinceTime, untilTime, limit } = this.opts<{
        scope?: string
        sinceTime?: string
        untilTime?: string
        limit?: number
      }>()
      if (scope !== undefined && !(SCOPES as readonly string[]).includes(scope))
        throw new CliError("validation_error", `--scope is personal or work, not "${scope}"`)
      const context = messengerContext(this, messenger)
      const found = await context.withServices((services) =>
        services.people.timeline(person, {
          ...(scope === undefined ? {} : { scope: scope as Scope }),
          ...(sinceTime === undefined ? {} : { since: momentOf(sinceTime, "--since-time") }),
          ...(untilTime === undefined ? {} : { until: momentOf(untilTime, "--until-time") }),
          ...(limit === undefined ? {} : { limit }),
        }),
      )
      if (found.hasMore) context.renderer.note("cut at --limit; a larger one or a narrower time range shows more")
      context.renderer.result(found)
    })

  contacts
    .command("check")
    .description(
      registriesCover(messenger.provider)
        ? "whether one person looks like a bot, a fake or a spammer: their profile, what they wrote in the store, " +
            `and the public ban lists (${Object.values(REGISTRIES)
              .map(({ title }) => title)
              .join(", ")}), which are sent their id — a hint, never a verdict`
        : "whether one person looks like a bot, a fake or a spammer: their profile and what they wrote in the " +
            "store — a hint, never a verdict; the public ban lists cover Telegram only, so nothing is sent",
    )
    .argument("<person>", "their id, @username, or part of their name")
    .option("--no-registries", "do not ask the public ban lists; nothing about them leaves this machine")
    .action(async function (this: Command, person: string) {
      const { registries } = this.opts<{ registries: boolean }>()
      const context = messengerContext(this, messenger)
      const key = registries ? casKey(messenger.app, context.env) : undefined
      const checked = await context.withServices((services) =>
        services.botcheck.person(person, { registries, ...(key ? { registry: { casKey: key } } : {}) }),
      )
      for (const note of checked.notes) context.renderer.note(note)
      for (const { name, answer, detail } of checked.registries) {
        if (answer === "unknown") context.renderer.note(`${name}: not known — ${detail ?? "no answer"}`)
      }
      if (checked.unknown.length > 0)
        context.renderer.note(`not judged, nothing to judge by: ${checked.unknown.join(", ")}`)
      const { notes: _, ...answer } = checked
      context.renderer.result(answer)
    })

  contacts
    .command("link")
    .description("record that two people in the store are one person — the same name is never enough")
    .argument("<person>", "their id, @username, or part of their name")
    .argument("<other>", "the same in another messenger of the store, as <messenger>:<person> — max:Ana")
    .action(async function (this: Command, person: string, other: string) {
      const context = messengerContext(this, messenger)
      const linked = await context.withServices((services) => services.people.link(person, other))
      context.renderer.result(linked)
      context.renderer.success(`${linked.identities.length} identities are now one person`)
    })

  contacts
    .command("unlink")
    .description("undo contacts link for one identity: it is a person of its own again")
    .argument("<person>", "their id, @username, or part of their name; <messenger>:<person> for another messenger")
    .action(async function (this: Command, person: string) {
      const context = messengerContext(this, messenger)
      context.renderer.result(await context.withServices((services) => services.people.unlink(person)))
    })

  /**
   * ⚠ **The number is asked for or piped, never an argument**: argv is read by `ps` and kept by shell
   * history, and a phone number is personal data.
   */
  contacts
    .command("lookup")
    .description("who has this phone number — asks for it, or reads it from stdin; never an argument")
    // Commander's own refusal would repeat the number on stderr.
    .allowExcessArguments()
    .action(async function (this: Command) {
      if (this.args.length > 0) {
        throw new CliError(
          "validation_error",
          "the phone number is never an argument — pipe it in, or type it when asked",
        )
      }
      const context = messengerContext(this, messenger)
      const phone = phoneOf(await readSecret("phone number: ", { input: context.stdin, echo: true }))
      context.renderer.result(await context.withServices((services) => services.people.lookup(phone)))
    })

  contacts
    .command("sync")
    .description("take the whole contact list from the messenger into the local store")
    .action(async function (this: Command) {
      const context = messengerContext(this, messenger)
      const summary = await context.withServices((services) => services.people.sync())
      context.renderer.result(summary)
      context.renderer.success(`${summary.added} new, ${summary.changed} changed, ${summary.known} people known`)
    })

  for (const command of privatePeopleCommands(messenger)) contacts.addCommand(command)
  for (const command of contactWriteCommands(messenger)) contacts.addCommand(command)
  return contacts
}
