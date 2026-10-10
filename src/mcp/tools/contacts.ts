import { CliError } from "@wirecat/cli-core"
import * as v from "valibot"
import { REGISTRIES, registriesCover } from "../../botcheck/registries.js"
import type { Messenger } from "../../cli/messenger/context.js"
import type { MessengerAdapter } from "../../cli/messenger/port.js"
import { casKey } from "../../cli/registry-keys.js"
import type { SendGuard } from "../../sends/guard.js"
import { levelFor } from "../../sends/permissions.js"
import { onlineDeps, phoneOf, servicesFor, storedDeps } from "../../services/index.js"
import { momentOf } from "../../services/moment.js"
import { maskedAccount } from "../../services/people.js"
import { CONTEXT_BYTES, CONTEXT_MESSAGES } from "../../services/person-context.js"
import { SCOPES, TIMELINE_ITEMS } from "../../services/person-timeline.js"
import { type AnyTool, envelope, limit, page, paging, READ, tool } from "../tool.js"

export const contactsTools = (messenger: Messenger): Record<string, AnyTool> => {
  const people = (adapter: MessengerAdapter, guard: SendGuard) =>
    servicesFor(onlineDeps(messenger, adapter, guard)).people
  return {
    contacts_list: tool({
      title: "List contacts",
      description: "People the owner has a one-to-one chat with. Returns { items, page, limit, hasMore }.",
      input: v.object({
        search: v.optional(v.pipe(v.string(), v.minLength(1), v.description("only people whose name contains this"))),
        order: v.optional(v.picklist(["recent", "name"])),
        limit,
        page,
      }),
      annotations: READ,
      served: async (services, { search, order, ...rest }, defaults) => {
        const { size, number, window } = paging(rest, defaults)
        const found = await services.people.list({
          order: order ?? "recent",
          ...(search ? { search } : {}),
          ...window,
        })
        return envelope(found, number, size)
      },
    }),

    contacts_lookup: tool({
      title: "Find a person by phone",
      description:
        "Who has this phone number, where their privacy lets the owner find them: { id, name, username }. " +
        "not_found otherwise. Nothing is added to the owner's contacts.",
      input: v.object({ phone: v.pipe(v.string(), v.description("with the country code; spaces and + are fine")) }),
      annotations: READ,
      online: (adapter, args, { guard }) => people(adapter, guard).lookup(phoneOf(args.phone)),
    }),

    contacts_show: tool({
      title: "Show a person",
      description: "One person and the chats shared with them.",
      input: v.object({
        with_notes: v.optional(v.boolean()),
        person: v.pipe(v.string(), v.minLength(1), v.description("person id, @username, or part of a name")),
      }),
      annotations: READ,
      storedWhen: (args) => args.with_notes === true,
      stored: async (store, account, args, defaults) => {
        if (levelFor(defaults.settings.permissions ?? {}, "contacts.notes.list").level === "deny")
          throw new CliError("permission_error", "profile denies contacts.notes.list")
        return servicesFor(storedDeps(messenger, store, account, defaults.guard)).people.show(args.person, {
          notes: true,
        })
      },
      served: (services, args) => services.people.show(args.person),
    }),

    contacts_profile: tool({
      title: "Profile of a person",
      description:
        "What the messenger says about one person — { id, name, usernames, bio, birthday?, phone? (last four " +
        "digits), flags { bot, verified, premium, scam, fake, restricted, deleted, support }, seen (online, recently, " +
        "week, month, hidden or a time), contact?, mutualContact?, commonChatsCount?, registered? { at, source: " +
        "telegram | max | estimate, precision }, hasPhoto? } — and chats: for each chat shared with them, " +
        "theirMessages stored, firstAt, lastAt and complete (false: the count is a floor); aliases: earlier names " +
        "and usernames the store saw — { name?, username?, link?, firstSeenAt, lastSeenAt, source: profile | " +
        "messages (approximate) }. Reading tells them nothing.",
      input: v.object({
        person: v.pipe(v.string(), v.minLength(1), v.description("person id, @username, or part of a name")),
      }),
      annotations: READ,
      served: async (services, args) => maskedAccount(await services.people.profile(args.person)),
    }),

    contacts_context: tool({
      title: "What is known about a person",
      description:
        "Everything the local store holds about one person, in every messenger linked to them: person { uid, " +
        "identities }, shared chats, last { fromThem, fromMe, fromThemAnywhere }, recent { direct, groups }, " +
        "mentions — each message with a locator. complete is false when a shared chat is not stored whole; notRead " +
        "names it and why. Reads the store only; marks nothing read. Never assumes two people with one name are one. " +
        "With chats: instead, { person, chats: [{ chat, messages, complete, more }] } — their newest messages in each " +
        "chat named, oldest first, as { at, text } unless detail asks for ids and locators (1) or everything (2).",
      input: v.object({
        person: v.pipe(v.string(), v.minLength(1), v.description("person id, @username, or part of a name")),
        limit: v.optional(
          v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(100), v.description("at most this many per list")),
        ),
        since_time: v.optional(v.pipe(v.string(), v.description("an ISO 8601 time, or 2h / 1d ago"))),
        chats: v.optional(
          v.pipe(
            v.array(v.pipe(v.string(), v.minLength(1))),
            v.minLength(1),
            v.description("chats by id or name: their newest messages in each"),
          ),
        ),
        detail: v.optional(
          v.pipe(v.picklist([0, 1, 2]), v.description("with chats: 1 adds ids and locators, 2 everything")),
        ),
      }),
      annotations: { ...READ, openWorldHint: false },
      stored: (store, account, args, defaults) => {
        const people = servicesFor(storedDeps(messenger, store, account, defaults.guard)).people
        if (args.chats !== undefined) {
          if (args.since_time !== undefined) throw new CliError("validation_error", "since_time is not used with chats")
          return people.messagesIn(args.person, {
            chats: args.chats,
            ...(args.limit === undefined ? {} : { limit: args.limit }),
            ...(args.detail === undefined ? {} : { detail: args.detail }),
          })
        }
        return people.context(args.person, {
          messages: args.limit ?? CONTEXT_MESSAGES,
          bytes: CONTEXT_BYTES,
          ...(args.since_time === undefined ? {} : { since: momentOf(args.since_time, "since_time") }),
        })
      },
    }),

    contacts_timeline: tool({
      title: "What a person took part in",
      description:
        "Everything one person took part in, in every messenger linked to them, newest first: person { uid, name }, " +
        "items [{ at, subject (message, chat, email, meeting, task, document…), subjectId, role (sender, " +
        "mentioned, participant, recipient, assignee, author…), scope, provider, account, chatId, locator, " +
        "projectId }], limits, hasMore. A message carries a locator other tools take. Reads the store only.",
      input: v.object({
        person: v.pipe(v.string(), v.minLength(1), v.description("person id, @username, or part of a name")),
        scope: v.optional(v.pipe(v.picklist(SCOPES), v.description("only personal or only work"))),
        since_time: v.optional(v.pipe(v.string(), v.description("an ISO 8601 time, or 2h / 1d ago"))),
        until_time: v.optional(v.pipe(v.string(), v.description("through this ISO 8601 time, or 2h / 1d ago"))),
        limit: v.optional(
          v.pipe(
            v.number(),
            v.integer(),
            v.minValue(1),
            v.maxValue(100),
            v.description(`at most this many; ${TIMELINE_ITEMS} if not given`),
          ),
        ),
      }),
      annotations: { ...READ, openWorldHint: false },
      stored: (store, account, args, defaults) =>
        servicesFor(storedDeps(messenger, store, account, defaults.guard)).people.timeline(args.person, {
          ...(args.scope === undefined ? {} : { scope: args.scope }),
          ...(args.since_time === undefined ? {} : { since: momentOf(args.since_time, "since_time") }),
          ...(args.until_time === undefined ? {} : { until: momentOf(args.until_time, "until_time") }),
          ...(args.limit === undefined ? {} : { limit: args.limit }),
        }),
    }),

    contacts_check: tool({
      title: "Does a person look like a bot",
      description:
        "Scores one person as a possible bot, fake or spammer: the messenger's own marks, their profile, what they " +
        (registriesCover(messenger.provider)
          ? "wrote in the store, and the public ban lists " +
            `${Object.values(REGISTRIES)
              .map(({ title, docs }) => `${title} (${docs})`)
              .join(", ")} — **the person's id is sent to each of them** only when registries is true. `
          : "wrote in the store. The public ban lists cover Telegram only, so nothing is sent. ") +
        "Returns { person, " +
        "score, reasons: [{ reason, weight, source, detail }], registries: [{ name, answer: listed|clean|unknown, " +
        "checkedAt, detail }], unknown, notes }. A hint, never a verdict; changes nothing.",
      input: v.object({
        person: v.pipe(v.string(), v.minLength(1), v.description("person id, @username, or part of a name")),
        registries: v.optional(
          v.pipe(v.boolean(), v.description("true: explicitly ask public ban lists; default false keeps the id local")),
        ),
      }),
      annotations: READ,
      served: (services, args, defaults) => {
        const registries = args.registries === true
        const key = registries ? casKey(messenger.app, defaults.env) : undefined
        return services.botcheck.person(args.person, { registries, ...(key ? { registry: { casKey: key } } : {}) })
      },
    }),
  }
}
