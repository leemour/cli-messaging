import { CliError } from "@wirecat/cli-core"
import type { IdentityInput } from "@wirecat/cli-meetings"
import type { Contact, Id, Page, PersonAlias, Provider } from "../../domain/models.js"
import type { PeopleLookup } from "../../resolve.js"
import { fold } from "../normalize.js"
import type { AccountKey, PersonFacts } from "../store.js"
import { and, asc, desc, eq, inArray, isNotNull, isNull, ne, sql } from "./drizzle/core.js"
import type { Orm, StoreContext } from "./open.js"
import { resolvePersonLinks } from "./person-resolution.js"
import {
  accountIdentities,
  accounts,
  aliases,
  chatMembers,
  chats,
  identities,
  identityLinkEvents,
  identityLinks,
  identityRevisions,
  messages,
  persons,
} from "./schema.js"
import { toIso } from "./values.js"

type Facts = Omit<PersonFacts, "id" | "name"> & {
  metadata?: IdentityInput["metadata"]
  /** The messenger's marks, given only by a full profile read (a member list): its name and username are then the whole truth. */
  marks?: Record<string, boolean>
}

interface Profile {
  name: string | null
  username: string | null
  marks?: string | null
}

export interface SavedIdentity {
  pk: number
  /** The profile differs from an earlier one written. */
  revised: boolean
}

const flag = (value: boolean | null | undefined) => (value === undefined || value === null ? null : Number(value))

const prepare = (orm: Orm) => ({
  find: orm
    .select({
      pk: identities.id,
      name: identities.name,
      username: identities.username,
      isBot: identities.bot,
      description: identities.description,
      updatedAt: identities.updatedAt,
      personId: identityLinks.personId,
    })
    .from(identities)
    .leftJoin(identityLinks, eq(identityLinks.identityId, identities.id))
    .where(
      and(
        eq(identities.provider, sql.placeholder("provider")),
        eq(identities.externalId, sql.placeholder("externalId")),
      ),
    )
    .prepare(),
  seen: orm
    .insert(accountIdentities)
    .values({
      accountId: sql.placeholder("accountId"),
      identityId: sql.placeholder("identityId"),
      createdAt: sql.placeholder("createdAt"),
      updatedAt: sql.placeholder("createdAt"),
    })
    .onConflictDoNothing()
    .prepare(),
  lastRevision: orm
    .select({
      pk: identityRevisions.id,
      name: identityRevisions.name,
      username: identityRevisions.username,
      marks: identityRevisions.marks,
    })
    .from(identityRevisions)
    .where(eq(identityRevisions.identityId, sql.placeholder("identityId")))
    .orderBy(desc(identityRevisions.createdAt), desc(identityRevisions.id))
    .limit(1)
    .prepare(),
})

// Built once per store: both run for every message saved, and building a Drizzle query costs more than running it.
const prepared = new WeakMap<Orm, ReturnType<typeof prepare>>()
const statementsOf = (orm: Orm) => {
  const statements = prepared.get(orm) ?? prepare(orm)
  prepared.set(orm, statements)
  return statements
}

const writeRevision = (orm: Orm, identityPk: number, { name, username, marks }: Profile, capturedAt: number) =>
  Number(
    orm
      .insert(identityRevisions)
      .values({ identityId: identityPk, name, username, marks: marks ?? null, createdAt: capturedAt })
      .returning({ pk: identityRevisions.id })
      .get()?.pk,
  )

/**
 * Writes a revision when the profile differs from the last one written; `before`, dated, goes first when there is
 * none yet. A revision written without marks gets them filled in rather than a second row: learning them is not a
 * change, and member history would report one.
 */
const revise = (orm: Orm, identity: number, next: Profile, at: number, before?: Profile & { at: number }): boolean => {
  let last = statementsOf(orm).lastRevision.get({ identityId: identity })
  if (!last && before) last = { ...before, marks: null, pk: writeRevision(orm, identity, before, before.at) }
  const marks = next.marks ?? last?.marks ?? null
  if (last && last.name === next.name && last.username === next.username) {
    if (last.marks === marks) return false
    if (last.marks === null) {
      orm.update(identityRevisions).set({ marks }).where(eq(identityRevisions.id, last.pk)).run()
      return false
    }
  }
  writeRevision(orm, identity, { ...next, marks }, at)
  return last !== undefined
}

const ensurePerson = (orm: Orm, identity: number, name: string | null, at: number): void => {
  if (
    orm.select({ id: identityLinks.identityId }).from(identityLinks).where(eq(identityLinks.identityId, identity)).get()
  )
    return
  const person = Number(
    orm.insert(persons).values({ name, createdAt: at, updatedAt: at }).returning({ pk: persons.id }).get()?.pk,
  )
  orm
    .insert(identityLinks)
    .values({
      identityId: identity,
      personId: person,
      method: "initial",
      confidence: 1,
      createdAt: at,
      updatedAt: at,
      author: "ingest",
    })
    .run()
  orm
    .insert(identityLinkEvents)
    .values({
      identityId: identity,
      fromPersonId: null,
      toPersonId: person,
      method: "initial",
      createdAt: at,
      author: "ingest",
    })
    .run()
}

/** Every new identity gets its own person; linking two is a later, recorded act. */
export const identityOf = (
  context: StoreContext,
  provider: Provider,
  nativeId: Id,
  name: string | null,
  facts: Facts = {},
): number => saveIdentity(context, provider, nativeId, name, facts).pk

const saveIdentity = (
  { orm, now, database }: StoreContext,
  provider: Provider,
  nativeId: Id,
  name: string | null,
  facts: Facts,
  resolveLinks = true,
): SavedIdentity => {
  const found = statementsOf(orm).find.get({ provider, externalId: nativeId })
  const marks = facts.marks ? JSON.stringify(facts.marks) : undefined
  if (found) {
    if (found.personId === null) ensurePerson(orm, found.pk, found.name, now())
    const changed = {
      name: name ?? found.name,
      username: facts.username ?? found.username,
      bot: flag(facts.isBot) ?? found.isBot,
      description: facts.description ?? found.description,
    }
    // Only on a real change: the search trigger rewrites the index row on every update of `name`.
    if (
      changed.name !== found.name ||
      changed.username !== found.username ||
      changed.bot !== found.isBot ||
      changed.description !== found.description
    ) {
      orm
        .update(identities)
        .set({ ...changed, updatedAt: now() })
        .where(eq(identities.id, found.pk))
        .run()
    }
    const renamed = changed.name !== found.name || changed.username !== found.username
    if (renamed && resolveLinks) resolvePersonLinks(database, [changed.name, changed.username])
    if (marks === undefined && !renamed) return { pk: found.pk, revised: false }
    const next = marks === undefined ? changed : { name, username: facts.username ?? null, marks }
    const before = renamed ? { name: found.name, username: found.username, at: found.updatedAt } : undefined
    return { pk: found.pk, revised: revise(orm, found.pk, next, now(), before) }
  }
  const at = now()
  const identity = Number(
    orm
      .insert(identities)
      .values({
        provider,
        externalId: nativeId,
        name,
        metadata: facts.metadata == null ? null : JSON.stringify(facts.metadata),
        username: facts.username ?? null,
        bot: flag(facts.isBot),
        description: facts.description ?? null,
        createdAt: at,
        updatedAt: at,
      })
      .returning({ pk: identities.id })
      .get()?.pk,
  )
  ensurePerson(orm, identity, name, at)
  if (marks !== undefined) revise(orm, identity, { name, username: facts.username ?? null, marks }, at)
  if (resolveLinks) resolvePersonLinks(database, [name, facts.username])
  return { pk: identity, revised: false }
}

/** An identity as `accountKey` saw it — recorded as seen by that account, so reads stay per account. */
export const identityPk = (
  context: StoreContext,
  accountKey: number,
  provider: Provider,
  nativeId: Id,
  name: string | null,
  facts: Facts = {},
): number => seenIdentity(context, accountKey, provider, nativeId, name, facts).pk

export const seenIdentity = (
  context: StoreContext,
  accountKey: number,
  provider: Provider,
  nativeId: Id,
  name: string | null,
  facts: Facts = {},
): SavedIdentity => {
  const saved = saveIdentity(context, provider, nativeId, name, facts)
  statementsOf(context.orm).seen.run({ accountId: accountKey, identityId: saved.pk, createdAt: context.now() })
  return saved
}

export const people = (
  { orm, database }: StoreContext,
  provider: Provider,
  { account, accounts: native }: { account?: Id; accounts?: Id[] },
): PeopleLookup => {
  const within = native ?? (account === undefined ? undefined : [account])
  const seenBy =
    within &&
    orm
      .select({ pk: accountIdentities.identityId })
      .from(accountIdentities)
      .innerJoin(accounts, eq(accounts.id, accountIdentities.accountId))
      .where(and(eq(accounts.provider, provider), inArray(accounts.externalId, within)))
  const everyone: Contact[] = orm
    .select({ id: identities.externalId, name: identities.name, username: identities.username })
    .from(identities)
    .where(and(eq(identities.provider, provider), seenBy ? inArray(identities.id, seenBy) : undefined))
    .all()
    .map((row) => ({ ...row, description: null, lastMessagedAt: null }))
  if (account !== undefined) {
    const aliases = database
      .prepare(
        "SELECT i.external_id AS id, ca.name AS alias FROM aliases ca JOIN identities i ON i.id=ca.aliasable_id AND ca.aliasable_type='identity' AND ca.display=1 JOIN accounts a ON a.id=ca.account_id WHERE a.provider=? AND a.external_id=?",
      )
      .all(provider, account)
    for (const row of aliases) {
      const person = everyone.find((one) => one.id === row.id)
      if (person && row.alias != null) {
        person.alias = String(row.alias)
        person.displayName = person.alias
      }
    }
  }
  const byId = new Map(everyone.map((person) => [person.id, person]))
  return { get: (id) => byId.get(id), all: () => everyone }
}

/** A contact: someone other than the account itself, in one of its one-to-one chats. */
const contactsWhere = (accountKey: number, key: AccountKey, query: string | undefined) => {
  if (query !== undefined && query.trim().length < 3) {
    throw new CliError("validation_error", `a contact search takes at least 3 characters, got "${query}"`)
  }
  return and(
    eq(accountIdentities.accountId, accountKey),
    ne(identities.externalId, key.account),
    sql`EXISTS (SELECT 1 FROM ${chatMembers} JOIN ${chats} ON ${chats.id} = ${chatMembers.chatId}
                WHERE ${chatMembers.identityId} = ${identities.id} AND ${chats.accountId} = ${accountIdentities.accountId}
                  AND ${chats.kind} = 'dialog')`,
    query === undefined
      ? undefined
      : sql`(${identities.id} IN (SELECT rowid FROM identities_fts WHERE identities_fts MATCH ${`"${query.trim().replaceAll('"', '""')}"`}) OR EXISTS (SELECT 1 FROM aliases ca WHERE ca.aliasable_type='identity' AND ca.display=1 AND ca.account_id=${accountKey} AND ca.aliasable_id=${identities.id} AND instr(ca.name_folded, ${fold(query.trim())}) > 0))`,
  )
}

export const contacts = (
  { orm }: StoreContext,
  accountKey: number,
  key: AccountKey,
  { order, query, limit, offset = 0 }: { order: "recent" | "name"; query?: string; limit: number; offset?: number },
): Page<Contact> => {
  const byName = [
    sql`coalesce(${aliases.name}, ${identities.name}) IS NULL`,
    sql`coalesce(${aliases.name}, ${identities.name})`,
    identities.externalId,
  ]
  const rows = orm
    .select({
      alias: aliases.name,
      id: identities.externalId,
      name: identities.name,
      username: identities.username,
      description: identities.description,
      lastMessagedAt: accountIdentities.lastMessagedAt,
    })
    .from(accountIdentities)
    .innerJoin(identities, eq(identities.id, accountIdentities.identityId))
    .leftJoin(
      aliases,
      and(
        eq(aliases.aliasableId, identities.id),
        eq(aliases.aliasableType, "identity"),
        eq(aliases.display, 1),
        eq(aliases.accountId, accountKey),
      ),
    )
    .where(contactsWhere(accountKey, key, query))
    .orderBy(...(order === "recent" ? [sql`${accountIdentities.lastMessagedAt} DESC NULLS LAST`] : []), ...byName)
    .limit(limit + 1)
    .offset(offset)
    .all()
  return {
    items: rows.slice(0, limit).map((row) =>
      (({ alias, ...rest }) => ({
        ...rest,
        lastMessagedAt: toIso(rest.lastMessagedAt),
        ...(alias === null ? {} : { alias, displayName: alias }),
      }))(row),
    ),
    hasMore: rows.length > limit,
  }
}

export const countContacts = (
  { orm }: StoreContext,
  accountKey: number,
  key: AccountKey,
  query: string | undefined,
): number =>
  Number(
    orm
      .select({ n: sql<number>`count(*)` })
      .from(accountIdentities)
      .innerJoin(identities, eq(identities.id, accountIdentities.identityId))
      .where(contactsWhere(accountKey, key, query))
      .get()?.n,
  )

export const refreshRecency = ({ orm }: StoreContext, accountKey: number): void => {
  orm
    .update(accountIdentities)
    .set({
      lastMessagedAt: sql`(SELECT max(${chats.lastMessageAt}) FROM ${chatMembers} JOIN ${chats} ON ${chats.id} = ${chatMembers.chatId}
        WHERE ${chatMembers.identityId} = ${accountIdentities.identityId} AND ${chats.accountId} = ${accountIdentities.accountId}
          AND ${chats.kind} = 'dialog')`,
    })
    .where(eq(accountIdentities.accountId, accountKey))
    .run()
}

/**
 * Every name and username the account's store recorded for one person: profile revisions, then the names on their
 * messages that no revision holds. Grouped by identity, never by name, so two people who shared one stay apart.
 */
export const namesOf = ({ orm }: StoreContext, accountKey: number, provider: Provider, nativeId: Id): PersonAlias[] => {
  const person = orm
    .select({ pk: identities.id })
    .from(identities)
    .innerJoin(accountIdentities, eq(accountIdentities.identityId, identities.id))
    .where(
      and(
        eq(identities.provider, provider),
        eq(identities.externalId, nativeId),
        eq(accountIdentities.accountId, accountKey),
      ),
    )
    .get()
  if (!person) return []
  const profile = new Map<string, PersonAlias>()
  const revisions = orm
    .select({ name: identityRevisions.name, username: identityRevisions.username, at: identityRevisions.createdAt })
    .from(identityRevisions)
    .where(eq(identityRevisions.identityId, person.pk))
    .orderBy(asc(identityRevisions.createdAt), asc(identityRevisions.id))
    .all()
  for (const { name, username, at } of revisions) {
    const key = JSON.stringify([name, username])
    const seen = toIso(at) as string
    const known = profile.get(key)
    if (known) known.lastSeenAt = seen
    else profile.set(key, { ...aliasOf(name, username), firstSeenAt: seen, lastSeenAt: seen, source: "profile" })
  }
  const named = new Set(revisions.map(({ name }) => name))
  const fromMessages = orm
    .select({
      name: messages.senderName,
      first: sql<number>`min(${messages.sentAt})`,
      last: sql<number>`max(${messages.sentAt})`,
    })
    .from(messages)
    .innerJoin(chats, eq(chats.id, messages.chatId))
    .where(
      and(
        eq(messages.senderIdentityId, person.pk),
        eq(chats.accountId, accountKey),
        isNull(messages.deletedAt),
        isNotNull(messages.senderName),
      ),
    )
    .groupBy(messages.senderName)
    .orderBy(asc(sql`min(${messages.sentAt})`))
    .all()
    .filter(({ name }) => !named.has(name))
    .map(({ name, first, last }) => ({
      ...aliasOf(name, null),
      firstSeenAt: toIso(first) as string,
      lastSeenAt: toIso(last) as string,
      source: "messages" as const,
    }))
  return [...profile.values(), ...fromMessages]
}

const aliasOf = (name: string | null, username: string | null) => ({
  ...(name === null ? {} : { name }),
  ...(username === null ? {} : { username }),
})

/** Stable provider identity only; participant labels never resolve or merge other people. */
export const meetingIdentityPk = (context: StoreContext, accountId: number, identity: IdentityInput): number => {
  if (!identity.provider || !identity.externalId) throw new CliError("validation_error", "Invalid identity key")
  const saved = saveIdentity(
    context,
    identity.provider,
    identity.externalId,
    identity.name,
    { metadata: identity.metadata },
    false,
  )
  statementsOf(context.orm).seen.run({ accountId, identityId: saved.pk, createdAt: context.now() })
  return saved.pk
}
