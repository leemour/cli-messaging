import { setTimeout } from "node:timers/promises"
import type { Link, LinkInput } from "../../conversations/link.js"
import type { Id, Message, Page } from "../../domain/models.js"
import type { ConversationBuild, ConversationSummary, StoredLink } from "../store.js"
import { and, asc, desc, eq, isNull, type SQL, sql } from "./drizzle/core.js"
import { linkKind } from "./link-kinds.js"
import type { StoreContext } from "./open.js"
import { selectMessages, toMessages } from "./reads.js"
import {
  accounts,
  chats,
  chunkMessages,
  chunks as chunkRows,
  conversationMessages,
  conversationState,
  conversations,
  identities,
  messageLinks,
  messages,
} from "./schema.js"
import { toIso } from "./values.js"
import { purgeVectorHashes } from "./vectors.js"

const position = (sentAt: number, pk: number) => `${sentAt}:${pk}`

/** A chat's live messages for the rules, oldest first, a page at a time; `next` continues it. */
export const linkInputs = (
  { orm }: StoreContext,
  chatKey: number,
  { after, limit }: { after?: string; limit: number },
): { items: LinkInput[]; next: string | null } => {
  const [sentAt, pk] = (after ?? "").split(":").map(Number)
  const rows = orm
    .select({
      pk: messages.id,
      id: messages.externalId,
      senderId: sql<string | null>`coalesce(${messages.senderChatExternalId}, ${identities.externalId})`,
      senderName: messages.senderName,
      text: messages.text,
      sentAt: messages.sentAt,
      replyToId: messages.replyToExternalId,
      threadId: messages.threadExternalId,
      mentions: messages.mentions,
    })
    .from(messages)
    .leftJoin(identities, eq(identities.id, messages.senderIdentityId))
    .where(
      and(
        eq(messages.chatId, chatKey),
        isNull(messages.deletedAt),
        after === undefined ? undefined : sql`(${messages.sentAt}, ${messages.id}) > (${sentAt}, ${pk})`,
      ),
    )
    .orderBy(asc(messages.sentAt), asc(messages.id))
    .limit(limit)
    .all()
  const last = rows.at(-1)
  return {
    items: rows.map((row) => ({
      id: row.id,
      senderId: row.senderId,
      senderName: row.senderName,
      text: row.text,
      timestamp: toIso(row.sentAt) as string,
      ...(row.replyToId === null ? {} : { replyToId: row.replyToId }),
      ...(row.threadId === null ? {} : { threadId: row.threadId }),
      ...(row.mentions === null ? {} : { mentions: JSON.parse(row.mentions) as Id[] }),
    })),
    next: rows.length === limit && last ? position(last.sentAt, last.pk) : null,
  }
}

/** The usernames of everyone who wrote in the chat, lowercased, to their id: what a mention names. */
export const senderHandles = ({ orm }: StoreContext, chatKey: number): Map<string, Id> =>
  new Map(
    orm
      .selectDistinct({ username: identities.username, id: identities.externalId })
      .from(messages)
      .innerJoin(identities, eq(identities.id, messages.senderIdentityId))
      .where(and(eq(messages.chatId, chatKey), sql`${identities.username} IS NOT NULL`))
      .all()
      .map(({ username, id }) => [String(username).toLowerCase(), id]),
  )

const inChat = (chatKey: number) => eq(messageLinks.chatId, chatKey)

/**
 * A long write cut into short transactions with a pause between them. Without the pause the next
 * `BEGIN IMMEDIATE` wins the lock again at once: a process waiting for it sleeps up to 100 ms at a time
 * and, measured, waited out the whole build (1.8 s of 1.9 s at 100k messages). It gives up at 5 s.
 * `work` writes one row per step, synchronously: nothing awaits while a transaction is open (D3).
 */
const inTurns = async ({ database }: StoreContext, work: Iterator<unknown>, { holdMs = 250, pauseMs = 120 } = {}) => {
  for (let done = false; !done; ) {
    database.exec("BEGIN IMMEDIATE")
    try {
      const since = performance.now()
      do done = work.next().done === true
      while (!done && performance.now() - since < holdMs)
      database.exec("COMMIT")
    } catch (error) {
      database.exec("ROLLBACK")
      throw error
    }
    if (!done) await setTimeout(pauseMs)
  }
}

const once = (body: () => void): Iterator<unknown> => ({
  next: () => {
    body()
    return { done: true, value: undefined }
  },
})

const highestBuild = ({ orm }: StoreContext, chatKey: number): number =>
  Number(
    orm
      .select({
        n: sql<number>`max(
          coalesce((SELECT max(${conversations.build}) FROM ${conversations} WHERE ${conversations.chatId} = ${chatKey}), 0),
          coalesce((SELECT max(${messageLinks.build}) FROM ${messageLinks} WHERE ${inChat(chatKey)}), 0),
          coalesce((SELECT ${conversationState.currentBuild} FROM ${conversationState}
            WHERE ${conversationState.chatId} = ${chatKey}), 0))`,
      })
      .from(sql`(SELECT 1)`)
      .get()?.n,
  )

/**
 * Plan C3–C4, corrected by NEED-475 A. The chat's provider and rule links and its conversations are
 * written under a new build number in short transactions; one more makes that build the one readers
 * see; older builds are then deleted, a batch at a time. Until the switch readers see the previous
 * build, so a failed build leaves it in place. Agent links have no build and stay; one whose message
 * or parent was edited or deleted after it was written is marked stale.
 */
export const replaceConversations = async (
  context: StoreContext,
  chatKey: number,
  { startedAt, algorithmVersion, links, conversations: groups, chunks = [], check }: ConversationBuild,
  batch = 5_000,
): Promise<void> => {
  const { orm, now } = context
  check?.()
  const oldHashes = orm.all<{ hash: string }>(
    sql`SELECT DISTINCT k.content_hash AS hash FROM chunks k JOIN conversations c ON k.chunkable_type = 'conversation' AND c.id = k.chunkable_id WHERE c.chat_id = ${chatKey}`,
  )
  const held = new Map(
    orm
      .select({
        id: messages.externalId,
        pk: messages.id,
        sentAt: messages.sentAt,
        text: messages.text,
        senderName: messages.senderName,
      })
      .from(messages)
      .where(eq(messages.chatId, chatKey))
      .all()
      .map((row) => [row.id, row]),
  )
  let build = 0
  await inTurns(
    context,
    once(() => {
      // By start time, so a build that started later is the newer one; never one already used.
      build = Math.max(startedAt, highestBuild(context, chatKey) + 1)
      orm.insert(conversationState).values({ chatId: chatKey, enabledAt: startedAt }).onConflictDoNothing().run()
    }),
  )

  const chunkScope = orm
    .select({ accountId: chats.accountId, scope: sql<string>`coalesce(${chats.scope}, ${accounts.scope})` })
    .from(chats)
    .innerJoin(accounts, eq(accounts.id, chats.accountId))
    .where(eq(chats.id, chatKey))
    .get()
  const project = context.database
    .prepare(
      `SELECT to_id FROM links WHERE from_type='chat' AND from_id=? AND to_type='project' AND kind=${linkKind("member-of")} AND confirmed=1 ORDER BY id LIMIT 1`,
    )
    .get(chatKey)

  const insertLink = orm
    .insert(messageLinks)
    .values({
      chatId: chatKey,
      messageId: sql.placeholder("messageId"),
      parentId: sql.placeholder("parentId"),
      source: sql.placeholder("source"),
      kind: sql.placeholder("kind"),
      confidence: sql.placeholder("confidence"),
      method: sql.placeholder("method"),
      version: String(algorithmVersion),
      createdAt: startedAt,
      updatedAt: startedAt,
      build,
    })
    .onConflictDoNothing()
    .prepare()
  const insertPiece = orm
    .insert(chunkRows)
    .values({
      chunkableType: "conversation",
      chunkableId: sql.placeholder("conversationId"),
      position: sql.placeholder("position"),
      startOffset: sql.placeholder("startOffset"),
      endOffset: sql.placeholder("endOffset"),
      contentHash: sql.placeholder("contentHash"),
      projectId: project ? Number(project.to_id) : null,
      accountId: chunkScope?.accountId ?? null,
      scope: chunkScope?.scope ?? null,
      occurredAt: sql.placeholder("occurredAt"),
      createdAt: startedAt,
      updatedAt: startedAt,
    })
    .returning({ id: chunkRows.id })
    .prepare()
  const insertRange = orm
    .insert(chunkMessages)
    .values({
      chunkId: sql.placeholder("chunkId"),
      firstMessageId: sql.placeholder("firstMessageId"),
      lastMessageId: sql.placeholder("lastMessageId"),
      textStart: sql.placeholder("textStart"),
      textEnd: sql.placeholder("textEnd"),
    })
    .prepare()
  const insertMember = orm
    .insert(conversationMessages)
    .values({ conversationId: sql.placeholder("conversationId"), messageId: sql.placeholder("messageId") })
    .prepare()
  await inTurns(
    context,
    (function* () {
      for (const link of links) {
        check?.()
        const message = held.get(link.messageId)
        const parent = held.get(link.parentId)
        if (!message || !parent) continue
        insertLink.run(row(link, message.pk, parent.pk))
        yield
      }
      for (const [index, ids] of groups.entries()) {
        check?.()
        const members = ids.flatMap((id) => held.get(id) ?? [])
        const first = members[0]
        if (!first) continue
        const created = orm
          .insert(conversations)
          .values({
            chatId: chatKey,
            build,
            firstMessageId: first.pk,
            firstAt: first.sentAt,
            lastAt: members.reduce((last, member) => Math.max(last, member.sentAt), first.sentAt),
            messageCount: members.length,
            builtAt: startedAt,
            createdAt: startedAt,
            updatedAt: startedAt,
            algorithmVersion,
          })
          .returning({ pk: conversations.id })
          .get()
        for (const member of members) {
          check?.()
          insertMember.run({ conversationId: created.pk, messageId: member.pk })
          yield
        }
        const offsets = new Map<string, { start: number; end: number; prefix: number }>()
        if ((chunks[index]?.length ?? 0) > 0) {
          let offset = 0
          for (const member of members) {
            const prefix = member.senderName ? member.senderName.length + 2 : 0
            offsets.set(member.id, { start: offset, end: offset + prefix + member.text.length, prefix })
            offset += prefix + member.text.length + 1
          }
        }
        for (const [ordinal, chunk] of (chunks[index] ?? []).entries()) {
          check?.()
          const from = held.get(chunk.firstId)
          const to = held.get(chunk.lastId)
          if (!from || !to) continue
          const row = insertPiece.get({
            conversationId: created.pk,
            position: ordinal,
            startOffset:
              (offsets.get(from.id)?.start ?? 0) +
              (chunk.range ? (offsets.get(from.id)?.prefix ?? 0) + chunk.range.start : 0),
            endOffset: chunk.range
              ? (offsets.get(to.id)?.start ?? 0) + (offsets.get(to.id)?.prefix ?? 0) + chunk.range.end
              : (offsets.get(to.id)?.end ?? 0),
            contentHash: chunk.hash,
            occurredAt: from.sentAt,
          })
          insertRange.run({
            chunkId: Number(row?.id),
            firstMessageId: from.pk,
            lastMessageId: to.pk,
            textStart: chunk.range?.start ?? null,
            textEnd: chunk.range?.end ?? null,
          })
          yield
        }
      }
    })(),
  )

  const changedSince = (end: SQL) => sql`(
    EXISTS (SELECT 1 FROM message_revisions r WHERE r.message_id = ${end} AND r.created_at > ${messageLinks.createdAt})
    OR EXISTS (SELECT 1 FROM messages d WHERE d.id = ${end} AND d.deleted_at > ${messageLinks.createdAt}))`
  await inTurns(
    context,
    once(() => {
      check?.()
      orm
        .update(messageLinks)
        .set({ staleAt: now() })
        .where(
          and(
            eq(messageLinks.source, "agent"),
            isNull(messageLinks.staleAt),
            inChat(chatKey),
            sql`(${changedSince(sql`${messageLinks.messageId}`)} OR ${changedSince(sql`${messageLinks.parentId}`)})`,
          ),
        )
        .run()
      // A slower build that started earlier and finishes later must not replace a newer one.
      orm
        .update(conversationState)
        .set({ currentBuild: build, builtAt: startedAt, algorithmVersion })
        .where(
          and(eq(conversationState.chatId, chatKey), sql`coalesce(${conversationState.currentBuild}, 0) < ${build}`),
        )
        .run()
      orm.run(
        sql`DELETE FROM chunks WHERE chunkable_type='conversation' AND chunkable_id IN (SELECT id FROM conversations WHERE chat_id=${chatKey} AND build < (SELECT current_build FROM conversation_state WHERE chat_id=${chatKey}))`,
      )
    }),
  )

  const current = sql`(SELECT ${conversationState.currentBuild} FROM ${conversationState}
    WHERE ${conversationState.chatId} = ${chatKey})`
  await inTurns(
    context,
    (function* () {
      for (;;) {
        const removed =
          orm
            .delete(conversations)
            .where(
              sql`${conversations.id} IN (SELECT ${conversations.id} FROM ${conversations}
              WHERE ${conversations.chatId} = ${chatKey} AND ${conversations.build} < ${current} LIMIT ${batch})`,
            )
            .returning({ pk: conversations.id })
            .all().length +
          orm
            .delete(messageLinks)
            .where(
              sql`rowid IN (SELECT rowid FROM ${messageLinks} WHERE ${messageLinks.chatId} = ${chatKey}
              AND ${messageLinks.build} < ${current} LIMIT ${batch})`,
            )
            .returning({ pk: messageLinks.messageId })
            .all().length
        if (removed === 0) return
        yield
      }
    })(),
  )
  purgeVectorHashes(
    context,
    oldHashes.map(({ hash }) => hash),
  )
}

const row = (link: Link, messagePk: number, parentPk: number) => ({
  messageId: messagePk,
  parentId: parentPk,
  source: link.source,
  kind: link.kind,
  confidence: link.confidence,
  method: link.method,
})

/** Only the build readers see; a newer one may be half written. */
const isCurrent = sql`${conversations.build} = (SELECT ${conversationState.currentBuild} FROM ${conversationState}
  WHERE ${conversationState.chatId} = ${conversations.chatId})`

const SUMMARY = {
  pk: conversations.id,
  chatId: chats.externalId,
  firstMessageId: messages.externalId,
  firstAt: conversations.firstAt,
  lastAt: conversations.lastAt,
  messageCount: conversations.messageCount,
  builtAt: conversations.builtAt,
  algorithmVersion: conversations.algorithmVersion,
  senders: sql<number>`(SELECT count(DISTINCT coalesce(m.sender_chat_external_id, m.sender_identity_id))
    FROM conversation_messages cm JOIN messages m ON m.id = cm.message_id WHERE cm.conversation_id = ${conversations.id})`,
}

const summaries = ({ orm }: StoreContext) =>
  orm
    .select(SUMMARY)
    .from(conversations)
    .innerJoin(chats, eq(chats.id, conversations.chatId))
    .innerJoin(messages, eq(messages.id, conversations.firstMessageId))

const toSummary = (row: {
  pk: number
  chatId: string
  firstMessageId: string
  firstAt: number
  lastAt: number
  messageCount: number
  builtAt: number
  algorithmVersion: number
  senders: number
}): ConversationSummary => ({
  id: String(row.pk),
  chatId: row.chatId,
  firstMessageId: row.firstMessageId,
  firstAt: toIso(row.firstAt) as string,
  lastAt: toIso(row.lastAt) as string,
  messageCount: row.messageCount,
  senders: Number(row.senders),
  builtAt: toIso(row.builtAt) as string,
  algorithmVersion: row.algorithmVersion,
})

/** Newest first. `after` and `before` bound when a conversation started. */
export const conversationPage = (
  context: StoreContext,
  chatKey: number,
  { limit, after, before }: { limit: number; after?: number; before?: number },
): { items: ConversationSummary[]; hasMore: boolean } => {
  const rows = summaries(context)
    .where(
      and(
        eq(conversations.chatId, chatKey),
        isCurrent,
        after === undefined ? undefined : sql`${conversations.firstAt} >= ${after}`,
        before === undefined ? undefined : sql`${conversations.firstAt} < ${before}`,
      ),
    )
    .orderBy(desc(conversations.firstAt), desc(conversations.id))
    .limit(limit + 1)
    .all()
  return { items: rows.slice(0, limit).map(toSummary), hasMore: rows.length > limit }
}

/** The current build's summaries of these conversations, by pk; another account's are left out. */
export const summariesOf = (
  context: StoreContext,
  accountKey: number,
  pks: number[],
): Map<number, ConversationSummary> =>
  new Map(
    pks.length === 0
      ? []
      : summaries(context)
          .where(
            and(
              sql`${conversations.id} IN (${sql.join(
                pks.map((pk) => sql`${pk}`),
                sql`, `,
              )})`,
              eq(chats.accountId, accountKey),
              isCurrent,
            ),
          )
          .all()
          .map((row) => [row.pk, toSummary(row)]),
  )

/** Its messages oldest first — only an account's own conversation. */
export const conversation = (
  context: StoreContext,
  accountKey: number,
  id: number,
): { summary: ConversationSummary; messages: Message[] } | undefined => {
  const found = summaries(context)
    .where(and(eq(conversations.id, id), eq(chats.accountId, accountKey), isCurrent))
    .get()
  if (!found) return undefined
  const rows = selectMessages(context)
    .where(
      and(
        isNull(messages.deletedAt),
        sql`${messages.id} IN (SELECT ${conversationMessages.messageId} FROM ${conversationMessages}
          WHERE ${conversationMessages.conversationId} = ${id})`,
      ),
    )
    .orderBy(asc(messages.sentAt), asc(messages.id))
    .all()
  return { summary: toSummary(found), messages: toMessages(context, rows) }
}

export const conversationOf = ({ orm }: StoreContext, chatKey: number, messageId: Id): string | undefined => {
  const found = orm
    .select({ pk: conversationMessages.conversationId })
    .from(conversationMessages)
    .innerJoin(messages, eq(messages.id, conversationMessages.messageId))
    .innerJoin(conversations, eq(conversations.id, conversationMessages.conversationId))
    .where(and(eq(messages.chatId, chatKey), eq(messages.externalId, messageId), isCurrent))
    .get()
  return found ? String(found.pk) : undefined
}

const staleLink = (chatKey: number) => sql<boolean>`(${messageLinks.staleAt} IS NOT NULL
  OR EXISTS (SELECT 1 FROM message_revisions r WHERE r.message_id IN (${messageLinks.messageId}, ${messageLinks.parentId})
    AND r.created_at >= ${messageLinks.createdAt})
  OR EXISTS (SELECT 1 FROM messages d WHERE d.id IN (${messageLinks.messageId}, ${messageLinks.parentId}) AND (d.deleted_at IS NOT NULL OR d.edited_at > ${messageLinks.createdAt}))
  OR (${messageLinks.source} = 'provider' AND ${messageLinks.kind} = 'reply' AND
    (SELECT m.reply_to_external_id FROM messages m WHERE m.id = ${messageLinks.messageId}) IS NOT
    (SELECT p.external_id FROM messages p WHERE p.id = ${messageLinks.parentId}))
  OR EXISTS (SELECT 1 FROM messages p WHERE p.id = ${messageLinks.parentId} AND p.chat_id <> ${chatKey}))`

const currentLink = (chatKey: number) => sql`(${messageLinks.build} IS NULL OR ${messageLinks.build} =
  (SELECT ${conversationState.currentBuild} FROM ${conversationState} WHERE ${conversationState.chatId} = ${chatKey}))`

/** Every link a message has, the messenger's first, then the strongest. */
export const linksOf = ({ orm }: StoreContext, chatKey: number, messageId: Id, limit?: number): StoredLink[] =>
  orm
    .select({
      parentId: sql<
        string | null
      >`(SELECT p.external_id FROM messages p WHERE p.id = ${messageLinks.parentId} AND p.chat_id = ${chatKey})`,
      source: messageLinks.source,
      kind: messageLinks.kind,
      confidence: messageLinks.confidence,
      method: messageLinks.method,
      version: messageLinks.version,
      createdAt: messageLinks.createdAt,
      stale: staleLink(chatKey),
    })
    .from(messageLinks)
    .innerJoin(messages, eq(messages.id, messageLinks.messageId))
    .where(and(eq(messages.chatId, chatKey), eq(messages.externalId, messageId), currentLink(chatKey)))
    .orderBy(
      sql`CASE ${messageLinks.source} WHEN 'provider' THEN 0 WHEN 'agent' THEN 1 ELSE 2 END`,
      desc(messageLinks.confidence),
      desc(messageLinks.createdAt),
      messageLinks.parentId,
    )
    .limit(limit ?? -1)
    .all()
    .map(({ createdAt, stale, ...link }) => ({
      ...link,
      source: link.source as StoredLink["source"],
      createdAt: toIso(createdAt) as string,
      stale: Boolean(stale),
    }))

/** Candidates only: the caller checks which parent each child chooses, using the same link reader. */
export const repliesTo = (
  { orm }: StoreContext,
  chatKey: number,
  messageId: Id,
  limit: number,
): Page<{ messageId: Id }> => {
  const rows = orm
    .select({ messageId: messages.externalId })
    .from(messageLinks)
    .innerJoin(messages, eq(messages.id, messageLinks.messageId))
    .where(
      and(
        eq(messages.chatId, chatKey),
        currentLink(chatKey),
        sql`${messageLinks.parentId} = (SELECT p.id FROM messages p WHERE p.chat_id = ${chatKey} AND p.external_id = ${messageId})`,
      ),
    )
    .orderBy(sql`${messageLinks}.rowid`)
    .limit(limit + 1)
    .all()
  return {
    items: [...new Map(rows.slice(0, limit).map((row) => [row.messageId, row])).values()],
    hasMore: rows.length > limit,
  }
}

export const stateOf = ({ orm }: StoreContext, chatKey: number) => {
  const found = orm.select().from(conversationState).where(eq(conversationState.chatId, chatKey)).get()
  return found
    ? {
        enabledAt: toIso(found.enabledAt) as string,
        builtAt: toIso(found.builtAt),
        algorithmVersion: found.algorithmVersion,
      }
    : undefined
}

/**
 * The user's agent's current answer per message (phase 4 plan A6): its parent, or `null` for "starts a
 * conversation". An answer whose message or parent was edited or deleted after it was written is left
 * out here already — a rebuild marks it stale only when it finishes.
 */
export const agentAnswers = ({ orm }: StoreContext, chatKey: number): Map<Id, Id | null> =>
  new Map(
    orm
      .all<{ id: string; parent: string | null }>(
        sql`SELECT m.external_id AS id, p.external_id AS parent FROM message_links l
          JOIN messages m ON m.id = l.message_id LEFT JOIN messages p ON p.id = l.parent_id
          WHERE l.chat_id = ${chatKey} AND l.source = 'agent' AND l.stale_at IS NULL
            AND NOT EXISTS (SELECT 1 FROM message_revisions r
              WHERE r.message_id IN (l.message_id, l.parent_id) AND r.created_at > l.created_at)
            AND NOT EXISTS (SELECT 1 FROM messages d
              WHERE d.id IN (l.message_id, l.parent_id) AND d.deleted_at > l.created_at)`,
      )
      .map(({ id, parent }) => [id, parent]),
  )
