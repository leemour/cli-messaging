import { CliError } from "@wirecat/cli-core"
import type { MeetingSearchIndexStore } from "@wirecat/cli-meetings"
import { normalize } from "../normalize.js"
import { checkMeetingCancelled, meetingWriteSnapshot } from "./meeting-operation.js"
import { positiveReadInteger } from "./meeting-reads.js"
import { type INDEX_CODES, indexedText, meetingRowid } from "./meetings.js"
import type { StoreContext } from "./open.js"

const summaryBytes = ["title", "overview", "sections", "next_steps", "content"]
  .map((key) => `coalesce(length(CAST(s.${key} AS BLOB)),0)`)
  .join("+")
const queue = `FROM meeting_index_pending p
 LEFT JOIN meeting_transcript_rows r ON p.indexable_type='meeting_transcript_row' AND r.id=p.id
 LEFT JOIN meeting_transcripts t ON t.id=r.meeting_transcript_id
 LEFT JOIN meeting_chat_messages c ON p.indexable_type='meeting_chat_message' AND c.id=p.id
 LEFT JOIN meeting_summaries s ON p.indexable_type='meeting_summary' AND s.id=p.id
 JOIN meetings m ON m.id=coalesce(t.meeting_id,c.meeting_id,s.meeting_id) WHERE m.account_id=?`
export function meetingHitIndexOver({ database }: StoreContext): MeetingSearchIndexStore {
  return {
    async indexSearch(original) {
      const input = { ...original }
      checkMeetingCancelled(input.signal)
      positiveReadInteger(input.accountId, "accountId")
      const limit = input.limit ?? 100
      const maxReadBytes = input.maxReadBytes ?? 4 * 1024 ** 2
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000)
        throw new CliError("validation_error", "Meeting indexing limit must be from 1 through 1000")
      if (!Number.isSafeInteger(maxReadBytes) || maxReadBytes < 1 || maxReadBytes > 64 * 1024 ** 2)
        throw new CliError("validation_error", "Meeting indexing byte limit must be from 1 through 67108864")
      return meetingWriteSnapshot(database, () => {
        checkMeetingCancelled(input.signal)
        const rows = database
          .prepare(`SELECT p.indexable_type,p.id,
        CASE WHEN m.deleted_at IS NOT NULL OR (p.indexable_type='meeting_transcript_row' AND (t.deleted_at IS NOT NULL OR t.superseded_at IS NOT NULL)) THEN 0 ELSE 1 END AS live,
        CASE WHEN m.deleted_at IS NOT NULL OR (p.indexable_type='meeting_transcript_row' AND (t.deleted_at IS NOT NULL OR t.superseded_at IS NOT NULL)) THEN 0
          WHEN p.indexable_type='meeting_transcript_row' THEN coalesce(length(CAST(r.text AS BLOB)),0)
          WHEN p.indexable_type='meeting_chat_message' THEN coalesce(length(CAST(c.text AS BLOB)),0)
          ELSE ${summaryBytes} END AS bytes ${queue} ORDER BY p.indexable_type,p.id LIMIT ?`)
          .all(input.accountId, limit)
        let bytes = 0
        for (const row of rows) {
          const size = Number(row.bytes)
          bytes += size
          if (!Number.isSafeInteger(size) || size < 0 || bytes > maxReadBytes)
            throw new CliError("validation_error", "Meeting indexing exceeds its stored text byte budget")
        }
        const remove = database.prepare("DELETE FROM meeting_words WHERE rowid=?")
        const add = database.prepare("INSERT INTO meeting_words(rowid,normalized_text,scope) VALUES(?,?,?)")
        const dequeue = database.prepare("DELETE FROM meeting_index_pending WHERE indexable_type=? AND id=?")
        for (const row of rows) {
          checkMeetingCancelled(input.signal)
          const kind = String(row.indexable_type) as keyof typeof INDEX_CODES
          const id = Number(row.id)
          remove.run(meetingRowid(kind, id))
          if (Number(row.live) === 1) {
            let text: string
            try {
              text = normalize(indexedText(database, kind, id) ?? "")
            } catch {
              throw new CliError("invalid_response", "Stored meeting search text has invalid structured text")
            }
            if (text) add.run(meetingRowid(kind, id), text, kind)
          }
          dequeue.run(kind, id)
        }
        const remaining = Number(database.prepare(`SELECT count(*) AS n ${queue}`).get(input.accountId)?.n ?? 0)
        checkMeetingCancelled(input.signal)
        return { indexed: rows.length, remaining }
      })
    },
  }
}
