import { CliError } from "@wirecat/cli-core"
import { formatLocator } from "../../domain/locator.js"
import type { Message, Page } from "../../domain/models.js"
import { exhausted, QUERY_LIMITS } from "../../search/lucene/types.js"
import type { AccountKey, MessageFilter, StoredHit } from "../store.js"
import { alias, and, desc, eq, inArray, isNull, lte, type SQL, sql } from "./drizzle/core.js"
import type { StoreContext } from "./open.js"
import { MESSAGE_FIELDS, type MessageRow, newestFirst, toMessages } from "./reads.js"
import { accounts, chats, identities, messages } from "./schema.js"

const HIT_FIELDS = {
  ...MESSAGE_FIELDS,
  chatTitle: sql<string | null>`${chats.title}`.as("chat_title"),
  provider: sql<string>`${accounts.provider}`.as("provider"),
  accountNativeId: sql<string>`${accounts.externalId}`.as("account_native_id"),
}

type HitRow = MessageRow & { chatTitle: string | null; provider: string; accountNativeId: string }

/** Every word of three characters or more, found anywhere inside the text; a trigram index cannot match a shorter one. */
const wordsOf = (text: string): string => {
  const words = (text.match(/[\p{L}\p{N}]+/gu) ?? []).filter((word) => [...word].length >= 3)
  if (words.length === 0) throw new CliError("validation_error", "search needs a word of three letters or more")
  return words.map((word) => `"${word}"`).join(" ")
}

/** What `find` keeps, as one condition. */
export const matching = (
  context: StoreContext,
  {
    provider,
    account,
    accounts: within,
    senders,
    together = false,
    text,
    pattern,
    chatId,
    perChat = false,
  }: Omit<MessageFilter, "limit">,
): SQL | undefined => {
  const trimmed = pattern ? undefined : text?.trim()
  if (trimmed !== undefined && [...trimmed].length < 3) {
    throw new CliError("validation_error", "search needs at least three characters")
  }
  if (pattern && perChat) throw new CliError("validation_error", "a pattern search is not per chat")
  if (!trimmed && !pattern && !senders?.length) {
    throw new CliError("validation_error", "say what to find: some text, or who wrote it")
  }
  if (chatId !== undefined && account === undefined)
    throw new CliError("validation_error", "a chat id names a chat of one account — name the account too")
  const scopeProvider = account?.provider ?? provider
  if (within && scopeProvider === undefined) {
    throw new CliError("validation_error", "a read across accounts names their provider")
  }
  const ids = senders?.length ? [...new Set(senders)] : undefined
  return and(
    isNull(messages.deletedAt),
    trimmed
      ? sql`${messages.id} IN (SELECT rowid FROM messages_fts WHERE messages_fts MATCH ${wordsOf(trimmed)})`
      : undefined,
    scopeProvider === undefined ? undefined : eq(accounts.provider, scopeProvider),
    account ? eq(accounts.externalId, account.account) : undefined,
    within ? inArray(accounts.externalId, within) : undefined,
    chatId === undefined ? undefined : eq(chats.externalId, chatId),
    ids ? and(eq(identities.provider, accounts.provider), inArray(identities.externalId, ids)) : undefined,
    ids && together ? inArray(messages.chatId, everyoneWrote(context, ids, scopeProvider)) : undefined,
  )
}

/** The chats where every one of `ids` has a message — the outer row's provider when no scope names one. */
const everyoneWrote = ({ orm }: StoreContext, ids: string[], scopeProvider: string | undefined) => {
  const written = alias(messages, "m2")
  const writer = alias(identities, "i2")
  return orm
    .select({ chatPk: written.chatId })
    .from(written)
    .innerJoin(writer, eq(writer.id, written.senderIdentityId))
    .where(
      and(
        isNull(written.deletedAt),
        eq(writer.provider, scopeProvider ?? identities.provider),
        inArray(writer.externalId, ids),
      ),
    )
    .groupBy(written.chatId)
    .having(sql`count(DISTINCT ${writer.externalId}) = ${ids.length}`)
}

const chatRank = sql<number>`row_number() OVER (PARTITION BY ${messages.chatId} ORDER BY ${messages.sentAt} DESC, ${messages.id} DESC)`

const selectHits = ({ orm }: StoreContext) =>
  orm
    .select(HIT_FIELDS)
    .from(messages)
    .innerJoin(chats, eq(chats.id, messages.chatId))
    .leftJoin(identities, eq(identities.id, messages.senderIdentityId))
    .innerJoin(accounts, eq(accounts.id, messages.accountId))

const selectRanked = ({ orm }: StoreContext) =>
  orm
    .select({ ...HIT_FIELDS, chatRank: chatRank.as("chat_rank") })
    .from(messages)
    .innerJoin(chats, eq(chats.id, messages.chatId))
    .leftJoin(identities, eq(identities.id, messages.senderIdentityId))
    .innerJoin(accounts, eq(accounts.id, messages.accountId))

/** The plain search, newest first; exported so a test can read the plan SQLite makes of it. */
export const newestHits = (context: StoreContext, where: SQL | undefined, wanted: number) =>
  selectHits(context)
    .where(where)
    .orderBy(...newestFirst)
    .limit(wanted)

export const find = (context: StoreContext, filter: MessageFilter): Page<StoredHit> => {
  const { limit, pattern, perChat = false } = filter
  const where = matching(context, filter)
  if (pattern) throw new CliError("validation_error", "regex search requires the asynchronous isolated executor")
  const rows: HitRow[] = perChat
    ? perChatNewest(context, where, limit + 1)
    : newestHits(context, where, limit + 1).all()
  const page = perChat
    ? rows.filter((row) => (row as HitRow & { chatRank: number }).chatRank <= limit)
    : rows.slice(0, limit)
  return { items: toHits(context, page), hasMore: rows.length > page.length }
}

/** The newest `limit` hits under a condition the caller built, with `hasMore`. */
export const hitsWhere = (context: StoreContext, where: SQL | undefined, limit: number): Page<StoredHit> => {
  const rows: HitRow[] = newestHits(context, where, limit + 1).all()
  return { items: toHits(context, rows.slice(0, limit)), hasMore: rows.length > limit }
}

const toHits = (context: StoreContext, rows: HitRow[]): StoredHit[] => {
  const found = toMessages(context, rows)
  return rows.map((row, index) => {
    const message = found[index] as Message
    return {
      ...message,
      chatTitle: row.chatTitle,
      locator: formatLocator({
        provider: row.provider,
        account: row.accountNativeId,
        chat: message.chatId,
        message: message.id,
      }),
    }
  })
}

/** The hits for these messages, in the order given. */
export const hitsByPk = (context: StoreContext, pks: number[]): StoredHit[] => {
  if (pks.length === 0) return []
  const rows = new Map(
    selectHits(context)
      .where(inArray(messages.id, pks))
      .all()
      .map((row) => [row.pk, row]),
  )
  return toHits(
    context,
    pks.flatMap((pk) => rows.get(pk) ?? []),
  )
}

const perChatNewest = (context: StoreContext, where: SQL | undefined, wanted: number) => {
  const ranked = selectRanked(context).where(where).as("ranked")
  return context.orm
    .select()
    .from(ranked)
    .where(lte(ranked.chatRank, wanted))
    .orderBy(desc(ranked.sentAt), desc(ranked.pk))
    .all()
}

export const directReplies = (
  context: StoreContext,
  parents: { account: AccountKey; chatId: string; id: string }[],
  limit: number,
): Page<StoredHit> => {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100 || parents.length > 300)
    throw new CliError("validation_error", "direct reply lookup needs 1–100 results and at most 300 parents")
  if (!parents.length) return { items: [], hasMore: false }
  const rows = context.database
    .prepare(`
    SELECT DISTINCT m.id, length(cast(m.text AS BLOB)) AS bytes FROM json_each(?) requested
    JOIN accounts ac ON ac.provider=json_extract(requested.value,'$.account.provider')
      AND ac.external_id=json_extract(requested.value,'$.account.account')
    JOIN chats c ON c.account_id=ac.id AND c.external_id=json_extract(requested.value,'$.chatId')
    JOIN messages parent ON parent.chat_id=c.id AND parent.external_id=json_extract(requested.value,'$.id')
    JOIN messages m INDEXED BY messages_by_reply ON m.chat_id=c.id AND m.reply_to_external_id=parent.external_id
    WHERE m.deleted_at IS NULL AND parent.deleted_at IS NULL AND m.reply_to_external_id IS NOT NULL
    ORDER BY cast(requested.key AS INTEGER), m.id LIMIT ?
  `)
    .all(JSON.stringify(parents), limit + 1)
  if (rows.slice(0, limit).reduce((sum, row) => sum + Number(row.bytes), 0) > QUERY_LIMITS.bodyBytes)
    exhausted("bodyBytes")
  return {
    items: hitsByPk(
      context,
      rows.slice(0, limit).map((r) => Number(r.id)),
    ),
    hasMore: rows.length > limit,
  }
}
