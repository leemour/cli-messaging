import { CliError } from "@wirecat/cli-core"
import { chunkHash, cutChunks } from "../../conversations/chunks.js"
import { atomic } from "./atomic.js"
import { meetingReadSnapshot, positiveReadInteger } from "./meeting-reads.js"
import type { StoreContext } from "./open.js"
import { dot, saveVectors } from "./vectors.js"

interface Scope {
  accountId: number
  signal?: AbortSignal
}
interface TextBudget {
  maxRows?: number
  maxTextBytes?: number
}
export interface MeetingVectorHit {
  meetingId: number
  transcriptId: number
  firstPosition: number
  lastPosition: number
  hash: string
  score: number
}
export interface MeetingVectors {
  saveCurrent(
    model: string,
    dims: number,
    rows: { hash: string; vector: Float32Array }[],
    input: Scope,
  ): Promise<{ saved: number; skipped: number }>
  rebuild(
    input: Scope & TextBudget & { afterTranscriptId?: number; limit?: number },
  ): Promise<{ transcripts: number; chunks: number; hasMore: boolean; nextTranscriptId?: number }>
  chunksToEmbed(
    model: string,
    input: Scope & TextBudget & { afterHash?: string; limit: number },
  ): Promise<{ items: { hash: string; text: string }[]; hasMore: boolean; nextHash?: string }>
  nearest(
    model: string,
    query: Float32Array,
    input: Scope & TextBudget & { limit: number; maxChunks?: number; afterChunkId?: number },
  ): Promise<{
    items: MeetingVectorHit[]
    ranking: "scanned-candidates"
    scanned: number
    complete: boolean
    hasMore: boolean
    nextChunkId?: number
  }>
  status(input: Scope & { model: string }): Promise<{ chunks: number; embedded: number }>
}
const LIVE =
  "FROM chunks k JOIN meeting_transcripts t ON k.chunkable_type = 'meeting_transcript' AND t.id = k.chunkable_id JOIN meetings m ON m.id = t.meeting_id WHERE m.account_id = ? AND m.deleted_at IS NULL AND t.deleted_at IS NULL AND t.superseded_at IS NULL"
const limitOf = (value: number, name: string, max = 1000) => {
  positiveReadInteger(value, name)
  if (value > max) throw new CliError("validation_error", `${name} exceeds ${max}`)
  return value
}
const scope = (input: Scope) => {
  input.signal?.throwIfAborted()
  positiveReadInteger(input.accountId, "accountId")
}
const modelOf = (model: string) => {
  if (!model.trim() || model.length > 1000) throw new CliError("validation_error", "An explicit model is required")
}
const missing = (): never => {
  throw new CliError("not_found", "Current transcript not found")
}
const textOf = (
  context: StoreContext,
  accountId: number,
  transcriptId: number,
  budget: TextBudget,
  signal?: AbortSignal,
) => {
  const maxRows = limitOf(budget.maxRows ?? 10000, "maxRows", 100000)
  const maxBytes = limitOf(budget.maxTextBytes ?? 4 * 1024 * 1024, "maxTextBytes", 64 * 1024 * 1024)
  const parent =
    context.database
      .prepare(
        "SELECT m.id AS meeting_id FROM meeting_transcripts t JOIN meetings m ON m.id=t.meeting_id WHERE t.id=? AND m.account_id=? AND m.deleted_at IS NULL AND t.deleted_at IS NULL AND t.superseded_at IS NULL",
      )
      .get(transcriptId, accountId) ?? missing()
  const preflight = context.database
    .prepare(
      "SELECT count(*) AS n, coalesce(sum(coalesce(length(CAST(text AS BLOB)),0) + coalesce(length(CAST(speaker_name AS BLOB)),0) + 3),0) AS bytes FROM meeting_transcript_rows WHERE meeting_transcript_id=?",
    )
    .get(transcriptId)
  if (Number(preflight?.n ?? 0) > maxRows || Number(preflight?.bytes ?? 0) > maxBytes)
    throw new CliError("validation_error", "Transcript exceeds the vector text read budget")
  signal?.throwIfAborted()
  const rows = context.database
    .prepare(
      "SELECT position, speaker_name, text FROM meeting_transcript_rows WHERE meeting_transcript_id=? ORDER BY position LIMIT ?",
    )
    .all(transcriptId, maxRows)
  let text = ""
  const positions: { position: number; start: number; end: number }[] = []
  for (const row of rows) {
    signal?.throwIfAborted()
    const body = String(row.text)
    if (!body.trim()) continue
    const line = row.speaker_name == null ? body : `${String(row.speaker_name)}: ${body}`
    if (text) text += "\n"
    const start = text.length
    text += line
    positions.push({ position: Number(row.position), start, end: text.length })
  }
  return { text, positions, meetingId: Number(parent.meeting_id), readBytes: Number(preflight?.bytes ?? 0) }
}
const textLoader = (context: StoreContext, input: Scope & TextBudget) => {
  let remaining = limitOf(input.maxTextBytes ?? 4 * 1024 * 1024, "maxTextBytes", 64 * 1024 * 1024)
  const loaded = new Map<number, ReturnType<typeof textOf>>()
  return (id: number) => {
    const existing = loaded.get(id)
    if (existing) return existing
    if (remaining <= 0)
      throw new CliError("validation_error", "Vector operation exceeds its aggregate text read budget")
    const document = textOf(context, input.accountId, id, { ...input, maxTextBytes: remaining }, input.signal)
    remaining -= document.readBytes
    loaded.set(id, document)
    return document
  }
}
const chunkText = (
  context: StoreContext,
  accountId: number,
  row: Record<string, unknown>,
  budget: TextBudget,
  signal?: AbortSignal,
  loaded?: ReturnType<typeof textOf>,
) => {
  const document = loaded ?? textOf(context, accountId, Number(row.chunkable_id), budget, signal)
  const start = Number(row.start_offset),
    end = Number(row.end_offset)
  const text = document.text.slice(start, end)
  if (chunkHash(text) !== String(row.content_hash))
    throw new CliError("invalid_response", "Stored transcript chunk is stale; rebuild it explicitly")
  const cues = document.positions.filter((position) => position.end > start && position.start < end)
  return {
    text,
    meetingId: document.meetingId,
    firstPosition: cues[0]?.position ?? 0,
    lastPosition: cues.at(-1)?.position ?? 0,
  }
}
export const meetingVectorsOver = (context: StoreContext): MeetingVectors => ({
  async saveCurrent(model, dims, rows, input) {
    scope(input)
    modelOf(model)
    limitOf(dims, "dims", 65536)
    if (rows.length > 1000)
      throw new CliError("validation_error", "Vector save exceeds its batch or 16 MiB payload budget")
    for (const row of rows)
      if (
        !/^[a-f0-9]{64}$/.test(row.hash) ||
        !(row.vector instanceof Float32Array) ||
        row.vector.length !== dims ||
        row.vector.some((value) => !Number.isFinite(value))
      )
        throw new CliError("validation_error", "Vectors require content hashes, matching dimensions and finite values")
    if (rows.reduce((bytes, row) => bytes + row.vector.byteLength, 0) > 16 * 1024 * 1024)
      throw new CliError("validation_error", "Vector save exceeds its batch or 16 MiB payload budget")
    return atomic(context.database, () => {
      const unique = new Map(rows.map((row) => [row.hash, row]))
      const current = context.database
        .prepare(`SELECT DISTINCT k.content_hash ${LIVE} AND k.content_hash IN (SELECT value FROM json_each(?))`)
        .all(input.accountId, JSON.stringify([...unique.keys()]))
      const available = new Set(current.map((row) => String(row.content_hash)))
      const selected = [...unique.values()].filter(
        (row) =>
          available.has(row.hash) &&
          !context.database.prepare("SELECT 1 FROM embeddings WHERE model=? AND content_hash=?").get(model, row.hash),
      )
      input.signal?.throwIfAborted()
      saveVectors(context, model, dims, selected)
      input.signal?.throwIfAborted()
      return { saved: selected.length, skipped: rows.length - selected.length }
    })
  },
  async rebuild(input) {
    scope(input)
    const limit = limitOf(input.limit ?? 100, "limit")
    if (input.afterTranscriptId !== undefined) positiveReadInteger(input.afterTranscriptId, "afterTranscriptId")
    return atomic(context.database, () => {
      const found = context.database
        .prepare(
          "SELECT t.id,a.scope,NULL AS project_id,m.started_at FROM meeting_transcripts t JOIN meetings m ON m.id=t.meeting_id JOIN accounts a ON a.id=m.account_id WHERE m.account_id=? AND m.deleted_at IS NULL AND t.deleted_at IS NULL AND t.superseded_at IS NULL AND t.id>? ORDER BY t.id LIMIT ?",
        )
        .all(input.accountId, input.afterTranscriptId ?? 0, limit + 1)
      const selected = found.slice(0, limit)
      const load = textLoader(context, input)
      const prepared = selected.map((row) => ({
        row,
        text: load(Number(row.id)),
      }))
      let count = 0
      for (const { row, text } of prepared) {
        input.signal?.throwIfAborted()
        context.database
          .prepare("DELETE FROM chunks WHERE chunkable_type='meeting_transcript' AND chunkable_id=?")
          .run(Number(row.id))
        const chunks = cutChunks([{ id: String(row.id), sender: null, text: text.text }], undefined, () =>
          input.signal?.throwIfAborted(),
        )
        for (let index = 0; index < chunks.length; index++) {
          const chunk = chunks[index]
          if (!chunk) continue
          context.database
            .prepare(
              "INSERT INTO chunks (chunkable_type,chunkable_id,position,start_offset,end_offset,content_hash,scope,account_id,project_id,occurred_at,created_at,updated_at) VALUES ('meeting_transcript',?,?,?,?,?,?,?,?,?,?,?)",
            )
            .run(
              Number(row.id),
              index,
              chunk.range?.start ?? 0,
              chunk.range?.end ?? text.text.length,
              chunk.hash,
              row.scope == null ? null : String(row.scope),
              input.accountId,
              row.project_id == null ? null : Number(row.project_id),
              row.started_at == null ? null : Number(row.started_at),
              context.now(),
              context.now(),
            )
          count++
        }
      }
      context.database
        .prepare(
          "DELETE FROM embeddings WHERE EXISTS (SELECT 1 FROM chunks k WHERE k.content_hash=embeddings.content_hash AND k.chunkable_type='meeting_transcript' AND k.account_id=? AND NOT EXISTS (SELECT 1 FROM meeting_transcripts t JOIN meetings m ON m.id=t.meeting_id WHERE t.id=k.chunkable_id AND t.deleted_at IS NULL AND t.superseded_at IS NULL AND m.deleted_at IS NULL AND m.account_id=?)) AND NOT EXISTS (SELECT 1 FROM chunks k WHERE k.content_hash=embeddings.content_hash AND (k.chunkable_type <> 'meeting_transcript' OR k.account_id IS NOT ? OR EXISTS (SELECT 1 FROM meeting_transcripts t JOIN meetings m ON m.id=t.meeting_id WHERE t.id=k.chunkable_id AND t.deleted_at IS NULL AND t.superseded_at IS NULL AND m.deleted_at IS NULL AND m.account_id=?)))",
        )
        .run(input.accountId, input.accountId, input.accountId, input.accountId)
      context.database
        .prepare(
          "DELETE FROM chunks WHERE chunkable_type='meeting_transcript' AND account_id=? AND NOT EXISTS (SELECT 1 FROM meeting_transcripts t JOIN meetings m ON m.id=t.meeting_id WHERE t.id=chunks.chunkable_id AND t.deleted_at IS NULL AND t.superseded_at IS NULL AND m.deleted_at IS NULL AND m.account_id=?)",
        )
        .run(input.accountId, input.accountId)
      input.signal?.throwIfAborted()
      const hasMore = found.length > limit
      return {
        transcripts: selected.length,
        chunks: count,
        hasMore,
        ...(hasMore ? { nextTranscriptId: Number(selected.at(-1)?.id) } : {}),
      }
    })
  },
  async chunksToEmbed(model, input) {
    scope(input)
    modelOf(model)
    const limit = limitOf(input.limit, "limit")
    if (input.afterHash !== undefined && !/^[a-f0-9]{64}$/.test(input.afterHash))
      throw new CliError("validation_error", "afterHash must be a content hash")
    return meetingReadSnapshot(context.database, () => {
      const rows = context.database
        .prepare(
          `SELECT k.* ${LIVE} AND k.content_hash > ? AND NOT EXISTS (SELECT 1 FROM embeddings e WHERE e.model=? AND e.content_hash=k.content_hash) GROUP BY k.content_hash ORDER BY k.content_hash LIMIT ?`,
        )
        .all(input.accountId, input.afterHash ?? "", model, limit + 1)
      const load = textLoader(context, input)
      const items = rows.slice(0, limit).map((row) => ({
        hash: String(row.content_hash),
        text: chunkText(context, input.accountId, row, input, input.signal, load(Number(row.chunkable_id))).text,
      }))
      input.signal?.throwIfAborted()
      const hasMore = rows.length > limit
      return { items, hasMore, ...(hasMore ? { nextHash: items.at(-1)?.hash } : {}) }
    })
  },
  async nearest(model, query, input) {
    scope(input)
    modelOf(model)
    const limit = limitOf(input.limit, "limit"),
      maxChunks = limitOf(input.maxChunks ?? 1000, "maxChunks", 10000)
    if (!query.length || query.length > 65536 || Array.from(query).some((value) => !Number.isFinite(value)))
      throw new CliError("validation_error", "Query vector must have finite dimensions")
    if (input.afterChunkId !== undefined) positiveReadInteger(input.afterChunkId, "afterChunkId")
    return meetingReadSnapshot(context.database, () => {
      const selectedSql = `${LIVE.replace(" WHERE", " JOIN embeddings e ON e.content_hash=k.content_hash AND e.model=? WHERE")} AND k.id>? ORDER BY k.id LIMIT ?`
      const params = [model, input.accountId, input.afterChunkId ?? 0, maxChunks + 1]
      const preflight = context.database
        .prepare(
          `SELECT coalesce(sum(n),0) AS bytes, coalesce(sum(bad),0) AS bad FROM (SELECT length(e.vector) AS n, (e.dims != ? OR length(e.vector) != ?) AS bad ${selectedSql})`,
        )
        .get(query.length, query.length * 4, ...params)
      if (Number(preflight?.bad ?? 0) || Number(preflight?.bytes ?? 0) > 16 * 1024 * 1024)
        throw new CliError("validation_error", "Stored vectors exceed the dimension or 16 MiB scan budget")
      input.signal?.throwIfAborted()
      const rows = context.database
        .prepare(
          `SELECT k.*,e.dims,e.vector ${LIVE.replace(" WHERE", " JOIN embeddings e ON e.content_hash=k.content_hash AND e.model=? WHERE")} AND k.id>? ORDER BY k.id LIMIT ?`,
        )
        .all(model, input.accountId, input.afterChunkId ?? 0, maxChunks + 1)
      const selected = rows.slice(0, maxChunks)
      const load = textLoader(context, input)
      const items = selected
        .map((row) => {
          input.signal?.throwIfAborted()
          if (
            Number(row.dims) !== query.length ||
            !(row.vector instanceof Uint8Array) ||
            row.vector.byteLength !== query.length * 4
          )
            throw new CliError("validation_error", "Stored vector dimensions do not match query")
          const text = chunkText(context, input.accountId, row, input, input.signal, load(Number(row.chunkable_id)))
          const score = dot(query, row.vector)
          if (!Number.isFinite(score))
            throw new CliError("invalid_response", "Stored vector contains non-finite values")
          return {
            meetingId: text.meetingId,
            transcriptId: Number(row.chunkable_id),
            firstPosition: text.firstPosition,
            lastPosition: text.lastPosition,
            hash: String(row.content_hash),
            score,
          }
        })
        .sort((a, b) => b.score - a.score || a.transcriptId - b.transcriptId)
        .slice(0, limit)
      const hasMore = rows.length > maxChunks
      return {
        items,
        ranking: "scanned-candidates" as const,
        scanned: selected.length,
        complete: !hasMore && input.afterChunkId === undefined,
        hasMore,
        ...(hasMore ? { nextChunkId: Number(selected.at(-1)?.id) } : {}),
      }
    })
  },
  async status(input) {
    scope(input)
    modelOf(input.model)
    const row = context.database
      .prepare(
        `SELECT count(DISTINCT k.content_hash) AS chunks,count(DISTINCT CASE WHEN EXISTS (SELECT 1 FROM embeddings e WHERE e.model=? AND e.content_hash=k.content_hash) THEN k.content_hash END) AS embedded ${LIVE}`,
      )
      .get(input.model, input.accountId)
    return { chunks: Number(row?.chunks ?? 0), embedded: Number(row?.embedded ?? 0) }
  },
})
