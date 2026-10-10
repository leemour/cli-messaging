import { chunkHash, chunkTextOf, type TextRange } from "../../conversations/chunks.js"
import { type SQL, sql } from "./drizzle/core.js"
import type { StoreContext } from "./open.js"

/** A chunk of the chat's current build: its hash, and the messages its text is cut from. */
export interface ChunkToEmbed {
  hash: string
  lines: { id: string; sender: string | null; text: string }[]
}

const currentChunks = (
  chatKey: number,
) => sql`SELECT k.content_hash, k.chunkable_id AS conversation_id, r.first_message_id,
    r.last_message_id, r.text_start, r.text_end FROM chunks k JOIN chunk_messages r ON r.chunk_id = k.id
    JOIN conversations c ON k.chunkable_type = 'conversation' AND c.id = k.chunkable_id
  WHERE c.chat_id = ${chatKey}
    AND c.build = (SELECT s.current_build FROM conversation_state s WHERE s.chat_id = ${chatKey})`

/**
 * Chunks of the current build with no vector of `model`, ordered by hash from `after`, each with the
 * messages its text is cut from — the text itself is never stored, so it is read again here.
 */
export const chunksToEmbed = (
  { orm }: StoreContext,
  chatKey: number,
  model: string,
  { after, limit }: { after?: string; limit: number },
): ChunkToEmbed[] => {
  const chunks = orm.all<{
    hash: string
    conversation: number
    first: number
    last: number
    start: number | null
    end: number | null
  }>(
    sql`SELECT k.content_hash AS hash, min(k.conversation_id) AS conversation, k.first_message_id AS first,
        k.last_message_id AS last, k.text_start AS start, k.text_end AS end
      FROM (${currentChunks(chatKey)}) k
      WHERE k.content_hash > ${after ?? ""}
        AND NOT EXISTS (SELECT 1 FROM embeddings v WHERE v.model = ${model} AND v.content_hash = k.content_hash)
      GROUP BY k.content_hash ORDER BY k.content_hash LIMIT ${limit}`,
  )
  return chunks.map(({ hash, conversation, first, last, start, end }) => {
    const range = rangeOf(start, end)
    return {
      hash,
      lines: chunkLines(orm, conversation, first, last).flatMap(({ deleted, ...line }) =>
        deleted ? [] : [range === undefined ? line : { ...line, text: line.text.slice(range.start, range.end) }],
      ),
    }
  })
}

const rangeOf = (start: number | null, end: number | null): TextRange | undefined =>
  start === null || end === null ? undefined : { start, end }

/** A chunk's messages as they are now, the deleted ones flagged: what `embed` hashes and a search checks. */
const chunkLines = (orm: StoreContext["orm"], conversation: number, first: number, last: number) =>
  orm
    .all<{ id: string; sender: string | null; text: string; deleted: number }>(
      sql`SELECT m.external_id AS id, m.sender_name AS sender, m.text, m.deleted_at IS NOT NULL AS deleted
        FROM conversation_messages cm
        JOIN messages m ON m.id = cm.message_id
        JOIN messages f ON f.id = ${first} JOIN messages l ON l.id = ${last}
        WHERE cm.conversation_id = ${conversation}
          AND (m.sent_at, m.id) >= (f.sent_at, f.id) AND (m.sent_at, m.id) <= (l.sent_at, l.id)
        ORDER BY m.sent_at, m.id`,
    )
    .map(({ deleted, ...line }) => ({ ...line, deleted: Boolean(deleted) }))

/**
 * Whether a found chunk still says what its vector encodes. A build never makes a deleted message a member,
 * so any deleted one in range went after the build: the hit goes, whatever text is left (NEED-393, NEED-550).
 */
export const chunkFreshness = (
  { orm }: StoreContext,
  { conversationPk, firstMessagePk, lastMessagePk, hash, range }: NearestChunk,
): "current" | "stale" | "deleted" => {
  const lines = chunkLines(orm, conversationPk, firstMessagePk, lastMessagePk)
  if (lines.some(({ deleted }) => deleted)) return "deleted"
  return chunkHash(chunkTextOf(lines, range)) === hash ? "current" : "stale"
}

/**
 * Drops every vector of a chunk that held this just-deleted message, of every model, unless a current chunk
 * with no deleted message or any other corpus chunk still uses its text: vectors are keyed by text alone.
 */
export const purgeVectorHashes = (context: StoreContext, hashes: readonly string[]): void => {
  const { orm } = context
  for (const hash of new Set(hashes)) {
    let offset = 0
    let valid = false
    for (;;) {
      const candidates = orm.all<{
        conversation: number
        first: number
        last: number
        start: number | null
        end: number | null
      }>(sql`SELECT k.chunkable_id AS conversation, r.first_message_id AS first,
        r.last_message_id AS last, r.text_start AS start, r.text_end AS end
        FROM chunks k JOIN chunk_messages r ON r.chunk_id = k.id
        JOIN conversations c ON k.chunkable_type = 'conversation' AND c.id = k.chunkable_id
        JOIN conversation_state s ON s.chat_id = c.chat_id AND s.current_build = c.build
        WHERE k.content_hash = ${hash} ORDER BY k.chunkable_id, k.position LIMIT 100 OFFSET ${offset}`)
      valid = candidates.some(({ conversation, first, last, start, end }) => {
        const lines = chunkLines(orm, conversation, first, last)
        return !lines.some(({ deleted }) => deleted) && chunkHash(chunkTextOf(lines, rangeOf(start, end))) === hash
      })
      if (valid || candidates.length < 100) break
      offset += candidates.length
      if (offset >= 1000) {
        valid = true
        break
      }
    }
    if (!valid)
      orm.run(sql`DELETE FROM embeddings WHERE content_hash = ${hash}
        AND NOT EXISTS (SELECT 1 FROM chunks WHERE content_hash = ${hash} AND chunkable_type <> 'conversation')`)
  }
}

export const purgeVectorsOf = (context: StoreContext, messagePk: number): void => {
  const hashes = context.orm.all<{ hash: string }>(sql`SELECT DISTINCT k.content_hash AS hash
    FROM conversation_messages cm JOIN messages m ON m.id = cm.message_id
    JOIN chunks k ON k.chunkable_type = 'conversation' AND k.chunkable_id = cm.conversation_id
    JOIN chunk_messages r ON r.chunk_id = k.id
    JOIN messages f ON f.id = r.first_message_id JOIN messages l ON l.id = r.last_message_id
    WHERE cm.message_id = ${messagePk}
      AND (m.sent_at, m.id) >= (f.sent_at, f.id) AND (m.sent_at, m.id) <= (l.sent_at, l.id)`)
  purgeVectorHashes(
    context,
    hashes.map(({ hash }) => hash),
  )
}

/**
 * A conversation's chunks of the current build, and the vectors of `model` that still say what its chunks say:
 * a changed or deleted message leaves its chunk out, so the conversation is described as it is now.
 */
export const conversationVectors = (
  context: StoreContext,
  conversationPk: number,
  model: string,
): { chunks: number; vectors: Float32Array[] } => {
  const rows = context.orm.all<{
    first: number
    last: number
    start: number | null
    end: number | null
    hash: string
    vector: Uint8Array | null
  }>(
    sql`SELECT r.first_message_id AS first, r.last_message_id AS last, r.text_start AS start, r.text_end AS end,
        k.content_hash AS hash, v.vector
      FROM chunks k JOIN chunk_messages r ON r.chunk_id = k.id
      JOIN conversations c ON k.chunkable_type = 'conversation' AND c.id = k.chunkable_id
      JOIN conversation_state s ON s.chat_id = c.chat_id AND s.current_build = c.build
      LEFT JOIN embeddings v ON v.model = ${model} AND v.content_hash = k.content_hash
      WHERE k.chunkable_type = 'conversation' AND k.chunkable_id = ${conversationPk} ORDER BY k.position`,
  )
  const vectors = rows.flatMap(({ first, last, start, end, hash, vector }) =>
    vector &&
    chunkFreshness(context, {
      conversationPk,
      firstMessagePk: first,
      lastMessagePk: last,
      ...(rangeOf(start, end) ? { range: rangeOf(start, end) } : {}),
      hash,
      score: 0,
    }) === "current"
      ? [new Float32Array(vector.buffer.slice(vector.byteOffset, vector.byteOffset + vector.byteLength))]
      : [],
  )
  return { chunks: rows.length, vectors }
}

/** A vector already there for the same model and text is kept: the same text gives the same vector. */
export const saveVectors = (
  { orm, now }: StoreContext,
  model: string,
  dims: number,
  vectors: { hash: string; vector: Float32Array }[],
): void => {
  const at = now()
  for (const { hash, vector } of vectors) {
    orm.run(
      sql`INSERT INTO embeddings (model, content_hash, dims, vector, created_at, updated_at)
        VALUES (${model}, ${hash}, ${dims}, ${Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength)}, ${at}, ${at})
        ON CONFLICT DO NOTHING`,
    )
  }
}

/** The current build's distinct chunk texts, and how many of them have a vector of `model`. */
export const vectorStatus = ({ orm }: StoreContext, chatKey: number, model: string) => {
  const row = orm.get<{ chunks: number; embedded: number }>(
    sql`SELECT count(*) AS chunks, sum(EXISTS (SELECT 1 FROM embeddings v
        WHERE v.model = ${model} AND v.content_hash = k.content_hash)) AS embedded
      FROM (SELECT DISTINCT content_hash FROM (${currentChunks(chatKey)})) k`,
  )
  return { chunks: Number(row?.chunks ?? 0), embedded: Number(row?.embedded ?? 0) }
}

/**
 * Drops the vectors of the chat's chunks, or only one model's — but not one another chat's chunk still
 * points at: the same text in two chats has one vector. Messages are never touched.
 */
export const clearVectors = ({ orm }: StoreContext, chatKey: number, model: string | undefined): number =>
  orm.all<{ n: number }>(
    sql`DELETE FROM embeddings
      WHERE ${model === undefined ? sql`1` : sql`model = ${model}`}
        AND content_hash IN (SELECT k.content_hash FROM chunks k
          JOIN conversations c ON k.chunkable_type = 'conversation' AND c.id = k.chunkable_id WHERE c.chat_id = ${chatKey})
        AND content_hash NOT IN (SELECT k.content_hash FROM chunks k
          LEFT JOIN conversations c ON k.chunkable_type = 'conversation' AND c.id = k.chunkable_id
          WHERE c.id IS NULL OR c.chat_id <> ${chatKey})
      RETURNING 1 AS n`,
  ).length

export interface NearestChunk {
  conversationPk: number
  firstMessagePk: number
  lastMessagePk: number
  /** The stretch of one long message, when the chunk is a piece of it. */
  range?: TextRange
  hash: string
  score: number
}

/** Rows read per step of a search, so a chat of any size is scanned in bounded memory. */
const SCAN_PAGE = 5_000

export const dot = (query: Float32Array, blob: Uint8Array): number => {
  const vector = new Float32Array(blob.buffer.slice(blob.byteOffset, blob.byteOffset + blob.byteLength))
  let sum = 0
  for (let index = 0; index < query.length; index++) sum += (query[index] as number) * (vector[index] as number)
  return sum
}

/**
 * The conversations of the current builds in scope nearest to `query`, best first: each scored by its
 * best chunk. Vectors are unit length, so the dot product is the cosine (phase 5 E3).
 */
export const nearestChunks = (
  { orm }: StoreContext,
  accountPk: number,
  {
    chatKey,
    model,
    since,
    limit,
    query,
    exclude,
    conversations,
    scope,
    projectId,
    before,
    personId,
  }: {
    chatKey?: number
    model: string
    since?: number
    limit: number
    query: Float32Array
    exclude?: number
    conversations?: string[]
    scope?: "personal" | "work"
    projectId?: number
    before?: number
    personId?: number
  },
): NearestChunk[] => {
  const best = new Map<number, NearestChunk>()
  let after = { conversation: 0, ordinal: -1 }
  for (;;) {
    const rows = orm.all<{
      conversation: number
      ordinal: number
      first: number
      last: number
      start: number | null
      end: number | null
      hash: string
      vector: Uint8Array
    }>(
      // CROSS JOIN keeps the chunks first, so each page walks their key; led by the vectors, SQLite re-read and
      // sorted every one of them per page — 1.3 s against 140 ms at 42k chunks (bench/embeddings/README.md).
      sql`SELECT k.chunkable_id AS conversation, k.position AS ordinal, r.first_message_id AS first, r.last_message_id AS last,
          r.text_start AS start, r.text_end AS end, k.content_hash AS hash, v.vector FROM chunks k
        CROSS JOIN conversations c ON c.id = k.chunkable_id
        JOIN chunk_messages r ON r.chunk_id = k.id
        JOIN conversation_state s ON s.chat_id = c.chat_id AND s.current_build = c.build
        JOIN chats ch ON ch.id = c.chat_id
        JOIN embeddings v ON v.model = ${model} AND v.content_hash = k.content_hash
        WHERE k.chunkable_type = 'conversation' AND ch.account_id = ${accountPk}
          ${scope === undefined ? sql`` : sql`AND k.scope=${scope}`}
          ${projectId === undefined ? sql`` : sql`AND k.project_id=${projectId}`}
          ${before === undefined ? sql`` : sql`AND k.occurred_at < ${before}`}
          ${personId === undefined ? sql`` : sql`AND EXISTS (SELECT 1 FROM conversation_messages pcm JOIN messages pm ON pm.id=pcm.message_id JOIN identity_links pil ON pil.identity_id=pm.sender_identity_id WHERE pcm.conversation_id=c.id AND pil.person_id=${personId})`}
          ${chatKey === undefined ? sql`` : sql`AND c.chat_id = ${chatKey}`}
          ${since === undefined ? sql`` : sql`AND k.occurred_at >= ${since}`}
          ${exclude === undefined ? sql`` : sql`AND c.id <> ${exclude}`}
          ${conversations === undefined ? sql`` : sql`AND c.id IN (SELECT value FROM json_each(${JSON.stringify(conversations)}))`}
          AND (k.chunkable_id, k.position) > (${after.conversation}, ${after.ordinal})
        ORDER BY k.chunkable_id, k.position LIMIT ${SCAN_PAGE}`,
    )
    for (const row of rows) {
      const score = dot(query, row.vector)
      const held = best.get(row.conversation)
      if (!held || score > held.score) {
        const range = rangeOf(row.start, row.end)
        best.set(row.conversation, {
          conversationPk: row.conversation,
          firstMessagePk: row.first,
          lastMessagePk: row.last,
          ...(range ? { range } : {}),
          hash: row.hash,
          score,
        })
      }
    }
    const last = rows.at(-1)
    if (!last || rows.length < SCAN_PAGE) break
    after = { conversation: last.conversation, ordinal: last.ordinal }
  }
  return [...best.values()].sort((a, b) => b.score - a.score).slice(0, limit)
}

const hasVectorOf = (models: ReturnType<typeof sql>) => sql`EXISTS (SELECT 1 FROM chunks k
    JOIN conversations c ON k.chunkable_type = 'conversation' AND c.id = k.chunkable_id
    JOIN conversation_state s ON s.chat_id = c.chat_id AND s.current_build = c.build
    JOIN embeddings v ON v.model ${models} AND v.content_hash = k.content_hash
    WHERE c.chat_id = ch.id)`

/** Chats in scope whose current build has vectors of another model and none of `model`: a search with it skips them. */
export const embeddedOnlyElsewhere = (
  { orm }: StoreContext,
  accountPk: number,
  { chatKey, model }: { chatKey?: number; model: string },
): string[] => {
  const others = orm
    .all<{ model: string }>(sql`SELECT DISTINCT model FROM embeddings WHERE model <> ${model}`)
    .map((row) => sql`${row.model}`)
  if (others.length === 0) return []
  return orm
    .all<{ id: string }>(
      sql`SELECT ch.external_id AS id FROM chats ch
        WHERE ch.account_id = ${accountPk} ${chatKey === undefined ? sql`` : sql`AND ch.id = ${chatKey}`}
          AND ${hasVectorOf(sql`IN (${sql.join(others, sql`, `)})`)}
          AND NOT ${hasVectorOf(sql`= ${model}`)}
        ORDER BY ch.external_id`,
    )
    .map(({ id }) => id)
}

/** The messenger's ids of these messages, by pk. */
export const messageIds = ({ orm }: StoreContext, pks: number[]): Map<number, string> =>
  new Map(
    pks.length === 0
      ? []
      : orm
          .all<{ pk: number; id: string }>(
            sql`SELECT id AS pk, external_id AS id FROM messages WHERE id IN (${sql.join(
              pks.map((pk) => sql`${pk}`),
              sql`, `,
            )})`,
          )
          .map(({ pk, id }) => [pk, id]),
  )

/** Chats of the account whose conversations were ever built, or started to be. */
export const builtChats = ({ orm }: StoreContext, accountPk: number): { chatKey: number; id: string }[] =>
  orm.all<{ chatKey: number; id: string }>(
    sql`SELECT ch.id AS chatKey, ch.external_id AS id FROM conversation_state s JOIN chats ch ON ch.id = s.chat_id
      WHERE ch.account_id = ${accountPk} ORDER BY ch.external_id`,
  )

/** Group chats of the account with stored messages and no build ever started, the newest message first. */
export const unbuiltGroups = ({ orm }: StoreContext, accountPk: number): string[] =>
  orm
    .all<{ id: string }>(
      sql`SELECT ch.external_id AS id FROM chats ch
        WHERE ch.account_id = ${accountPk} AND ch.kind = 'group'
          AND NOT EXISTS (SELECT 1 FROM conversation_state s WHERE s.chat_id = ch.id)
          AND EXISTS (SELECT 1 FROM messages m WHERE m.chat_id = ch.id AND m.deleted_at IS NULL)
        ORDER BY (SELECT max(m.sent_at) FROM messages m WHERE m.chat_id = ch.id) DESC, ch.external_id`,
    )
    .map(({ id }) => id)

/**
 * What the chat's current build has not seen, and its chunks for `model`. Membership is exact for new and
 * deleted messages; an edit is known only by its revision's time, so one in the build's first millisecond
 * counts as pending. A changed sender name leaves no trace and is not counted.
 */
export const readiness = ({ orm }: StoreContext, chatKey: number, model: string) => {
  const state = orm.get<{ builtAt: number | null; algorithmVersion: number | null; build: number | null }>(
    sql`SELECT built_at AS builtAt, algorithm_version AS algorithmVersion, current_build AS build
      FROM conversation_state WHERE chat_id = ${chatKey}`,
  )
  if (!state || state.builtAt === null || state.build === null) return undefined
  const { builtAt, build } = state
  const member = (pk: SQL) => sql`EXISTS (SELECT 1 FROM conversation_messages cm
    JOIN conversations c ON c.id = cm.conversation_id WHERE cm.message_id = ${pk} AND c.build = ${build})`
  const editedSince = (pk: SQL) =>
    sql`EXISTS (SELECT 1 FROM message_revisions r WHERE r.message_id = ${pk} AND r.created_at >= ${builtAt})`
  const pending = orm.get<{ new: number; edited: number; deleted: number }>(
    sql`SELECT
        sum(m.deleted_at IS NULL AND NOT ${member(sql`m.id`)}) AS new,
        sum(m.deleted_at IS NULL AND ${editedSince(sql`m.id`)} AND ${member(sql`m.id`)}) AS edited,
        sum(m.deleted_at IS NOT NULL AND ${member(sql`m.id`)}) AS deleted
      FROM messages m WHERE m.chat_id = ${chatKey}`,
  )
  const vectors = orm.get<{ chunks: number; embedded: number; current: number; stale: number }>(
    sql`WITH changed AS (SELECT m.id, m.sent_at, cm.conversation_id FROM messages m
          JOIN conversation_messages cm ON cm.message_id = m.id
          JOIN conversations c ON c.id = cm.conversation_id AND c.build = ${build}
          WHERE m.chat_id = ${chatKey} AND (m.deleted_at IS NOT NULL OR ${editedSince(sql`m.id`)})),
        stale AS (SELECT DISTINCT k.content_hash AS hash FROM changed g
          JOIN chunks k ON k.chunkable_type = 'conversation' AND k.chunkable_id = g.conversation_id
          JOIN chunk_messages r ON r.chunk_id = k.id
          JOIN messages f ON f.id = r.first_message_id JOIN messages l ON l.id = r.last_message_id
          WHERE (g.sent_at, g.id) >= (f.sent_at, f.id) AND (g.sent_at, g.id) <= (l.sent_at, l.id)),
        hashes AS (SELECT DISTINCT h.content_hash AS hash,
            EXISTS (SELECT 1 FROM embeddings v WHERE v.model = ${model} AND v.content_hash = h.content_hash) AS vector,
            h.content_hash IN (SELECT hash FROM stale) AS stale
          FROM (${currentChunks(chatKey)}) h)
      SELECT count(*) AS chunks, sum(vector) AS embedded, sum(vector AND NOT stale) AS current, sum(stale) AS stale
      FROM hashes`,
  )
  const chunks = Number(vectors?.chunks ?? 0)
  const current = Number(vectors?.current ?? 0)
  const stale = Number(vectors?.stale ?? 0)
  return {
    builtAt,
    algorithmVersion: state.algorithmVersion,
    pending: {
      new: Number(pending?.new ?? 0),
      edited: Number(pending?.edited ?? 0),
      deleted: Number(pending?.deleted ?? 0),
    },
    vectors: { chunks, embedded: Number(vectors?.embedded ?? 0), current, stale, missing: chunks - current - stale },
  }
}
