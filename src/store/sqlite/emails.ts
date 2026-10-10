import type { Attachment, Metadata } from "@wirecat/cli-meetings"
import type { CacheDatabase, SqlValue } from "../driver.js"
import { normalize } from "../normalize.js"
import { bool, flag, fromJson, int, page, str, toJson } from "./events.js"
import { type AttachmentInput, attachmentOf, saveAttachment, wordsQuery } from "./meetings.js"
import type { StoreContext } from "./open.js"
import { inBatch } from "./search-index.js"

type Row = Record<string, unknown>

export interface EmailAddress {
  address: string
  name: string | null
}

export interface MailboxInput {
  externalId: string
  name: string
  kind: string | null
}

/** One email to save. A field left out keeps what was stored; the recipients are replaced when any role is given. */
export interface EmailInput {
  /** The Message-ID header. */
  externalId: string
  subject: string | null
  from: EmailAddress | null
  to?: EmailAddress[]
  cc?: EmailAddress[]
  bcc?: EmailAddress[]
  replyTo?: EmailAddress[]
  sentAt: number | null
  receivedAt?: number | null
  inReplyTo?: string | null
  references?: string[] | null
  bodyText: string | null
  bodyHtml?: string | null
  snippet?: string | null
  outgoing?: boolean | null
  read?: boolean | null
  flagged?: boolean | null
  draft?: boolean | null
  size?: number | null
  headers?: Metadata
  metadata?: Metadata
  /** Added to the mailboxes the email is already in; one scan sees one folder, so none is taken away. */
  mailboxes?: MailboxInput[]
  /** Replaced when given; the text is word-indexed. */
  attachments?: AttachmentInput[]
}

export interface ThreadSave {
  accountId: number
  externalId: string
  /** Without it, a new thread takes its first email's subject, without Re: and Fwd:. */
  subject?: string | null
  metadata?: Metadata
  emails: EmailInput[]
  now: number
}

export interface EmailThread {
  id: number
  accountId: number
  externalId: string
  subject: string | null
  lastEmailAt: number | null
  emailsCount: number
  metadata: Metadata
  createdAt: number
  updatedAt: number
  deletedAt: number | null
}

export interface EmailRecipient {
  identityId: number | null
  address: string
  name: string | null
  role: "to" | "cc" | "bcc" | "reply_to"
  position: number
}

export interface Mailbox {
  id: number
  accountId: number
  externalId: string
  name: string
  kind: string | null
}

export type EmailAttachment = Omit<Attachment, "attachableType"> & { attachableType: "email" }

export interface Email {
  id: number
  accountId: number
  emailThreadId: number
  externalId: string
  subject: string | null
  fromIdentityId: number | null
  fromAddress: string | null
  fromName: string | null
  sentAt: number | null
  receivedAt: number | null
  inReplyTo: string | null
  references: string[] | null
  bodyText: string | null
  bodyHtml: string | null
  snippet: string | null
  outgoing: boolean | null
  read: boolean | null
  flagged: boolean | null
  draft: boolean | null
  size: number | null
  headers: Metadata
  metadata: Metadata
  recipients: EmailRecipient[]
  mailboxes: Mailbox[]
  attachments: EmailAttachment[]
  createdAt: number
  updatedAt: number
  deletedAt: number | null
}

export interface ThreadDetails {
  thread: EmailThread
  /** Oldest first. */
  emails: Email[]
}

export interface MailFilter {
  accountId?: number
  includeDeleted?: boolean
  limit?: number
  offset?: number
}

export interface EmailFilter extends MailFilter {
  threadExternalId?: string
  /** An address in From, To, Cc, Bcc or Reply-To. */
  participant?: string
  /** A mailbox's external id. */
  mailbox?: string
  /** On the received time, or the sent time when that is unknown: IMAP's SINCE counts by the received day. */
  since?: number
  /** Exclusive. */
  until?: number
}

/** Mail in tables of its own: threads, emails, recipients and mailboxes, keyed by account and Message-ID. */
export interface MailStore {
  saveThread(input: ThreadSave): Promise<ThreadDetails>
  /** Newest activity first. */
  threads(filter?: MailFilter): Promise<EmailThread[]>
  thread(id: number): Promise<ThreadDetails | null>
  email(accountId: number, externalId: string): Promise<Email | null>
  /** Newest first. */
  emails(filter?: EmailFilter): Promise<Email[]>
  mailboxes(accountId: number): Promise<Mailbox[]>
  /**
   * Sets each email's membership among the `scanned` mailboxes to the ones it was found in; membership outside
   * `scanned` stays, since a scan proves nothing about a folder it did not read. Answers how many emails it found.
   */
  setMailboxes(
    accountId: number,
    scanned: MailboxInput[],
    found: ReadonlyMap<string, string[]>,
    now: number,
  ): Promise<number>
  /** Marks emails gone at the source and drops their text; saving one again brings it back. Answers how many changed. */
  markDeleted(accountId: number, externalIds: string[], now: number): Promise<number>
  /** Every word of the query, as a prefix, in the subject or body; newest first. */
  search(query: string, filter?: Omit<EmailFilter, "includeDeleted">): Promise<Email[]>
}

const ROLES = [
  ["to", "to"],
  ["cc", "cc"],
  ["bcc", "bcc"],
  ["replyTo", "reply_to"],
] as const

const threadOf = (row: Row): EmailThread => ({
  id: Number(row.id),
  accountId: Number(row.account_id),
  externalId: String(row.external_id),
  subject: str(row.subject),
  lastEmailAt: int(row.last_email_at),
  emailsCount: Number(row.emails_count),
  metadata: fromJson(row.metadata),
  createdAt: Number(row.created_at),
  updatedAt: Number(row.updated_at),
  deletedAt: int(row.deleted_at),
})

const emailOf = (database: CacheDatabase, row: Row): Email => ({
  id: Number(row.id),
  accountId: Number(row.account_id),
  emailThreadId: Number(row.email_thread_id),
  externalId: String(row.external_id),
  subject: str(row.subject),
  fromIdentityId: int(row.from_identity_id),
  fromAddress: str(row.from_address),
  fromName: str(row.from_name),
  sentAt: int(row.sent_at),
  receivedAt: int(row.received_at),
  inReplyTo: str(row.in_reply_to),
  references: fromJson(row.references),
  bodyText: str(row.body_text),
  bodyHtml: str(row.body_html),
  snippet: str(row.snippet),
  outgoing: bool(row.outgoing),
  read: bool(row.read),
  flagged: bool(row.flagged),
  draft: bool(row.draft),
  size: int(row.size),
  headers: fromJson(row.headers),
  metadata: fromJson(row.metadata),
  recipients: database
    .prepare("SELECT * FROM email_recipients WHERE email_id = ? ORDER BY position")
    .all(Number(row.id))
    .map((r) => ({
      identityId: int(r.identity_id),
      address: String(r.address),
      name: str(r.name),
      role: String(r.role) as EmailRecipient["role"],
      position: Number(r.position),
    })),
  mailboxes: database
    .prepare(
      "SELECT b.* FROM email_mailboxes e JOIN mailboxes b ON b.id = e.mailbox_id WHERE e.email_id = ? ORDER BY b.id",
    )
    .all(Number(row.id))
    .map((b) => ({
      id: Number(b.id),
      accountId: Number(b.account_id),
      externalId: String(b.external_id),
      name: String(b.name),
      kind: str(b.kind),
    })),
  attachments: database
    .prepare("SELECT * FROM attachments WHERE attachable_type = 'email' AND attachable_id = ? ORDER BY position")
    .all(Number(row.id))
    .map((a) => ({ ...attachmentOf(a), attachableType: "email" as const })),
  createdAt: Number(row.created_at),
  updatedAt: Number(row.updated_at),
  deletedAt: int(row.deleted_at),
})

const threadDetails = (database: CacheDatabase, id: number): ThreadDetails | null => {
  const row = database.prepare("SELECT * FROM email_threads WHERE id = ?").get(id)
  if (!row) return null
  return {
    thread: threadOf(row),
    emails: database
      .prepare("SELECT * FROM emails WHERE email_thread_id = ? ORDER BY coalesce(sent_at, received_at), id")
      .all(id)
      .map((e) => emailOf(database, e)),
  }
}

const titleOf = (subject: string | null): string | null =>
  subject?.replace(/^\s*((re|fwd?|aw|wg)\s*:\s*)+/i, "").trim() || null

/** An address is an identity of provider `email`; a display name fills only a nameless one. */
const addressIdentity = (database: CacheDatabase, { address, name }: EmailAddress, now: number): number => {
  const key = address.trim().toLowerCase()
  const found = database
    .prepare("SELECT id, name FROM identities WHERE provider = 'email' AND external_id = ?")
    .get(key)
  if (found) {
    if (found.name === null && name)
      database.prepare("UPDATE identities SET name = ?, updated_at = ? WHERE id = ?").run(name, now, Number(found.id))
    return Number(found.id)
  }
  return Number(
    database
      .prepare(
        "INSERT INTO identities (provider, external_id, name, created_at, updated_at) VALUES ('email', ?, ?, ?, ?) RETURNING id",
      )
      .get(key, name, now, now)?.id,
  )
}

const recount = (database: CacheDatabase, threadId: number, now: number) =>
  database
    .prepare(
      `UPDATE email_threads SET
         emails_count = (SELECT count(*) FROM emails WHERE email_thread_id = ?1 AND deleted_at IS NULL),
         last_email_at = (SELECT max(coalesce(sent_at, received_at)) FROM emails
           WHERE email_thread_id = ?1 AND deleted_at IS NULL),
         deleted_at = CASE
           WHEN EXISTS (SELECT 1 FROM emails WHERE email_thread_id = ?1 AND deleted_at IS NULL) THEN NULL
           WHEN EXISTS (SELECT 1 FROM emails WHERE email_thread_id = ?1) THEN coalesce(deleted_at, ?2)
           ELSE deleted_at END,
         updated_at = ?2
       WHERE id = ?1`,
    )
    .run(threadId, now)

const mailboxPk = (database: CacheDatabase, accountId: number, box: MailboxInput, now: number): number => {
  if (!box.externalId) throw new Error("Invalid mailbox key")
  return Number(
    database
      .prepare(
        `INSERT INTO mailboxes (account_id, external_id, name, kind, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT (account_id, external_id) DO UPDATE SET name = excluded.name,
             kind = coalesce(excluded.kind, kind), updated_at = excluded.updated_at
           RETURNING id`,
      )
      .get(accountId, box.externalId, box.name, box.kind, now, now)?.id,
  )
}

const join = (database: CacheDatabase, emailId: number, mailboxId: number, now: number) =>
  database
    .prepare("INSERT OR IGNORE INTO email_mailboxes (email_id, mailbox_id, created_at) VALUES (?, ?, ?)")
    .run(emailId, mailboxId, now)

const saveEmail = (database: CacheDatabase, accountId: number, threadId: number, mail: EmailInput, now: number) => {
  if (!mail.externalId) throw new Error("Invalid email key")
  const from = mail.from ? { ...mail.from, address: mail.from.address.trim().toLowerCase() } : null
  const values: [string, SqlValue][] = [
    ["email_thread_id", threadId],
    ["subject", mail.subject],
    ["from_identity_id", from ? addressIdentity(database, from, now) : null],
    ["from_address", from?.address ?? null],
    ["from_name", from?.name ?? null],
    ["sent_at", mail.sentAt],
    ["body_text", mail.bodyText],
  ]
  const optional: [keyof EmailInput, string, (value: never) => SqlValue][] = [
    ["receivedAt", "received_at", (v: number | null) => v],
    ["inReplyTo", "in_reply_to", (v: string | null) => v],
    ["references", '"references"', toJson],
    ["bodyHtml", "body_html", (v: string | null) => v],
    ["snippet", "snippet", (v: string | null) => v],
    ["outgoing", "outgoing", flag],
    ["read", "read", flag],
    ["flagged", "flagged", flag],
    ["draft", "draft", flag],
    ["size", "size", (v: number | null) => v],
    ["headers", "headers", toJson],
    ["metadata", "metadata", toJson],
  ]
  for (const [field, column, encode] of optional)
    if (mail[field] !== undefined) values.push([column, encode(mail[field] as never)])

  const found = database
    .prepare("SELECT id, email_thread_id FROM emails WHERE account_id = ? AND external_id = ?")
    .get(accountId, mail.externalId)
  let emailId: number
  if (found) {
    emailId = Number(found.id)
    database
      .prepare(
        `UPDATE emails SET ${values.map(([c]) => `${c} = ?`).join(", ")}, deleted_at = NULL, updated_at = ? WHERE id = ?`,
      )
      .run(...values.map(([, v]) => v), now, emailId)
  } else {
    const columns = ["account_id", "external_id", ...values.map(([c]) => c), "created_at", "updated_at"]
    emailId = Number(
      database
        .prepare(
          `INSERT INTO emails (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")}) RETURNING id`,
        )
        .get(accountId, mail.externalId, ...values.map(([, v]) => v), now, now)?.id,
    )
  }

  if (ROLES.some(([field]) => mail[field] !== undefined)) {
    database.prepare("DELETE FROM email_recipients WHERE email_id = ?").run(emailId)
    const insert = database.prepare(
      `INSERT INTO email_recipients (email_id, identity_id, address, name, role, position, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    let position = 0
    for (const [field, role] of ROLES)
      for (const recipient of mail[field] ?? []) {
        const address = recipient.address.trim().toLowerCase()
        const identity = addressIdentity(database, recipient, now)
        insert.run(emailId, identity, address, recipient.name, role, position++, now, now)
      }
  }

  for (const box of mail.mailboxes ?? []) join(database, emailId, mailboxPk(database, accountId, box, now), now)

  if (mail.attachments !== undefined) {
    const positions = mail.attachments.map(({ position }) => position)
    database
      .prepare(
        `DELETE FROM attachments WHERE attachable_type = 'email' AND attachable_id = ?
           AND position NOT IN (SELECT value FROM json_each(?))`,
      )
      .run(emailId, JSON.stringify(positions))
    for (const a of mail.attachments)
      saveAttachment(
        database,
        "email",
        emailId,
        { ...a, normalizedText: a.text === null ? null : normalize(a.text) },
        now,
      )
  }
  return found ? Number(found.email_thread_id) : null
}

const saveThread = (database: CacheDatabase, input: ThreadSave): number => {
  const { accountId, externalId, now } = input
  if (!Number.isSafeInteger(accountId) || accountId <= 0 || !externalId) throw new Error("Invalid thread key")
  const found = database
    .prepare("SELECT id FROM email_threads WHERE account_id = ? AND external_id = ?")
    .get(accountId, externalId)
  const threadId = found
    ? Number(found.id)
    : Number(
        database
          .prepare(
            `INSERT INTO email_threads (account_id, external_id, created_at, updated_at) VALUES (?, ?, ?, ?)
               RETURNING id`,
          )
          .get(accountId, externalId, now, now)?.id,
      )
  if (input.subject !== undefined)
    database.prepare("UPDATE email_threads SET subject = ? WHERE id = ?").run(input.subject, threadId)
  if (input.metadata !== undefined)
    database.prepare("UPDATE email_threads SET metadata = ? WHERE id = ?").run(toJson(input.metadata), threadId)
  const moved = new Set<number>()
  for (const mail of input.emails) {
    const before = saveEmail(database, accountId, threadId, mail, now)
    if (before !== null && before !== threadId) moved.add(before)
  }
  const first = database
    .prepare("SELECT subject FROM emails WHERE email_thread_id = ? ORDER BY coalesce(sent_at, received_at), id LIMIT 1")
    .get(threadId)
  database
    .prepare("UPDATE email_threads SET subject = ? WHERE id = ? AND subject IS NULL")
    .run(titleOf(str(first?.subject)), threadId)
  for (const id of [threadId, ...moved]) recount(database, id, now)
  return threadId
}

const emailWhere = (filter: EmailFilter): [string, SqlValue[]] => {
  const where = ["(? OR e.deleted_at IS NULL)"]
  const params: SqlValue[] = [filter.includeDeleted ? 1 : 0]
  const add = (sql: string, ...values: SqlValue[]) => {
    where.push(sql)
    params.push(...values)
  }
  if (filter.accountId !== undefined) add("e.account_id = ?", filter.accountId)
  if (filter.threadExternalId !== undefined)
    add(
      "e.email_thread_id IN (SELECT id FROM email_threads WHERE external_id = ? AND account_id = e.account_id)",
      filter.threadExternalId,
    )
  if (filter.participant !== undefined) {
    const address = filter.participant.trim().toLowerCase()
    add("(e.from_address = ? OR e.id IN (SELECT email_id FROM email_recipients WHERE address = ?))", address, address)
  }
  if (filter.mailbox !== undefined)
    add(
      `e.id IN (SELECT m.email_id FROM email_mailboxes m JOIN mailboxes b ON b.id = m.mailbox_id
         WHERE b.external_id = ? AND b.account_id = e.account_id)`,
      filter.mailbox,
    )
  if (filter.since !== undefined) add("coalesce(e.received_at, e.sent_at) >= ?", filter.since)
  if (filter.until !== undefined) add("coalesce(e.received_at, e.sent_at) < ?", filter.until)
  return [where.join(" AND "), params]
}

/** Indexes the queued emails, words only: the subject, then the plain-text body. A deleted email leaves the index. */
export const drainEmailIndex = (database: CacheDatabase, batch = 500): number => {
  const next = database.prepare("SELECT id FROM email_index_pending WHERE indexable_type = 'email' LIMIT ?")
  const read = database.prepare("SELECT subject, body_text, deleted_at FROM emails WHERE id = ?")
  const drop = database.prepare("DELETE FROM email_words WHERE rowid = ?")
  const insert = database.prepare("INSERT INTO email_words (rowid, normalized_text, scope) VALUES (?, ?, 'email')")
  const dequeue = database.prepare("DELETE FROM email_index_pending WHERE indexable_type = 'email' AND id = ?")
  let done = 0
  for (;;) {
    const count = inBatch(database, () => {
      const ids = next.all(batch).map((row) => Number(row.id))
      for (const id of ids) {
        drop.run(id)
        const row = read.get(id)
        if (row && row.deleted_at === null) {
          const words = normalize([str(row.subject), str(row.body_text)].filter(Boolean).join("\n\n"))
          if (words) insert.run(id, words)
        }
        dequeue.run(id)
      }
      return ids.length
    })
    if (count === 0) return done
    done += count
  }
}

export const mailStoreOver = ({ database }: Pick<StoreContext, "database">): MailStore => ({
  async saveThread(input) {
    const id = inBatch(database, () => saveThread(database, input))
    return threadDetails(database, id) as ThreadDetails
  },
  async threads(filter = {}) {
    const [limit, offset] = page(filter)
    return database
      .prepare(
        `SELECT * FROM email_threads WHERE (? IS NULL OR account_id = ?) AND (? OR deleted_at IS NULL)
          ORDER BY coalesce(last_email_at, 0) DESC, id DESC LIMIT ? OFFSET ?`,
      )
      .all(filter.accountId ?? null, filter.accountId ?? null, filter.includeDeleted ? 1 : 0, limit, offset)
      .map(threadOf)
  },
  async thread(id) {
    return threadDetails(database, id)
  },
  async email(accountId, externalId) {
    const row = database
      .prepare("SELECT * FROM emails WHERE account_id = ? AND external_id = ?")
      .get(accountId, externalId)
    return row ? emailOf(database, row) : null
  },
  async emails(filter = {}) {
    const [limit, offset] = page(filter)
    const [where, params] = emailWhere(filter)
    return database
      .prepare(
        `SELECT e.* FROM emails e WHERE ${where}
          ORDER BY coalesce(e.sent_at, e.received_at) DESC, e.id DESC LIMIT ? OFFSET ?`,
      )
      .all(...params, limit, offset)
      .map((row) => emailOf(database, row))
  },
  async mailboxes(accountId) {
    return database
      .prepare("SELECT * FROM mailboxes WHERE account_id = ? ORDER BY name, id")
      .all(accountId)
      .map((b) => ({
        id: Number(b.id),
        accountId: Number(b.account_id),
        externalId: String(b.external_id),
        name: String(b.name),
        kind: str(b.kind),
      }))
  },
  async setMailboxes(accountId, scanned, found, now) {
    return inBatch(database, () => {
      const boxes = new Map(scanned.map((box) => [box.externalId, mailboxPk(database, accountId, box, now)]))
      const lookup = database.prepare("SELECT id FROM emails WHERE account_id = ? AND external_id = ?")
      const leave = database.prepare(
        `DELETE FROM email_mailboxes WHERE email_id = ? AND mailbox_id IN (SELECT value FROM json_each(?))
           AND mailbox_id NOT IN (SELECT value FROM json_each(?))`,
      )
      let count = 0
      for (const [externalId, inside] of found) {
        const row = lookup.get(accountId, externalId)
        if (!row) continue
        const kept = inside.map((id) => {
          const pk = boxes.get(id)
          if (pk === undefined) throw new Error(`Mailbox ${id} was not scanned`)
          return pk
        })
        leave.run(Number(row.id), JSON.stringify([...boxes.values()]), JSON.stringify(kept))
        for (const pk of kept) join(database, Number(row.id), pk, now)
        count++
      }
      return count
    })
  },
  async markDeleted(accountId, externalIds, now) {
    return inBatch(database, () => {
      const mark = database.prepare(
        `UPDATE emails SET deleted_at = ?, body_text = NULL, body_html = NULL, snippet = NULL, updated_at = ?
           WHERE account_id = ? AND external_id = ? AND deleted_at IS NULL
           RETURNING id, email_thread_id`,
      )
      const forget = database.prepare(
        "UPDATE attachments SET text = NULL, normalized_text = NULL WHERE attachable_type = 'email' AND attachable_id = ?",
      )
      const threads = externalIds.flatMap((id) =>
        mark.all(now, now, accountId, id).map((r) => {
          forget.run(Number(r.id))
          return Number(r.email_thread_id)
        }),
      )
      for (const id of new Set(threads)) recount(database, id, now)
      return threads.length
    })
  },
  async search(query, filter = {}) {
    const match = wordsQuery(query)
    if (match === null) return []
    const [limit, offset] = page(filter)
    drainEmailIndex(database)
    const [where, params] = emailWhere({ ...filter, includeDeleted: false })
    return database
      .prepare(
        `SELECT e.* FROM email_words w JOIN emails e ON e.id = w.rowid
          WHERE email_words MATCH ? AND ${where}
          ORDER BY coalesce(e.sent_at, e.received_at) DESC, e.id DESC LIMIT ? OFFSET ?`,
      )
      .all(`normalized_text : (${match})`, ...params, limit, offset)
      .map((row) => emailOf(database, row))
  },
})
