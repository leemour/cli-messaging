import { formatLocator } from "../../domain/locator.js"
import {
  canonicalMeetingReference,
  formatMeetingReference,
  parseMeetingReference,
} from "../../domain/meeting-reference.js"
import { canonicalReference, formatReference, parseReference, type Reference } from "../../domain/references.js"
import type { CacheDatabase } from "../driver.js"
import { ENTITY_TABLES, type EntityType, isEntityType } from "./entity-types.js"

/** A row of the store as polymorphic columns name it: the singular table name and the row's id. */
export interface Thing {
  type: EntityType
  id: number
}

/** A pointer as a row holds it. An unknown type is not refused on read: `store check` reports it. */
export const storedThing = (type: unknown, id: unknown): Thing => ({ type: String(type) as EntityType, id: Number(id) })

export type ThingState = "available" | "deleted" | "unavailable"

/** Types a simple reference names by id, and whether a row can be marked gone. */
const REFERABLE: Partial<Record<EntityType, { tombstone: boolean }>> = {
  note: { tombstone: true },
  document: { tombstone: true },
  person: { tombstone: false },
  organization: { tombstone: true },
  project: { tombstone: true },
  task: { tombstone: true },
  memory: { tombstone: false },
  decision: { tombstone: true },
  bot: { tombstone: false },
  message: { tombstone: true },
  email: { tombstone: true },
  email_thread: { tombstone: true },
  chat: { tombstone: false },
  identity: { tombstone: false },
  account: { tombstone: false },
}

const referable = (type: string) =>
  isEntityType(type) && REFERABLE[type] ? { table: ENTITY_TABLES[type], ...REFERABLE[type] } : undefined

const storeId = (text: string) => (/^[1-9]\d{0,15}$/.test(text) ? Number(text) : undefined)

/**
 * The row a typed reference names, or `undefined` when the store holds none. An id from the old
 * `messages.db` (a ULID, an `entity:`) is simply not found: it is never guessed at.
 */
export const thingOf = (database: CacheDatabase, reference: Reference | string): Thing | undefined => {
  if (typeof reference === "string" && reference.trim().startsWith("meeting:")) {
    const parsed = parseMeetingReference(reference)
    const meeting = database
      .prepare("SELECT id FROM meetings WHERE id=? AND account_id=? AND deleted_at IS NULL")
      .get(parsed.meetingId, parsed.accountId)
    if (!meeting) return undefined
    if (parsed.transcriptId === undefined) return { type: "meeting", id: parsed.meetingId }
    const transcript = database
      .prepare("SELECT id FROM meeting_transcripts WHERE id=? AND meeting_id=? AND deleted_at IS NULL")
      .get(parsed.transcriptId, parsed.meetingId)
    if (!transcript) return undefined
    if (parsed.cuePosition === undefined) return { type: "meeting_transcript", id: parsed.transcriptId }
    const row = database
      .prepare("SELECT id FROM meeting_transcript_rows WHERE meeting_transcript_id=? AND position=?")
      .get(parsed.transcriptId, parsed.cuePosition)
    return row ? { type: "meeting_transcript_row", id: Number(row.id) } : undefined
  }
  const parsed = typeof reference === "string" ? parseReference(reference) : reference
  const found = (type: EntityType, row: Record<string, unknown> | undefined) =>
    row ? { type, id: Number(row.id) } : undefined
  switch (parsed.type) {
    case "message":
      return (
        (parsed.provider === "email" ? emailOf(database, parsed.account, parsed.chat, parsed.message) : undefined) ??
        found(
          "message",
          database
            .prepare(
              "SELECT m.id FROM messages m JOIN chats c ON c.id = m.chat_id JOIN accounts a ON a.id = c.account_id " +
                "WHERE a.provider = ? AND a.external_id = ? AND c.external_id = ? AND m.external_id = ?",
            )
            .get(parsed.provider, parsed.account, parsed.chat, parsed.message),
        )
      )
    case "chat":
      return (
        (parsed.provider === "email" ? emailThreadOf(database, parsed.account, parsed.chat) : undefined) ??
        found(
          "chat",
          database
            .prepare(
              "SELECT c.id FROM chats c JOIN accounts a ON a.id = c.account_id WHERE a.provider = ? AND a.external_id = ? AND c.external_id = ?",
            )
            .get(parsed.provider, parsed.account, parsed.chat),
        )
      )
    case "contact":
      return found(
        "identity",
        database
          .prepare("SELECT id FROM identities WHERE provider = ? AND external_id = ?")
          .get(parsed.provider, parsed.id),
      )
    case "folder": {
      const id = storeId(parsed.id)
      return id === undefined
        ? undefined
        : found("account", database.prepare("SELECT id FROM accounts WHERE id = ? AND provider = 'folder'").get(id))
    }
    case "task": {
      const id = taskRowOf(database, parsed.id)
      return id === undefined ? undefined : { type: "task", id }
    }
    case "entity":
      return undefined
    default: {
      const id = storeId(parsed.id)
      const known = referable(parsed.type)
      if (id === undefined || !known || !isEntityType(parsed.type)) return undefined
      return found(parsed.type, database.prepare(`SELECT id FROM ${known.table} WHERE id = ?`).get(id))
    }
  }
}

/** Mail that memo saved before it wrote the mail tables is still messages, so the caller falls back to them. */
export const emailOf = (database: CacheDatabase, account: string, thread: string, email: string): Thing | undefined => {
  const row = database
    .prepare(
      "SELECT e.id FROM emails e JOIN email_threads t ON t.id = e.email_thread_id JOIN accounts a ON a.id = e.account_id " +
        "WHERE a.provider = 'email' AND a.external_id = ? AND t.external_id = ? AND e.external_id = ?",
    )
    .get(account, thread, email)
  return row ? { type: "email", id: Number(row.id) } : undefined
}

export const emailThreadOf = (database: CacheDatabase, account: string, thread: string): Thing | undefined => {
  const row = database
    .prepare(
      "SELECT t.id FROM email_threads t JOIN accounts a ON a.id = t.account_id " +
        "WHERE a.provider = 'email' AND a.external_id = ? AND t.external_id = ?",
    )
    .get(account, thread)
  return row ? { type: "email_thread", id: Number(row.id) } : undefined
}

/** The reference people and agents read for a row; `undefined` once the row is gone. */
export const referenceOfThing = (database: CacheDatabase, thing: Thing): string | undefined => {
  if (["meeting", "meeting_transcript", "meeting_transcript_row"].includes(thing.type)) {
    const join =
      thing.type === "meeting"
        ? "FROM meetings m WHERE m.id=?"
        : thing.type === "meeting_transcript"
          ? "FROM meeting_transcripts t JOIN meetings m ON m.id=t.meeting_id WHERE t.id=?"
          : "FROM meeting_transcript_rows r JOIN meeting_transcripts t ON t.id=r.meeting_transcript_id JOIN meetings m ON m.id=t.meeting_id WHERE r.id=?"
    const columns =
      thing.type === "meeting"
        ? "m.account_id,m.id AS meeting_id,m.deleted_at AS meeting_deleted"
        : `m.account_id,m.id AS meeting_id,m.deleted_at AS meeting_deleted,t.id AS transcript_id,t.deleted_at AS transcript_deleted${thing.type === "meeting_transcript_row" ? ",r.position" : ""}`
    const row = database.prepare(`SELECT ${columns} ${join}`).get(thing.id)
    if (!row) return undefined
    return formatMeetingReference({
      type: "meeting",
      accountId: Number(row.account_id),
      meetingId: Number(row.meeting_id),
      ...(row.transcript_id == null ? {} : { transcriptId: Number(row.transcript_id) }),
      ...(row.position == null ? {} : { cuePosition: Number(row.position) }),
    })
  }
  switch (thing.type) {
    case "message": {
      const row = database
        .prepare(
          "SELECT a.provider, a.external_id AS account, c.external_id AS chat, m.external_id AS message FROM messages m " +
            "JOIN chats c ON c.id = m.chat_id JOIN accounts a ON a.id = c.account_id WHERE m.id = ?",
        )
        .get(thing.id)
      return row
        ? formatLocator({
            provider: String(row.provider),
            account: String(row.account),
            chat: String(row.chat),
            message: String(row.message),
          })
        : undefined
    }
    case "chat": {
      const row = database
        .prepare(
          "SELECT a.provider, a.external_id AS account, c.external_id AS chat FROM chats c JOIN accounts a ON a.id = c.account_id WHERE c.id = ?",
        )
        .get(thing.id)
      return row
        ? formatReference({
            type: "chat",
            provider: String(row.provider),
            account: String(row.account),
            chat: String(row.chat),
          })
        : undefined
    }
    case "email": {
      const row = database
        .prepare(
          "SELECT a.external_id AS account, t.external_id AS thread, e.external_id AS email FROM emails e " +
            "JOIN email_threads t ON t.id = e.email_thread_id JOIN accounts a ON a.id = e.account_id WHERE e.id = ?",
        )
        .get(thing.id)
      return row
        ? formatLocator({
            provider: "email",
            account: String(row.account),
            chat: String(row.thread),
            message: String(row.email),
          })
        : undefined
    }
    case "email_thread": {
      const row = database
        .prepare(
          "SELECT a.external_id AS account, t.external_id AS thread FROM email_threads t " +
            "JOIN accounts a ON a.id = t.account_id WHERE t.id = ?",
        )
        .get(thing.id)
      return row
        ? formatReference({ type: "chat", provider: "email", account: String(row.account), chat: String(row.thread) })
        : undefined
    }
    case "identity": {
      const row = database.prepare("SELECT provider, external_id FROM identities WHERE id = ?").get(thing.id)
      return row
        ? formatReference({ type: "contact", provider: String(row.provider), id: String(row.external_id) })
        : undefined
    }
    case "account":
      return formatReference({ type: "folder", id: String(thing.id), path: null })
    case "task": {
      const id = taskIdOf(database, thing.id)
      return id === undefined ? undefined : `task:${id}`
    }
    default:
      return `${thing.type}:${thing.id}`
  }
}

export const stateOfThing = (database: CacheDatabase, thing: Thing | undefined): ThingState => {
  if (!thing) return "unavailable"
  if (["meeting", "meeting_transcript", "meeting_transcript_row"].includes(thing.type)) {
    const source =
      thing.type === "meeting"
        ? "FROM meetings m WHERE m.id=?"
        : thing.type === "meeting_transcript"
          ? "FROM meeting_transcripts t JOIN meetings m ON m.id=t.meeting_id WHERE t.id=?"
          : "FROM meeting_transcript_rows r JOIN meeting_transcripts t ON t.id=r.meeting_transcript_id JOIN meetings m ON m.id=t.meeting_id WHERE r.id=?"
    const row = database
      .prepare(
        `SELECT m.deleted_at AS meeting_deleted${thing.type === "meeting" ? "" : ",t.deleted_at AS transcript_deleted"} ${source}`,
      )
      .get(thing.id)
    return !row
      ? "unavailable"
      : row.meeting_deleted != null || row.transcript_deleted != null
        ? "deleted"
        : "available"
  }
  const known = referable(thing.type)
  if (!known) return "unavailable"
  const row = database
    .prepare(`SELECT ${known.tombstone ? "deleted_at" : "NULL AS deleted_at"} FROM ${known.table} WHERE id = ?`)
    .get(thing.id)
  return !row ? "unavailable" : row.deleted_at == null ? "available" : "deleted"
}

/** The `tasks.id` behind what callers name a task by: the package's id, or the task's key. */
export const taskRowOf = (database: CacheDatabase, id: string): number | undefined => {
  const row = database.prepare("SELECT id FROM tasks WHERE package_id = ? OR key = ? ORDER BY id LIMIT 1").get(id, id)
  return row ? Number(row.id) : undefined
}

/** The package's id for a task row: the reverse of `taskRowOf`. */
export const taskIdOf = (database: CacheDatabase, rowId: number): string | undefined => {
  const row = database.prepare("SELECT key, package_id AS id FROM tasks WHERE id = ?").get(rowId)
  return row ? String(row.id ?? row.key) : undefined
}

export const canonicalThingReference = (reference: string): string =>
  reference.trim().startsWith("meeting:") ? canonicalMeetingReference(reference) : canonicalReference(reference)
