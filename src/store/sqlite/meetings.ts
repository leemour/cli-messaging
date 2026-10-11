import { CliError } from "@wirecat/cli-core"
import type {
  Attachment,
  ChatLine,
  MeetingContextStore,
  MeetingDetails,
  MeetingFilter,
  MeetingSave,
  MeetingSearchIndexStore,
  MeetingSearchStore,
  MeetingSeries,
  MeetingStore,
  MeetingTranscriptReceiptStore,
  MeetingTranscriptStore,
  NewRecord,
  Participant,
  SearchHit,
  Summary,
  TranscriptAppend,
  TranscriptAppendReceipt,
} from "@wirecat/cli-meetings"
import { MeetingError } from "@wirecat/cli-meetings"
import type { CacheDatabase, SqlValue } from "../driver.js"
import { normalize } from "../normalize.js"
import * as eventQueries from "./events.js"
import { fromJson, int, page, str, toJson } from "./events.js"
import { meetingIdentityPk } from "./identities.js"
import { meetingContextLinksOver } from "./meeting-context-links.js"
import { meetingHitIndexOver } from "./meeting-hit-index.js"
import { meetingHitSearchOver } from "./meeting-hit-search.js"
import { type MeetingReadCapabilities, meetingReadsOver } from "./meeting-reads.js"
import { meetingOf, transcriptOf, transcriptRowOf } from "./meeting-values.js"
import type { StoreContext } from "./open.js"
import { inBatch } from "./search-index.js"

type Row = Record<string, unknown>

const CURSOR_KEY = "meetings"

/**
 * Transcript rows, chat messages and summaries share `meeting_words` and their ids overlap, so each rowid is
 * the source id times 4 plus a type code: `rowid % 4` names the table, `rowid / 4` the id. Code 0 is unused.
 */
export const INDEX_CODES = { meeting_transcript_row: 1, meeting_chat_message: 2, meeting_summary: 3 } as const
type Indexable = keyof typeof INDEX_CODES
export const meetingRowid = (type: Indexable, id: number): number => id * 4 + INDEX_CODES[type]

const seriesOf = (row: Row): MeetingSeries => ({
  id: Number(row.id),
  accountId: Number(row.account_id),
  externalId: String(row.external_id),
  eventSeriesId: int(row.event_series_id),
  title: str(row.title),
  description: str(row.description),
  kind: str(row.kind),
  recurrence: fromJson(row.recurrence),
  hostIdentityId: int(row.host_identity_id),
  joinUrl: str(row.join_url),
  metadata: fromJson(row.metadata),
  deletedAt: int(row.deleted_at),
  createdAt: Number(row.created_at),
  updatedAt: Number(row.updated_at),
})

const participantOf = (row: Row): Participant => ({
  id: Number(row.id),
  meetingId: Number(row.meeting_id),
  identityId: Number(row.identity_id),
  displayName: str(row.display_name),
  email: str(row.email),
  role: str(row.role),
  joinedAt: int(row.joined_at),
  leftAt: int(row.left_at),
  durationMs: int(row.duration_ms),
  sessions: fromJson(row.sessions),
  externalId: str(row.external_id),
  metadata: fromJson(row.metadata),
  createdAt: Number(row.created_at),
  updatedAt: Number(row.updated_at),
})

const chatOf = (row: Row): ChatLine => ({
  id: Number(row.id),
  meetingId: Number(row.meeting_id),
  externalId: str(row.external_id),
  sentAt: Number(row.sent_at),
  senderParticipantId: int(row.sender_participant_id),
  senderName: str(row.sender_name),
  recipient: str(row.recipient),
  text: String(row.text),
  normalizedText: str(row.normalized_text),
  metadata: fromJson(row.metadata),
  createdAt: Number(row.created_at),
  updatedAt: Number(row.updated_at),
})

const summaryOf = (row: Row): Summary => ({
  id: Number(row.id),
  meetingId: Number(row.meeting_id),
  source: String(row.source),
  title: str(row.title),
  overview: str(row.overview),
  sections: fromJson(row.sections) ?? [],
  nextSteps: fromJson(row.next_steps) ?? [],
  content: str(row.content),
  docUrl: str(row.doc_url),
  externalCreatedAt: int(row.external_created_at),
  externalUpdatedAt: int(row.external_updated_at),
  metadata: fromJson(row.metadata),
  createdAt: Number(row.created_at),
  updatedAt: Number(row.updated_at),
})

export const attachmentOf = (row: Row): Attachment => ({
  id: Number(row.id),
  attachableType: "meeting",
  attachableId: Number(row.attachable_id),
  position: Number(row.position),
  kind: String(row.kind),
  mime: str(row.mime),
  name: str(row.name),
  title: str(row.title),
  url: str(row.url),
  size: int(row.size),
  width: int(row.width),
  height: int(row.height),
  duration: int(row.duration),
  providerRef: fromJson(row.provider_ref),
  localPath: str(row.local_path),
  text: str(row.text),
  normalizedText: str(row.normalized_text),
  extraction: str(row.extraction),
  extractor: str(row.extractor),
  extractionError: str(row.extraction_error),
  contentSha256: str(row.content_sha256),
  extractedAt: int(row.extracted_at),
  createdAt: Number(row.created_at),
  updatedAt: Number(row.updated_at),
})

const summaryText = (s: Pick<Summary, "title" | "overview" | "sections" | "nextSteps" | "content">): string =>
  [s.title, s.overview, ...s.sections.map((section) => section.text), ...s.nextSteps, s.content]
    .filter(Boolean)
    .join("\n")

const details = (database: CacheDatabase, id: number): MeetingDetails | null => {
  const row = database.prepare("SELECT * FROM meetings WHERE id = ?").get(id)
  if (!row) return null
  const meeting = meetingOf(row)
  const series =
    meeting.meetingSeriesId === null
      ? null
      : seriesOf(database.prepare("SELECT * FROM meeting_series WHERE id = ?").get(meeting.meetingSeriesId) as Row)
  const rowsOf = database.prepare(
    "SELECT * FROM meeting_transcript_rows WHERE meeting_transcript_id = ? ORDER BY position",
  )
  return {
    meeting,
    series,
    participants: database
      .prepare("SELECT * FROM meeting_participants WHERE meeting_id = ? ORDER BY id")
      .all(id)
      .map(participantOf),
    transcripts: database
      .prepare("SELECT * FROM meeting_transcripts WHERE meeting_id = ? ORDER BY id")
      .all(id)
      .map((t) => ({ transcript: transcriptOf(t), rows: rowsOf.all(Number(t.id)).map(transcriptRowOf) })),
    chat: database.prepare("SELECT * FROM meeting_chat_messages WHERE meeting_id = ? ORDER BY id").all(id).map(chatOf),
    summaries: database
      .prepare("SELECT * FROM meeting_summaries WHERE meeting_id = ? ORDER BY id")
      .all(id)
      .map(summaryOf),
    attachments: database
      .prepare("SELECT * FROM attachments WHERE attachable_type = 'meeting' AND attachable_id = ? ORDER BY position")
      .all(id)
      .map(attachmentOf),
  }
}

/** Inserts or updates the row the key finds; `values` are the columns besides the key and the times. */
const upsert = (
  database: CacheDatabase,
  table: string,
  key: Record<string, SqlValue>,
  values: Record<string, SqlValue>,
  now: number,
): number => {
  const keys = Object.keys(key)
  const where = keys.map((k) => `${k} IS ?`).join(" AND ")
  const found = database
    .prepare(`SELECT id FROM ${table} WHERE ${where} ORDER BY id LIMIT 1`)
    .get(...Object.values(key))
  const columns = Object.keys(values)
  if (found) {
    database
      .prepare(`UPDATE ${table} SET ${[...columns, "updated_at"].map((c) => `${c} = ?`).join(", ")} WHERE id = ?`)
      .run(...Object.values(values), now, found.id as number)
    return Number(found.id)
  }
  const all = [...keys, ...columns, "created_at", "updated_at"]
  return Number(
    database
      .prepare(`INSERT INTO ${table} (${all.join(", ")}) VALUES (${all.map(() => "?").join(", ")}) RETURNING id`)
      .get(...Object.values(key), ...Object.values(values), now, now)?.id,
  )
}

/** An attachment as its parent's save gives it: the parent sets the type and id. */
export type AttachmentInput = Omit<NewRecord<Attachment>, "attachableType" | "attachableId">

/** Inserts or updates an attachment of any parent, found by its position. */
export const saveAttachment = (
  database: CacheDatabase,
  type: string,
  parentId: number,
  a: AttachmentInput,
  now: number,
): number =>
  upsert(
    database,
    "attachments",
    { attachable_type: type, attachable_id: parentId, position: a.position },
    {
      kind: a.kind,
      mime: a.mime,
      name: a.name,
      title: a.title,
      url: a.url,
      size: a.size,
      width: a.width,
      height: a.height,
      duration: a.duration,
      provider_ref: toJson(a.providerRef),
      local_path: a.localPath,
      text: a.text,
      normalized_text: a.normalizedText,
      extraction: a.extraction,
      extractor: a.extractor,
      extraction_error: a.extractionError,
      content_sha256: a.contentSha256,
      extracted_at: a.extractedAt,
    },
    now,
  )

const save = (context: StoreContext, input: MeetingSave): number => {
  const { database } = context
  const {
    meeting: { series: seriesInput, ...meeting },
    now,
  } = input
  if (!Number.isSafeInteger(meeting.accountId) || meeting.accountId <= 0 || !meeting.externalId)
    throw new Error("Invalid meeting key")
  const existing = database
    .prepare("SELECT id, meeting_series_id FROM meetings WHERE account_id = ? AND external_id = ?")
    .get(meeting.accountId, meeting.externalId)
  let seriesId = existing ? int(existing.meeting_series_id) : null
  if (seriesInput) {
    if (!seriesInput.externalId) throw new Error("Invalid series key")
    seriesId = upsert(
      database,
      "meeting_series",
      { account_id: meeting.accountId, external_id: seriesInput.externalId },
      {
        title: seriesInput.title,
        description: seriesInput.description,
        kind: seriesInput.kind,
        recurrence: toJson(seriesInput.recurrence),
        host_identity_id: seriesInput.hostIdentityId,
        join_url: seriesInput.joinUrl,
        metadata: toJson(seriesInput.metadata),
        deleted_at: seriesInput.deletedAt,
      },
      now,
    )
  }
  const meetingId = upsert(
    database,
    "meetings",
    { account_id: meeting.accountId, external_id: meeting.externalId },
    {
      meeting_series_id: seriesId,
      title: meeting.title,
      description: meeting.description,
      location: meeting.location,
      join_url: meeting.joinUrl,
      started_at: meeting.startedAt,
      ended_at: meeting.endedAt,
      duration_ms: meeting.durationMs,
      timezone: meeting.timezone,
      host_identity_id: meeting.hostIdentityId,
      participants_count: meeting.participantsCount,
      metadata: toJson(meeting.metadata),
      deleted_at: meeting.deletedAt,
    },
    now,
  )

  const participantIds = (input.participants ?? []).map(({ identity, ...p }) =>
    upsert(
      database,
      "meeting_participants",
      {
        meeting_id: meetingId,
        identity_id: meetingIdentityPk({ ...context, now: () => now }, meeting.accountId, identity),
      },
      {
        display_name: p.displayName,
        email: p.email,
        role: p.role,
        joined_at: p.joinedAt,
        left_at: p.leftAt,
        duration_ms: p.durationMs,
        sessions: toJson(p.sessions),
        external_id: p.externalId,
        metadata: toJson(p.metadata),
      },
      now,
    ),
  )
  const participantId = (position: number | null) => {
    if (position === null) return null
    const id = participantIds[position]
    if (id === undefined) throw new Error("Invalid participant position")
    return id
  }

  saveTranscripts(database, meetingId, input.transcripts ?? [], participantId, now)

  for (const { senderParticipantPosition, ...line } of input.chat ?? []) {
    const values = {
      sent_at: line.sentAt,
      sender_participant_id: participantId(senderParticipantPosition),
      sender_name: line.senderName,
      recipient: line.recipient,
      text: line.text,
      normalized_text: line.normalizedText,
      metadata: toJson(line.metadata),
    }
    // A line without the source's id is the same line when its time, sender and text all match.
    const key: Record<string, SqlValue> =
      line.externalId !== null
        ? { meeting_id: meetingId, external_id: line.externalId }
        : {
            meeting_id: meetingId,
            external_id: null,
            sent_at: line.sentAt,
            sender_name: line.senderName,
            text: line.text,
          }
    upsert(database, "meeting_chat_messages", key, values, now)
  }

  for (const s of input.summaries ?? [])
    upsert(
      database,
      "meeting_summaries",
      { meeting_id: meetingId, source: s.source },
      {
        title: s.title,
        overview: s.overview,
        sections: JSON.stringify(s.sections),
        next_steps: JSON.stringify(s.nextSteps),
        content: s.content,
        doc_url: s.docUrl,
        external_created_at: s.externalCreatedAt,
        external_updated_at: s.externalUpdatedAt,
        metadata: toJson(s.metadata),
      },
      now,
    )

  for (const a of input.attachments ?? []) saveAttachment(database, "meeting", meetingId, a, now)
  return meetingId
}

const saveTranscripts = (
  database: CacheDatabase,
  meetingId: number,
  transcripts: NonNullable<MeetingSave["transcripts"]>,
  participantId: (position: number | null) => number | null,
  now: number,
): { insertedTranscripts: number; replayedTranscripts: number; supersededTranscripts: number } => {
  const counts = { insertedTranscripts: 0, replayedTranscripts: 0, supersededTranscripts: 0 }
  const sameContent = database.prepare(
    "SELECT 1 FROM meeting_transcripts WHERE meeting_id = ? AND source = ? AND content_hash = ?",
  )
  const supersede = database.prepare(
    `UPDATE meeting_transcripts SET superseded_at = ?, updated_at = ?
       WHERE meeting_id = ? AND source = ? AND superseded_at IS NULL`,
  )
  const insertTranscript = database.prepare(
    `INSERT INTO meeting_transcripts (meeting_id, source, format, language, content_hash, external_created_at,
       metadata, created_at, updated_at, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
  )
  const insertRow = database.prepare(
    `INSERT INTO meeting_transcript_rows (meeting_transcript_id, position, start_ms, end_ms, speaker_participant_id,
       speaker_name, text, normalized_text, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  for (const { rows, ...t } of transcripts) {
    if (t.contentHash !== null && sameContent.get(meetingId, t.source, t.contentHash)) {
      counts.replayedTranscripts++
      continue
    }
    for (const row of rows)
      if (!Number.isSafeInteger(row.position) || row.position < 0) throw new Error("Invalid transcript position")
    counts.supersededTranscripts += Number(supersede.run(now, now, meetingId, t.source).changes)
    counts.insertedTranscripts++
    const transcriptId = Number(
      insertTranscript.get(
        meetingId,
        t.source,
        t.format,
        t.language,
        t.contentHash,
        t.externalCreatedAt,
        toJson(t.metadata),
        now,
        now,
        t.deletedAt,
      )?.id,
    )
    for (const row of rows)
      insertRow.run(
        transcriptId,
        row.position,
        row.startMs,
        row.endMs,
        participantId(row.speakerParticipantPosition),
        row.speakerName,
        row.text,
        row.normalizedText,
        toJson(row.metadata),
        now,
      )
  }
  return counts
}

const append = (context: StoreContext, input: TranscriptAppend): TranscriptAppendReceipt => {
  const invalid = (message: string): never => {
    throw new MeetingError("validation_error", message)
  }
  if (
    !Number.isSafeInteger(input.accountId) ||
    input.accountId <= 0 ||
    !input.externalId?.trim() ||
    !Number.isSafeInteger(input.now) ||
    !Array.isArray(input.transcripts) ||
    input.transcripts.length === 0
  )
    invalid("Invalid transcript append")
  if (
    input.create &&
    (!Number.isSafeInteger(input.create.startedAt) || Math.abs(input.create.startedAt) > 8640000000000000)
  )
    invalid("Invalid meeting start")
  const sources = new Set<string>()
  for (const transcript of input.transcripts) {
    if (!transcript.source?.trim() || !transcript.contentHash?.trim() || sources.has(transcript.source))
      invalid("Expected distinct transcript sources and nonempty hashes")
    sources.add(transcript.source)
    for (const row of transcript.rows)
      if ("speakerParticipantPosition" in row || "speakerParticipantId" in row)
        invalid("Appended transcript rows must be unlinked")
  }
  const { database } = context
  return inBatch(database, () => {
    const existing = database
      .prepare("SELECT id, deleted_at FROM meetings WHERE account_id = ? AND external_id = ?")
      .get(input.accountId, input.externalId)
    if (existing?.deleted_at != null || (!existing && !input.create))
      throw new MeetingError("not_found", "Meeting not found")
    const meetingId = existing
      ? Number(existing.id)
      : save(context, {
          meeting: {
            accountId: input.accountId,
            externalId: input.externalId,
            title: input.create?.title ?? null,
            startedAt: input.create?.startedAt ?? null,
            timezone: input.create?.timezone ?? null,
            description: null,
            location: null,
            joinUrl: null,
            endedAt: null,
            durationMs: null,
            hostIdentityId: null,
            participantsCount: null,
            metadata: null,
            deletedAt: null,
          },
          now: input.now,
        })
    const counts = saveTranscripts(
      database,
      meetingId,
      input.transcripts.map((t) => ({
        ...t,
        rows: t.rows.map((row) => ({ ...row, speakerParticipantPosition: null })),
      })),
      () => null,
      input.now,
    )
    return { meeting: details(database, meetingId) as MeetingDetails, created: !existing, ...counts }
  })
}

const filtered = (filter: MeetingFilter = {}) => {
  const where: string[] = []
  const params: SqlValue[] = []
  const add = (sql: string, value: SqlValue) => {
    where.push(sql)
    params.push(value)
  }
  if (!filter.includeDeleted) where.push("deleted_at IS NULL")
  if (filter.accountId !== undefined) add("account_id = ?", filter.accountId)
  if (filter.eventId !== undefined) add("event_id = ?", filter.eventId)
  if (filter.meetingSeriesId !== undefined) add("meeting_series_id = ?", filter.meetingSeriesId)
  if (filter.since !== undefined) add("started_at >= ?", filter.since)
  if (filter.until !== undefined) add("started_at <= ?", filter.until)
  const [limit, offset] = page(filter)
  return {
    sql: `SELECT * FROM meetings${where.length ? ` WHERE ${where.join(" AND ")}` : ""}
      ORDER BY coalesce(started_at, 0) DESC, id LIMIT ? OFFSET ?`,
    params: [...params, limit, offset],
  }
}

export const indexedText = (database: CacheDatabase, type: string, id: number): string | null => {
  if (type === "meeting_transcript_row")
    return str(database.prepare("SELECT text FROM meeting_transcript_rows WHERE id = ?").get(id)?.text)
  if (type === "meeting_chat_message")
    return str(database.prepare("SELECT text FROM meeting_chat_messages WHERE id = ?").get(id)?.text)
  const row = database
    .prepare("SELECT title,overview,sections,next_steps,content FROM meeting_summaries WHERE id = ?")
    .get(id)
  return row ? summaryText(summaryOf(row)) : null
}

/**
 * Indexes what the queue holds, words only. A superseded transcript or a deleted meeting stays indexed and is
 * left out when searching, so changing them does not have to queue every row again.
 */
export const drainMeetingIndex = (database: CacheDatabase, batch = 500): number => {
  const next = database.prepare("SELECT indexable_type, id FROM meeting_index_pending LIMIT ?")
  const drop = database.prepare("DELETE FROM meeting_words WHERE rowid = ?")
  const insert = database.prepare("INSERT INTO meeting_words (rowid, normalized_text, scope) VALUES (?, ?, ?)")
  const dequeue = database.prepare("DELETE FROM meeting_index_pending WHERE indexable_type = ? AND id = ?")
  let done = 0
  for (;;) {
    const count = inBatch(database, () => {
      const queued = next.all(batch)
      for (const { indexable_type: type, id } of queued) {
        const kind = String(type)
        if (kind in INDEX_CODES) {
          const rowid = meetingRowid(kind as Indexable, Number(id))
          drop.run(rowid)
          const words = normalize(indexedText(database, kind, Number(id)) ?? "")
          if (words) insert.run(rowid, words, kind)
        }
        dequeue.run(kind, Number(id))
      }
      return queued.length
    })
    if (count === 0) return done
    done += count
  }
}

/** Each word of the query, as a prefix, all required. */
export const wordsQuery = (query: string): string | null => {
  const words = normalize(query)
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
  return words.length ? words.map((word) => `"${word}"*`).join(" AND ") : null
}

/** Pages over meetings, then lists their hits, as the reference store does. */
const search = (database: CacheDatabase, query: string, filter?: MeetingFilter): SearchHit[] => {
  const match = wordsQuery(query)
  if (match === null) return []
  drainMeetingIndex(database)
  const picked = filtered(filter)
  const rows = database
    .prepare(
      `WITH hit AS (SELECT rowid AS r FROM meeting_words WHERE meeting_words MATCH ?),
       picked AS (SELECT id, row_number() OVER (ORDER BY coalesce(started_at, 0) DESC, id) AS n FROM (${picked.sql}))
       SELECT p.n, 0 AS kind, t.id AS a, r.position AS b, r.id, t.meeting_id, r.start_ms, r.text
         FROM hit h JOIN meeting_transcript_rows r ON h.r % 4 = 1 AND r.id = h.r / 4
         JOIN meeting_transcripts t ON t.id = r.meeting_transcript_id
           AND t.superseded_at IS NULL AND t.deleted_at IS NULL
         JOIN picked p ON p.id = t.meeting_id
       UNION ALL
       SELECT p.n, 1, c.id, 0, c.id, c.meeting_id, NULL, c.text
         FROM hit h JOIN meeting_chat_messages c ON h.r % 4 = 2 AND c.id = h.r / 4
         JOIN picked p ON p.id = c.meeting_id
       UNION ALL
       SELECT p.n, 2, s.id, 0, s.id, s.meeting_id, NULL, NULL
         FROM hit h JOIN meeting_summaries s ON h.r % 4 = 3 AND s.id = h.r / 4
         JOIN picked p ON p.id = s.meeting_id
       ORDER BY 1, 2, 3, 4`,
    )
    .all(`normalized_text : (${match})`, ...picked.params)
  const summary = database.prepare("SELECT * FROM meeting_summaries WHERE id = ?")
  const scopes = ["transcript", "chat", "summary"] as const
  return rows.map((row) => {
    const scope = scopes[Number(row.kind)] as SearchHit["scope"]
    return {
      meetingId: Number(row.meeting_id),
      scope,
      id: Number(row.id),
      text: scope === "summary" ? summaryText(summaryOf(summary.get(Number(row.id)) as Row)) : String(row.text),
      startMs: int(row.start_ms),
    }
  })
}

const participants = (database: CacheDatabase, query: string, accountId?: number): Participant[] => {
  const term = query.toLocaleLowerCase()
  const rows = database
    .prepare(
      `SELECT p.* FROM meeting_participants p JOIN meetings m ON m.id = p.meeting_id
        WHERE ? IS NULL OR m.account_id = ? ORDER BY p.id`,
    )
    .all(accountId ?? null, accountId ?? null)
  // In JS: SQLite's lower() folds only ASCII, and names here are often Cyrillic.
  return rows
    .map(participantOf)
    .filter((p) => `${p.displayName ?? ""} ${p.email ?? ""}`.toLocaleLowerCase().includes(term))
}

/** The `MeetingStore` of `@wirecat/cli-meetings` over the shared store. */
export const meetingStoreOver = (
  context: StoreContext,
): MeetingStore &
  MeetingTranscriptStore &
  MeetingReadCapabilities &
  MeetingSearchStore &
  MeetingTranscriptReceiptStore &
  MeetingContextStore &
  MeetingSearchIndexStore => {
  const { database } = context
  return {
    ...meetingReadsOver(context),
    ...meetingHitSearchOver(context),
    ...meetingHitIndexOver(context),
    ...meetingContextLinksOver(context),
    async appendTranscriptsWithReceipt(input) {
      try {
        return append(context, input)
      } catch (error) {
        if (error instanceof MeetingError) throw new CliError(error.code, error.message)
        throw error
      }
    },
    async appendTranscripts(input) {
      return append(context, input).meeting
    },
    async saveMeeting(input) {
      const id = inBatch(database, () => save(context, input))
      return details(database, id) as MeetingDetails
    },
    async meetings(filter) {
      const { sql, params } = filtered(filter)
      return database
        .prepare(sql)
        .all(...params)
        .map(meetingOf)
    },
    async meeting(id) {
      return details(database, id)
    },
    async participants(query, accountId) {
      return participants(database, query, accountId)
    },
    async search(query, filter) {
      return search(database, query, filter)
    },
    async events() {
      return eventQueries.events(database)
    },
    async eventCandidates(filter) {
      return eventQueries.eventCandidates(database, filter)
    },
    async createEvent(input, now) {
      return eventQueries.createEvent(database, input, now)
    },
    async createEventSeries(input, now) {
      return eventQueries.createEventSeries(database, input, now)
    },
    async setEventSeries(meetingSeriesId, eventSeriesId, now) {
      eventQueries.setEventSeries(database, meetingSeriesId, eventSeriesId, now)
    },
    async linkMeeting(id, eventId, now, mode) {
      eventQueries.linkMeeting(database, id, eventId, now, mode)
    },
    async cursor(accountId) {
      return str(
        database.prepare("SELECT value FROM sync_cursors WHERE account_id = ? AND key = ?").get(accountId, CURSOR_KEY)
          ?.value,
      )
    },
    async setCursor(accountId, value, now) {
      database
        .prepare(
          `INSERT INTO sync_cursors (account_id, key, value, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (account_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        )
        .run(accountId, CURSOR_KEY, value, now, now)
    },
  }
}
