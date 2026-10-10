import { CliError } from "@wirecat/cli-core"
import { capability } from "../cli/messenger/port.js"
import type { Chat, Contact, Id, Member, Page, PersonCard, PersonProfile, PhoneBookEntry } from "../domain/models.js"
import { pickPerson } from "../resolve.js"
import { guardedWrite, type Operated } from "../sends/guarded.js"
import { newOperationId } from "../sends/send-id.js"
import type { AccountKey, MessageStore, PersonRecord } from "../store/store.js"
import type { PageWindow } from "./chats.js"
import { fromStore, type ServiceDeps, storeIfOpen } from "./deps.js"

import { storedChatId } from "./messages.js"
import {
  CHAT_MESSAGES,
  type ContextOptions,
  type Detail,
  identityIn,
  type PersonContext,
  type PersonMessages,
  personContext,
  personMessages,
} from "./person-context.js"
import { personProfile } from "./person-profile.js"
import { type PersonTimeline, personTimeline, type TimelineOptions } from "./person-timeline.js"

export interface ContactSync {
  added: number
  changed: number
  known: number
}

/**
 * A contact is somebody this account has a one-to-one chat with — a query over the chat list, never
 * a flag somebody maintains (max-cli `NEED-105`). Where the store holds who is in each one-to-one
 * chat, it answers; otherwise the dialogs themselves do, offline from the stored chats.
 */
export interface PeopleService {
  list(
    options: { order: "recent" | "name"; search?: string; notesSearch?: string } & PageWindow,
  ): Promise<Page<Contact>>
  show(person: string, options?: { notes?: boolean }): Promise<PersonCard>
  /** What the messenger says about them, and their stored activity in each shared chat. */
  profile(person: string): Promise<PersonProfile>
  /** `phone` as digits, parsed by the caller (`phoneOf`). */
  lookup(phone: string): Promise<Member>
  /** The whole contact list from the messenger into the store: what was new, what changed. */
  sync(): Promise<ContactSync>
  add(person: string): Promise<Operated<{ person: Member }>>
  remove(person: string): Promise<Operated<{ personId: Id }>>
  block(person: string): Promise<Operated<{ personId: Id }>>
  unblock(person: string): Promise<Operated<{ personId: Id }>>
  rename(person: string, firstName: string, lastName?: string): Promise<Operated<{ person: Member }>>
  /** What the store holds about them, across every messenger linked to them; never connects. */
  context(person: string, options?: ContextOptions): Promise<PersonContext>
  /** Everything they took part in, from the store's involvement index; never connects. */
  timeline(person: string, options?: TimelineOptions): Promise<PersonTimeline>
  /**
   * Their newest messages in each chat named, from the store; `fetch` reads them from the messenger
   * first — by sender where it can search so, the newest page of the chat where it cannot.
   */
  messagesIn(
    person: string,
    options: { chats: string[]; limit?: number; detail?: Detail; fetch?: boolean },
  ): Promise<PersonMessages>
  /** `other` may name another messenger of the store: `max:Ana`. */
  link(person: string, other: string, method?: string): Promise<PersonRecord>
  unlink(person: string): Promise<PersonRecord>
  /** Only counts and the people recognised: never a number. */
  import(entries: PhoneBookEntry[]): Promise<Operated<{ sent: number; recognised: Member[] }>>
}

type ContactAction = "contact-add" | "contact-remove" | "contact-block" | "contact-unblock" | "contact-rename"

export const peopleService = (deps: ServiceDeps): PeopleService => {
  const localCard = async (card: PersonCard, includeNotes = false): Promise<PersonCard> => {
    const held = await storeIfOpen(deps)
    if (!held || !(await held.store.people(held.account.provider, { account: held.account.account })).get(card.id))
      return card
    const local = await held.store.privateContact(held.account, card.id)
    return {
      ...card,
      ...(local.alias === null ? {} : { alias: local.alias, displayName: local.alias }),
      ...(!includeNotes || local.notes.length === 0 ? {} : { notes: local.notes }),
    }
  }
  const referenceOf = async (reference: string) => {
    const held = await storeIfOpen(deps)
    if (!held) return reference
    const lookup = await held.store.people(held.account.provider, { account: held.account.account })
    const wanted = reference.trim().toLowerCase()
    return lookup.all().some((person) => person.alias?.toLowerCase().includes(wanted))
      ? pickPerson(reference, lookup).id
      : reference
  }
  const online = async (command: string) => {
    if (deps.offline)
      throw new CliError("validation_error", `\`${command}\` changes the address book; not with --offline`)
    return deps.connection()
  }
  const change = async <T>(
    action: ContactAction,
    person: string,
    act: (connection: Awaited<ReturnType<ServiceDeps["connection"]>>, personId: Id) => Promise<T>,
  ): Promise<{ operationId: string; personId: Id; done: T }> => {
    const connection = await online(`contacts ${action.slice("contact-".length)}`)
    const [personId] = await capability(connection, "people", "find people")([await referenceOf(person)])
    const operationId = newOperationId()
    const done = await guardedWrite(deps.guard, { operationId, chatId: null, kind: "account", action }, () =>
      act(connection, personId as Id),
    )
    return { operationId, personId: personId as Id, done }
  }

  return {
    list: async (options) => {
      // The chats first: a messenger whose login brings its people writes them before the store is asked.
      const stored = fromStore(deps)
      const chats = stored
        ? undefined
        : (await capability(await deps.connection(), "chats", "list chats")({ offset: 0 })).items
      const held = stored ? { store: await deps.store(), account: await deps.account() } : await storeIfOpen(deps)
      if (held && options.notesSearch !== undefined) {
        const query = options.notesSearch.trim().toLowerCase()
        if (!query) throw new CliError("validation_error", "--search-notes takes nonempty text")
        const all = await held.store.contacts(held.account, {
          order: options.order,
          ...(options.search ? { query: options.search } : {}),
          limit: await held.store.countContacts(held.account),
        })
        const matches: Contact[] = []
        for (const person of all.items) {
          const local = await held.store.privateContact(held.account, person.id)
          if (local.notes.some((note) => note.text.toLowerCase().includes(query))) matches.push(person)
        }
        const end = options.limit === undefined ? matches.length : options.offset + options.limit
        return { items: matches.slice(options.offset, end), hasMore: matches.length > end }
      }
      if (held && (await held.store.countContacts(held.account)) > 0)
        return storedContacts(held.store, held.account, options)
      return contactsIn(
        chats ?? (await (await deps.store()).chats(await deps.account(), {})).items,
        options,
        deps.messenger.partnerOf,
      )
    },

    show: async (person, { notes = false } = {}) => {
      if (fromStore(deps)) {
        const store = await deps.store()
        const account = await deps.account()
        const found = pickPerson(person, await store.people(account.provider, { account: account.account }))
        return localCard({ ...found, chats: await sharedChats(store, account, found.id) }, notes)
      }
      const card = await capability(await deps.connection(), "contact", "show a person")(await referenceOf(person))
      if (card.chats.length > 0) return localCard(card, notes)
      const held = await storeIfOpen(deps)
      return localCard(held ? { ...card, chats: await sharedChats(held.store, held.account, card.id) } : card, notes)
    },

    profile: (person) => personProfile(deps, person),

    context: async (person, options) => personContext(await deps.store(), await deps.account(), person, options),

    timeline: async (person, options) => personTimeline(await deps.store(), await deps.account(), person, options),

    messagesIn: async (person, { chats, limit, detail, fetch = false }) => {
      const store = await deps.store()
      const account = await deps.account()
      if (!fetch) {
        const ids = await Promise.all(chats.map((chat) => storedChatId(deps.messenger, chat, store, account)))
        return personMessages(store, account, person, {
          chats: ids,
          ...(limit ? { limit } : {}),
          ...(detail ? { detail } : {}),
        })
      }
      if (deps.offline) throw new CliError("validation_error", "--fetch asks the messenger; not with --offline")
      const connection = await deps.connection()
      const sender = pickPerson(person, await store.people(account.provider, { account: account.account })).id
      const ids: Id[] = []
      for (const chat of chats) {
        const { id } = await connection.resolve(chat)
        ids.push(id)
        const page = connection.historyFrom
          ? await connection.historyFrom(id, sender, { limit: limit ?? CHAT_MESSAGES })
          : await capability(connection, "history", "read a chat's history")(id, { limit: 100 })
        if (page.items.length > 0) await store.saveMessages(account, id, page.items, { via: "history" })
      }
      return personMessages(store, account, person, {
        chats: ids,
        ...(limit ? { limit } : {}),
        ...(detail ? { detail } : {}),
      })
    },

    link: async (person, other, method = "manual") => {
      const store = await deps.store()
      const account = await deps.account()
      const one = await identityIn(store, account, person)
      const two = await identityIn(store, account, other)
      if (one.provider === two.provider && one.id === two.id)
        throw new CliError("validation_error", "that is the same person twice")
      return store.linkIdentities(one, two, { method, by: "owner" })
    },

    unlink: async (person) => {
      const store = await deps.store()
      return store.unlinkIdentity(await identityIn(store, await deps.account(), person), {
        method: "manual",
        by: "owner",
      })
    },

    lookup: async (phone) => capability(await deps.connection(), "lookup", "find a person by phone")(phone),

    sync: async () => {
      if (deps.offline) {
        throw new CliError("validation_error", "`contacts sync` takes the list from the messenger; not with --offline")
      }
      const people = await capability(await deps.connection(), "addressBook", "list its contacts")()
      const store = await deps.store()
      const account = await deps.account()
      const before = await store.people(account.provider, { account: account.account })
      let added = 0
      let changed = 0
      for (const person of people) {
        const known = before.get(person.id)
        if (!known) added += 1
        else if (known.name !== person.name || known.username !== person.username) changed += 1
      }
      await store.savePeople(account, people)
      return {
        added,
        changed,
        known: (await store.people(account.provider, { account: account.account })).all().length,
      }
    },

    add: async (person) => {
      const { operationId, done } = await change("contact-add", person, (connection, id) =>
        capability(connection, "addContact", "add a contact")(id),
      )
      return { operationId, person: done }
    },

    remove: async (person) => {
      const { operationId, personId } = await change("contact-remove", person, (connection, id) =>
        capability(connection, "removeContact", "remove a contact")(id),
      )
      return { operationId, personId }
    },

    block: async (person) => {
      const { operationId, personId } = await change("contact-block", person, (connection, id) =>
        capability(connection, "block", "block a person")(id),
      )
      return { operationId, personId }
    },

    unblock: async (person) => {
      const { operationId, personId } = await change("contact-unblock", person, (connection, id) =>
        capability(connection, "unblock", "unblock a person")(id),
      )
      return { operationId, personId }
    },

    rename: async (person, firstName, lastName) => {
      if (firstName.trim() === "") throw new CliError("validation_error", "a name cannot be empty")
      const { operationId, done } = await change("contact-rename", person, (connection, id) =>
        capability(connection, "renameContact", "rename a contact")(id, firstName.trim(), lastName?.trim()),
      )
      return { operationId, person: done }
    },

    import: async (entries) => {
      if (entries.length === 0) throw new CliError("validation_error", "the file names nobody")
      const connection = await online("contacts import")
      const importing = capability(connection, "importContacts", "import contacts")
      const operationId = newOperationId()
      const recognised = await guardedWrite(
        deps.guard,
        { operationId, chatId: null, kind: "account", action: "contact-import", count: entries.length },
        () => importing(entries),
      )
      return { operationId, sent: entries.length, recognised }
    },
  }
}

/** Digits, with the `+` and the spaces, dashes and brackets people type dropped. */
export const phoneOf = (typed: string): string => {
  const digits = typed.replace(/[\s()+-]/g, "")
  if (!/^\d{6,15}$/.test(digits)) {
    throw new CliError("validation_error", "that is not a phone number — digits, with a country code")
  }
  return digits
}

const storedContacts = async (
  store: MessageStore,
  account: AccountKey,
  { order, search, limit, offset }: { order: "recent" | "name"; search?: string } & PageWindow,
): Promise<Page<Contact>> => {
  // Chats saved since the last refresh may have moved someone up; the order is worked out again here.
  if (order === "recent") await store.refreshRecency(account)
  const query = search?.trim() || undefined
  return store.contacts(account, {
    order,
    ...(query === undefined ? {} : { query }),
    limit: limit ?? (await store.countContacts(account, query === undefined ? {} : { query })),
    offset,
  })
}

const sharedChats = async (store: MessageStore, account: AccountKey, personId: string) =>
  (await store.chatsWith(account, personId)).map(({ id, title, kind, lastMessageAt }) => ({
    id,
    title,
    kind,
    lastMessageAt,
  }))

/**
 * A dialog's id is its person's only where the messenger says so: without `partnerOf` it is (Telegram);
 * with it, a dialog whose person the messenger cannot name is left out rather than listed under the
 * chat's id (MAX, where a dialog's id is not the partner's).
 */
const contactsIn = (
  chats: readonly Chat[],
  { order, search, limit, offset }: { order: "recent" | "name"; search?: string } & PageWindow,
  partnerOf?: (chat: Chat) => Id | undefined,
): Page<Contact> => {
  const wanted = search?.trim().toLowerCase()
  const people = chats
    .filter((chat) => chat.kind === "dialog")
    .flatMap((chat) => {
      const id = partnerOf ? partnerOf(chat) : chat.id
      return id === undefined ? [] : [{ ...toContact(chat), id }]
    })
    .filter(
      (person) => !wanted || [person.name, person.username].some((field) => field?.toLowerCase().includes(wanted)),
    )
    .sort(order === "name" ? byName : byRecency)
  const end = limit === undefined ? people.length : offset + limit
  return { items: people.slice(offset, end), hasMore: people.length > end }
}

const toContact = (chat: Chat): Contact => ({
  id: chat.id,
  name: chat.title,
  username: typeof chat.providerMetadata?.username === "string" ? chat.providerMetadata.username : null,
  description: null,
  lastMessagedAt: chat.lastMessageAt,
})

const byRecency = (a: Contact, b: Contact) => (b.lastMessagedAt ?? "").localeCompare(a.lastMessagedAt ?? "")
const byName = (a: Contact, b: Contact) => (a.name ?? "").localeCompare(b.name ?? "")

/** The phone cut to its last four digits: enough to tell two accounts apart. */
export const maskedAccount = <T extends { phone?: string | null }>(account: T): T =>
  account.phone ? { ...account, phone: `***${account.phone.replace(/\D/g, "").slice(-4)}` } : account
