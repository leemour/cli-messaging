import { createHash } from "node:crypto"
import { CliError } from "@wirecat/cli-core"
import type { MeetingSearchOptions, MeetingSearchStore, SearchHit } from "@wirecat/cli-meetings"
import type { SqlValue } from "../driver.js"
import { normalize } from "../normalize.js"
import { checkMeetingCancelled } from "./meeting-operation.js"
import { meetingReadSnapshot, positiveReadInteger } from "./meeting-reads.js"
import { indexedText } from "./meetings.js"
import type { StoreContext } from "./open.js"

interface Cursor {
  version: 1
  key: string
  started: number
  meeting: number
  kind: number
  id: number
}
const fail = (message: string): never => {
  throw new CliError("validation_error", message)
}
const timestamp = (value: number | undefined): void => {
  if (value !== undefined && (!Number.isSafeInteger(value) || Math.abs(value) > 8640000000000000))
    fail("Invalid meeting search timestamp")
}
const fingerprint = (query: string, input: MeetingSearchOptions): string =>
  createHash("sha256")
    .update(JSON.stringify([query, input.accountId, input.meetingId ?? null, input.since ?? null, input.until ?? null]))
    .digest("hex")
const cursorOf = (value: string | undefined, key: string): Cursor | null => {
  if (value === undefined) return null
  if (typeof value !== "string" || value.length > 1000 || !/^[A-Za-z0-9_-]+$/.test(value))
    return fail("Invalid meeting search cursor")
  let parsed: Cursor
  try {
    parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Cursor
  } catch {
    return fail("Invalid meeting search cursor")
  }
  if (
    parsed?.version !== 1 ||
    parsed.key !== key ||
    !Number.isSafeInteger(parsed.started) ||
    Math.abs(parsed.started) > 8640000000000000 ||
    !Number.isSafeInteger(parsed.meeting) ||
    parsed.meeting <= 0 ||
    !Number.isSafeInteger(parsed.id) ||
    parsed.id <= 0 ||
    !Number.isInteger(parsed.kind) ||
    parsed.kind < 0 ||
    parsed.kind > 2
  )
    return fail("Meeting search cursor does not match this query and account")
  return parsed
}
const fields = ["title", "overview", "sections", "next_steps", "content"]
const bytes = (alias: string, columns: string[]): string =>
  columns.map((column) => `coalesce(length(CAST(${alias}.${column} AS BLOB)),0)`).join("+")
export function meetingHitSearchOver({ database }: StoreContext): MeetingSearchStore {
  return {
    async searchHits(rawQuery, original) {
      const input = { ...original }
      checkMeetingCancelled(input.signal)
      positiveReadInteger(input.accountId, "accountId")
      if (input.meetingId !== undefined) positiveReadInteger(input.meetingId, "meetingId")
      timestamp(input.since)
      timestamp(input.until)
      if (input.since !== undefined && input.until !== undefined && input.until < input.since)
        fail("Meeting search dates must be ordered")
      const limit = input.limit ?? 100
      const maxReadBytes = input.maxReadBytes ?? 4 * 1024 ** 2
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000)
        fail("Meeting search limit must be from 1 through 1000")
      if (!Number.isSafeInteger(maxReadBytes) || maxReadBytes < 1 || maxReadBytes > 64 * 1024 ** 2)
        fail("Meeting search byte limit must be from 1 through 67108864")
      if (typeof rawQuery !== "string" || Buffer.byteLength(rawQuery) > 65536)
        fail("Meeting search query must be a bounded string")
      const words = normalize(rawQuery)
        .split(/[^\p{L}\p{N}]+/u)
        .filter(Boolean)
      if (words.length > 128) fail("Meeting search supports at most 128 query words")
      const query = words.map((word) => `"${word}"*`).join(" AND ")
      const key = fingerprint(query, input)
      const after = cursorOf(input.after, key)
      return meetingReadSnapshot(database, () => {
        checkMeetingCancelled(input.signal)
        const pending = database
          .prepare(`SELECT 1 FROM meeting_index_pending p
          LEFT JOIN meeting_transcript_rows r ON p.indexable_type='meeting_transcript_row' AND r.id=p.id
          LEFT JOIN meeting_transcripts t ON t.id=r.meeting_transcript_id
          LEFT JOIN meeting_chat_messages c ON p.indexable_type='meeting_chat_message' AND c.id=p.id
          LEFT JOIN meeting_summaries s ON p.indexable_type='meeting_summary' AND s.id=p.id
          JOIN meetings m ON m.id=coalesce(t.meeting_id,c.meeting_id,s.meeting_id)
          WHERE m.account_id=? AND m.deleted_at IS NULL AND
          (p.indexable_type!='meeting_transcript_row' OR (t.deleted_at IS NULL AND t.superseded_at IS NULL)) LIMIT 1`)
          .get(input.accountId)
        const coverage = {
          archiveCompleteness: "unknown" as const,
          currentRevisions: true as const,
          indexing: pending ? ("pending" as const) : ("ready" as const),
          indexCompleteness: "unknown" as const,
        }
        if (!query) return { items: [], hasMore: false, nextCursor: null, coverage }
        const clauses = ["m.account_id=?", "m.deleted_at IS NULL"]
        const params: SqlValue[] = [input.accountId]
        if (input.meetingId !== undefined) {
          clauses.push("m.id=?")
          params.push(input.meetingId)
        }
        if (input.since !== undefined) {
          clauses.push("m.started_at>=?")
          params.push(input.since)
        }
        if (input.until !== undefined) {
          clauses.push("m.started_at<=?")
          params.push(input.until)
        }
        const seek = after
          ? "WHERE started<? OR (started=? AND (meeting_id>? OR (meeting_id=? AND (kind>? OR (kind=? AND id>?)))))"
          : ""
        if (after)
          params.push(after.started, after.started, after.meeting, after.meeting, after.kind, after.kind, after.id)
        const sql = `WITH matching AS (SELECT rowid AS rid FROM meeting_words WHERE meeting_words MATCH ?), selected AS (SELECT m.id,coalesce(m.started_at,0) AS started FROM meetings m WHERE ${clauses.join(" AND ")}), hits AS (
        SELECT m.started,m.id AS meeting_id,0 AS kind,r.id,r.start_ms,${bytes("r", ["text"])} AS bytes FROM matching h JOIN meeting_transcript_rows r ON h.rid%4=1 AND r.id=h.rid/4 JOIN meeting_transcripts t ON t.id=r.meeting_transcript_id AND t.superseded_at IS NULL AND t.deleted_at IS NULL JOIN selected m ON m.id=t.meeting_id
        UNION ALL SELECT m.started,m.id,1,c.id,NULL,${bytes("c", ["text"])} FROM matching h JOIN meeting_chat_messages c ON h.rid%4=2 AND c.id=h.rid/4 JOIN selected m ON m.id=c.meeting_id
        UNION ALL SELECT m.started,m.id,2,s.id,NULL,${bytes("s", fields)} FROM matching h JOIN meeting_summaries s ON h.rid%4=3 AND s.id=h.rid/4 JOIN selected m ON m.id=s.meeting_id)
        SELECT * FROM hits ${seek} ORDER BY started DESC,meeting_id,kind,id LIMIT ?`
        const rows = database.prepare(sql).all(`normalized_text : (${query})`, ...params, limit + 1)
        let total = 0
        for (const row of rows) {
          const size = Number(row.bytes)
          if (!Number.isSafeInteger(size) || size < 0) fail("Invalid stored meeting search text size")
          total += size
          if (total > maxReadBytes) fail("Meeting search exceeds its stored text byte budget")
        }
        checkMeetingCancelled(input.signal)
        const items = rows.slice(0, limit).map((row): SearchHit => {
          const kind = Number(row.kind)
          let text: string
          if (kind === 2) {
            try {
              text = indexedText(database, "meeting_summary", Number(row.id)) ?? ""
            } catch {
              throw new CliError("invalid_response", "Stored meeting summary has invalid structured text")
            }
          } else {
            const table = kind === 0 ? "meeting_transcript_rows" : "meeting_chat_messages"
            text = String(database.prepare(`SELECT text FROM ${table} WHERE id=?`).get(Number(row.id))?.text)
          }
          return {
            meetingId: Number(row.meeting_id),
            scope: kind === 0 ? "transcript" : kind === 1 ? "chat" : "summary",
            id: Number(row.id),
            text,
            startMs: row.start_ms === null ? null : Number(row.start_ms),
          }
        })
        const last = rows[limit - 1]
        const hasMore = rows.length > limit
        const nextCursor =
          hasMore && last
            ? Buffer.from(
                JSON.stringify({
                  version: 1,
                  key,
                  started: Number(last.started),
                  meeting: Number(last.meeting_id),
                  kind: Number(last.kind),
                  id: Number(last.id),
                }),
              ).toString("base64url")
            : null
        return { items, hasMore, nextCursor, coverage }
      })
    },
  }
}
