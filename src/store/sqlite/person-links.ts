import { CliError } from "@wirecat/cli-core"
import type { Id, Page } from "../../domain/models.js"
import type { IdentityRef, LinkedIdentity, LinkOptions, PersonRecord, StoredHit } from "../store.js"
import { and, eq, inArray, isNull, type SQL, sql } from "./drizzle/core.js"
import type { StoreContext } from "./open.js"
import { resolvePersonLinks } from "./person-resolution.js"
import {
  accountIdentities,
  accounts,
  identities,
  identityLinkEvents,
  identityLinks,
  messages,
  persons,
} from "./schema.js"
import { hitsWhere } from "./search.js"

const identityRow = ({ orm }: StoreContext, { provider, id }: IdentityRef) =>
  orm
    .select({ pk: identities.id, personPk: identityLinks.personId })
    .from(identities)
    .innerJoin(identityLinks, eq(identityLinks.identityId, identities.id))
    .where(and(eq(identities.provider, provider), eq(identities.externalId, id)))
    .get()

const required = (context: StoreContext, ref: IdentityRef) => {
  const found = identityRow(context, ref)
  if (!found) throw new CliError("not_found", `no ${ref.provider} person ${ref.id} in the store`)
  return found
}

const recordOf = ({ orm }: StoreContext, personPk: number): PersonRecord => {
  const person = orm.select().from(persons).where(eq(persons.id, personPk)).get()
  if (!person) throw new CliError("not_found", "that person is not in the store")
  const rows = orm
    .select({
      pk: identities.id,
      provider: identities.provider,
      id: identities.externalId,
      name: identities.name,
      username: identities.username,
      isBot: identities.bot,
      method: identityLinks.method,
      linkedBy: identityLinks.author,
      linkedAt: identityLinks.createdAt,
    })
    .from(identityLinks)
    .innerJoin(identities, eq(identities.id, identityLinks.identityId))
    .where(eq(identityLinks.personId, personPk))
    .orderBy(identities.provider, identities.externalId)
    .all()
  const seen = orm
    .select({ identityPk: accountIdentities.identityId, account: accounts.externalId })
    .from(accountIdentities)
    .innerJoin(accounts, eq(accounts.id, accountIdentities.accountId))
    .where(
      inArray(
        accountIdentities.identityId,
        rows.map((row) => row.pk),
      ),
    )
    .all()
  const identitiesOf: LinkedIdentity[] = rows.map(({ pk, isBot, linkedAt, ...row }) => ({
    ...row,
    isBot: isBot === null ? null : isBot === 1,
    accounts: seen.filter((one) => one.identityPk === pk).map((one) => one.account),
    linkedAt: new Date(linkedAt).toISOString(),
  }))
  return { uid: String(person.id), name: person.name, identities: identitiesOf }
}

/** A person by the uid a `person:` reference holds, with every identity linked to them. */
export const personByUid = (context: StoreContext, uid: string): PersonRecord | undefined => {
  if (!/^[1-9]\d*$/.test(uid) || !Number.isSafeInteger(Number(uid))) return undefined
  const found = context.database.prepare("SELECT id AS pk FROM persons WHERE id = ?").get(uid)
  return found ? recordOf(context, Number(found.pk)) : undefined
}

/** The person an identity belongs to, with every identity linked to them. */
export const personOf = (context: StoreContext, ref: IdentityRef): PersonRecord | undefined => {
  const found = identityRow(context, ref)
  return found ? recordOf(context, found.personPk) : undefined
}

const move = (context: StoreContext, identityPk: number, from: number, to: number, { method, by }: LinkOptions) => {
  const at = context.now()
  context.orm
    .update(identityLinks)
    .set({ personId: to, method, confidence: 1, createdAt: at, updatedAt: at, author: by })
    .where(eq(identityLinks.identityId, identityPk))
    .run()
  context.orm
    .insert(identityLinkEvents)
    .values({ identityId: identityPk, fromPersonId: from, toPersonId: to, method, createdAt: at, author: by })
    .run()
}

/** A reviewed meeting participant association moves only its selected identity. */
export const linkIdentityToPerson = (
  context: StoreContext,
  identityPk: number,
  target: number,
  options: LinkOptions,
): void => {
  const found = context.orm
    .select({ personId: identityLinks.personId })
    .from(identityLinks)
    .where(eq(identityLinks.identityId, identityPk))
    .get()
  if (found) {
    move(context, identityPk, found.personId, target, options)
    return
  }
  const at = context.now()
  context.orm
    .insert(identityLinks)
    .values({
      identityId: identityPk,
      personId: target,
      method: options.method,
      confidence: 1,
      createdAt: at,
      updatedAt: at,
      author: options.by,
    })
    .run()
  context.orm
    .insert(identityLinkEvents)
    .values({
      identityId: identityPk,
      fromPersonId: null,
      toPersonId: target,
      method: options.method,
      createdAt: at,
      author: options.by,
    })
    .run()
}

/**
 * Makes `other` and everyone already linked to it the same person as `person`. Never inferred from a
 * name: a caller links only what someone decided belongs together, and says how in `method`.
 */
export const linkIdentities = (
  context: StoreContext,
  person: IdentityRef,
  other: IdentityRef,
  options: LinkOptions,
): PersonRecord => {
  const target = required(context, person)
  const moving = required(context, other)
  if (moving.personPk !== target.personPk) {
    const together = context.orm
      .select({ identityPk: identityLinks.identityId })
      .from(identityLinks)
      .where(eq(identityLinks.personId, moving.personPk))
      .all()
    for (const { identityPk } of together) move(context, identityPk, moving.personPk, target.personPk, options)
  }
  const record = recordOf(context, target.personPk)
  // Two identities that were two people named alike are one now, so a name that was ambiguous may not be.
  resolvePersonLinks(
    context.database,
    record.identities.flatMap(({ name, username }) => [name, username]),
  )
  return record
}

/** Gives the identity a person of its own again; the ones left keep theirs. */
export const unlinkIdentity = (context: StoreContext, ref: IdentityRef, options: LinkOptions): PersonRecord => {
  const found = required(context, ref)
  const others = context.orm
    .select({ n: sql<number>`count(*)` })
    .from(identityLinks)
    .where(eq(identityLinks.personId, found.personPk))
    .get()
  if (Number(others?.n) <= 1)
    throw new CliError("validation_error", `${ref.provider} ${ref.id} is not linked to anyone`)
  const at = context.now()
  const named = context.orm.select({ name: identities.name }).from(identities).where(eq(identities.id, found.pk)).get()
  const alone = Number(
    context.orm
      .insert(persons)
      .values({ name: named?.name ?? null, createdAt: at, updatedAt: at })
      .returning({ pk: persons.id })
      .get()?.pk,
  )
  move(context, found.pk, found.personPk, alone, options)
  return recordOf(context, alone)
}

/** Messages that name the person: by id where the messenger said so, or by `@username` in the text. */
export const mentioning = (
  context: StoreContext,
  accountKey: number,
  { id, username }: { id: Id; username: string | null },
  limit: number,
): Page<StoredHit> => {
  const byId = sql`EXISTS (SELECT 1 FROM json_each(${messages.mentions}) WHERE json_each.value = ${id})`
  const byHandle: SQL | undefined =
    username === null ? undefined : sql`instr(lower(${messages.text}), ${`@${username.toLowerCase()}`}) > 0`
  const where = and(
    eq(messages.accountId, accountKey),
    isNull(messages.deletedAt),
    byHandle ? sql`(${byId} OR ${byHandle})` : byId,
  )
  // instr finds "@ana" inside "@anastasia" too; the word boundary is checked here.
  const handle = username === null ? undefined : new RegExp(`@${escaped(username)}(?![\\p{L}\\p{N}_])`, "iu")
  const page = hitsWhere(context, where, limit)
  return {
    ...page,
    items: page.items.filter((hit) => hit.mentions?.includes(id) || handle?.test(hit.text)),
  }
}

const escaped = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
