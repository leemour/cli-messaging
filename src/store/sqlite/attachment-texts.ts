import { NOT_FILES } from "../../domain/attachments.js"
import type { Id } from "../../domain/models.js"
import type { CacheDatabase } from "../driver.js"
import { normalize } from "../normalize.js"
import type { StoreContext } from "./open.js"
import { inBatch } from "./search-index.js"

export type TextOrigin = "extracted" | "agent"

/** One stored file attachment that extraction may read. */
export interface FileAttachment {
  pk: number
  chatId: Id
  messageId: Id
  /** From 0, as stored. */
  position: number
  kind: string
  name: string | null
  mime: string | null
  size: number | null
  localPath: string | null
  /** What an earlier run left, when it read this file. */
  read: {
    origin: TextOrigin
    bytes: number | null
    error: string | null
    contentSha256?: string | null
    extractor?: string
  } | null
}

export interface AttachmentTextEntry {
  text: string
  origin: TextOrigin
  extractor: string
  contentSha256?: string | null
  bytes?: number | null
  error?: string | null
}

const NOT_FILE_LIST = [...NOT_FILES].map((kind) => `'${kind}'`).join(",")

/**
 * File attachments of live messages, newest first, below `beforePk`. An agent's text is final, so its
 * attachments are never offered again.
 */
export const fileAttachments = (
  { database }: StoreContext,
  accountKey: number,
  { chatKey, messageId, beforePk, limit }: { chatKey?: number; messageId?: Id; beforePk?: number; limit: number },
): FileAttachment[] =>
  database
    .prepare(
      `SELECT att.id AS pk, c.external_id AS chat_id, m.external_id AS message_id, att.position, att.kind, att.name, att.mime,
         att.size, att.local_path, att.extraction AS origin, att.size AS read_bytes, att.extraction_error AS error, att.content_sha256, att.extractor
       FROM attachments att
       JOIN messages m ON m.id = att.attachable_id AND att.attachable_type = 'message'
       JOIN chats c ON c.id = m.chat_id

       WHERE m.account_id = ? AND m.deleted_at IS NULL AND att.kind NOT IN (${NOT_FILE_LIST})
         AND (att.extraction IS NULL OR att.extraction <> 'agent')
         ${chatKey === undefined ? "" : "AND m.chat_id = ?"} ${messageId === undefined ? "" : "AND m.external_id = ?"} AND att.id < ?
       ORDER BY att.id DESC LIMIT ?`,
    )
    .all(
      accountKey,
      ...(chatKey === undefined ? [] : [chatKey]),
      ...(messageId === undefined ? [] : [messageId]),
      beforePk ?? Number.MAX_SAFE_INTEGER,
      limit,
    )
    .map((row) => ({
      pk: Number(row.pk),
      chatId: String(row.chat_id),
      messageId: String(row.message_id),
      position: Number(row.position),
      kind: String(row.kind),
      name: row.name == null ? null : String(row.name),
      mime: row.mime == null ? null : String(row.mime),
      size: row.size == null ? null : Number(row.size),
      localPath: row.local_path == null ? null : String(row.local_path),
      read:
        row.origin == null
          ? null
          : {
              origin: row.origin === "agent" ? "agent" : "extracted",
              bytes: row.read_bytes == null ? null : Number(row.read_bytes),
              contentSha256: row.content_sha256 == null ? null : String(row.content_sha256),
              error: row.error == null ? null : String(row.error),
              extractor: String(row.extractor),
            },
    }))

/** Where a downloaded attachment was saved, after `messages download` recorded it. */
export const localPathOf = ({ database }: StoreContext, attachmentPk: number): string | null => {
  const row = database.prepare("SELECT local_path FROM attachments WHERE id = ?").get(attachmentPk)
  return row?.local_path == null ? null : String(row.local_path)
}

/** The account row that holds an attachment's message, email or meeting. */
export const accountOf = ({ database }: StoreContext, attachmentPk: number): number | undefined => {
  const row = database
    .prepare(
      `SELECT coalesce(m.account_id, e.account_id, mt.account_id) AS account_id FROM attachments a
       LEFT JOIN messages m ON a.attachable_type = 'message' AND m.id = a.attachable_id
       LEFT JOIN emails e ON a.attachable_type = 'email' AND e.id = a.attachable_id
       LEFT JOIN meetings mt ON a.attachable_type = 'meeting' AND mt.id = a.attachable_id
       WHERE a.id = ?`,
    )
    .get(attachmentPk)
  return row?.account_id == null ? undefined : Number(row.account_id)
}

/** Failed extraction cannot erase good text; agent text wins over every automated write. */
export const keepText = (
  { database, now }: StoreContext,
  attachmentPk: number,
  entry: AttachmentTextEntry,
): boolean => {
  const { changes } = database
    .prepare(
      `UPDATE attachments SET text=?, normalized_text=?, extraction=?, extractor=?, content_sha256=?,
         extraction_error=?, extracted_at=?, updated_at=?, size=coalesce(?,size) WHERE id=?
       ${entry.origin === "agent" ? "" : "AND (extraction IS NULL OR extraction <> 'agent') AND (? IS NULL OR extraction_error IS NOT NULL OR coalesce(text, '') = '')"}`,
    )
    .run(
      entry.text,
      normalize(entry.text),
      entry.origin === "agent" ? "agent" : entry.error ? "failed" : "text",
      entry.extractor,
      entry.contentSha256 ?? null,
      entry.error ?? null,
      now(),
      now(),
      entry.bytes ?? null,
      attachmentPk,
      ...(entry.origin === "agent" ? [] : [entry.error ?? null]),
    )
  return Number(changes) > 0
}

/**
 * For `store reindex`: the normalized copies follow the current normalizer, then the word index is
 * emptied and filled from them in one transaction — the table is small next to the messages.
 */
export const resetAttachmentWords = (database: CacheDatabase): number => {
  const exists = database.prepare("SELECT 1 FROM sqlite_master WHERE name = 'attachment_words'").get()
  if (!exists) return 0
  return inBatch(database, () => {
    const update = database.prepare("UPDATE attachments SET normalized_text = ? WHERE id = ?")
    for (const row of database
      .prepare("SELECT id AS attachment_id, text, normalized_text FROM attachments WHERE text IS NOT NULL")
      .all()) {
      const normalized = normalize(String(row.text))
      if (normalized !== row.normalized_text) update.run(normalized, Number(row.attachment_id))
    }
    database.exec("INSERT INTO attachment_words (attachment_words) VALUES ('delete-all')")
    const { changes } = database
      .prepare(
        "INSERT INTO attachment_words (rowid, normalized_text) SELECT id, normalized_text FROM attachments WHERE normalized_text <> ''",
      )
      .run()
    return Number(changes)
  })
}

/** One file attachment and what the store holds of its text — never the text itself. */
export interface AttachmentView {
  pk: number
  chatId: Id
  messageId: Id
  position: number
  kind: string
  name: string | null
  localPath: string | null
  text: { origin: TextOrigin; extractor: string; chars: number; error: string | null } | null
}

/** Kinds no one reads text from: sound and moving pictures. */
const NO_TEXT_LIST = ["voice", "audio", "video", "video_note", "sticker", "animation", "gif"]
  .map((kind) => `'${kind}'`)
  .join(",")

/**
 * This account's file attachments of live messages, newest first. `needsText`: saved on this machine and
 * with no text yet, or none an extraction could find — what an agent reads and writes back.
 */
export const attachmentViews = (
  { database }: StoreContext,
  accountKey: number,
  {
    chatKey,
    messageId,
    needsText = false,
    offset = 0,
    limit,
  }: { chatKey?: number; messageId?: Id; needsText?: boolean; offset?: number; limit: number },
): AttachmentView[] => {
  const where = [
    "m.account_id = ?",
    "m.deleted_at IS NULL",
    `att.kind NOT IN (${NOT_FILE_LIST})`,
    ...(chatKey === undefined ? [] : ["m.chat_id = ?"]),
    ...(messageId === undefined ? [] : ["m.external_id = ?"]),
    ...(needsText
      ? [
          "att.local_path IS NOT NULL",
          `att.kind NOT IN (${NO_TEXT_LIST})`,
          "(att.extracted_at IS NULL OR (att.extraction <> 'agent' AND coalesce(att.normalized_text, '') = ''))",
        ]
      : []),
  ]
  return database
    .prepare(
      `SELECT att.id AS pk, c.external_id AS chat_id, m.external_id AS message_id, att.position, att.kind, att.name,
         att.local_path, att.extraction AS origin, att.extractor, length(att.text) AS chars, att.extraction_error AS error
       FROM attachments att
       JOIN messages m ON m.id = att.attachable_id AND att.attachable_type = 'message'
       JOIN chats c ON c.id = m.chat_id

       WHERE ${where.join(" AND ")}
       ORDER BY m.sent_at DESC, att.id DESC, att.position LIMIT ? OFFSET ?`,
    )
    .all(
      accountKey,
      ...(chatKey === undefined ? [] : [chatKey]),
      ...(messageId === undefined ? [] : [messageId]),
      limit,
      offset,
    )
    .map((row) => ({
      pk: Number(row.pk),
      chatId: String(row.chat_id),
      messageId: String(row.message_id),
      position: Number(row.position),
      kind: String(row.kind),
      name: row.name == null ? null : String(row.name),
      localPath: row.local_path == null ? null : String(row.local_path),
      text:
        row.origin == null
          ? null
          : {
              origin: row.origin === "agent" ? "agent" : "extracted",
              extractor: String(row.extractor),
              chars: Number(row.chars),
              error: row.error == null ? null : String(row.error),
            },
    }))
}
