import { CliError } from "@wirecat/cli-core"
import type { CacheDatabase } from "../driver.js"
import { drainInvolvementQueue, INSERT, sourcesOf } from "./involvement-queue.js"
import type { StoreContext } from "./open.js"
import { inBatch } from "./search-index.js"

export interface Involvement {
  personId: number
  identityId: number | null
  subjectType: string
  subjectId: number
  role: string
  occurredAt: number
  scope: string
  accountId: number | null
  projectId: number | null
  /** The account's and the chat's own ids, and the message's, where the subject is a message or a chat. */
  provider: string | null
  account: string | null
  chat: string | null
  message: string | null
}

export interface InvolvementStore {
  /** Every row from scratch, or one person's; `store reindex` runs it, and it empties the queue. */
  rebuild(personId?: number): number
  /** Recomputes what is still queued; every write already does this before it commits. */
  drain(): { recomputed: number; pending: number }
  /** How many changes wait in the queue: more than one write recomputes, left for the next one. */
  pending(): number
  /**
   * `since` and `until` are ms, both inclusive. `only` keeps, of `only.provider`, that one account's rows —
   * another account of the same messenger is somebody else's view; other providers and rows of no account stay.
   */
  forPerson(
    personId: number,
    options?: {
      scope?: string
      since?: number
      until?: number
      only?: { provider: string; account: string }
      limit?: number
    },
  ): Involvement[]
}

const pendingInvolvements = (database: CacheDatabase): number =>
  Number(database.prepare("SELECT count(*) AS n FROM involvement_pending").get()?.n ?? 0)

export const involvementStoreOver = ({ database, now }: Pick<StoreContext, "database" | "now">): InvolvementStore => ({
  rebuild: (personId) =>
    inBatch(database, () => {
      if (personId !== undefined && (!Number.isSafeInteger(personId) || personId < 1))
        throw new CliError("validation_error", "a person id is a positive integer")
      database
        .prepare(`DELETE FROM involvements ${personId === undefined ? "" : "WHERE person_id=?"}`)
        .run(...(personId === undefined ? [] : [personId]))
      if (personId === undefined) database.exec("DELETE FROM involvement_pending")
      return database
        .prepare(`${INSERT}
      SELECT s.*, ? FROM (${sourcesOf()}) s JOIN persons p ON p.id=s.person_id ${personId === undefined ? "" : "WHERE s.person_id=?"}`)
        .run(now(), ...(personId === undefined ? [] : [personId])).changes
    }),
  drain: () => {
    const recomputed = inBatch(database, () => drainInvolvementQueue(database))
    return { recomputed, pending: pendingInvolvements(database) }
  },
  pending: () => pendingInvolvements(database),
  forPerson: (personId, { scope, since, until, only, limit = 100 } = {}) => {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000)
      throw new CliError("validation_error", "involvement limit takes 1–1000")
    const filters = [
      ...(scope === undefined ? [] : [["AND i.scope=?", scope] as const]),
      ...(since === undefined ? [] : [["AND i.occurred_at>=?", since] as const]),
      ...(until === undefined ? [] : [["AND i.occurred_at<=?", until] as const]),
    ]
    const account = only === undefined ? [] : [only.provider, only.account]
    return database
      .prepare(
        `SELECT i.*, a.provider, a.external_id AS account, c.external_id AS chat, m.external_id AS message
          FROM involvements i LEFT JOIN accounts a ON a.id=i.account_id
          LEFT JOIN messages m ON i.subject_type='message' AND m.id=i.subject_id
          LEFT JOIN chats c ON c.id=CASE WHEN i.subject_type='chat' THEN i.subject_id ELSE m.chat_id END
          WHERE i.person_id=? ${filters.map(([sql]) => sql).join(" ")}
          ${only === undefined ? "" : "AND (a.provider IS NULL OR a.provider<>? OR a.external_id=?)"} ORDER BY i.occurred_at DESC, i.id DESC LIMIT ?`,
      )
      .all(personId, ...filters.map(([, value]) => value), ...account, limit)
      .map((row) => ({
        personId: Number(row.person_id),
        identityId: row.identity_id == null ? null : Number(row.identity_id),
        subjectType: String(row.subject_type),
        subjectId: Number(row.subject_id),
        role: String(row.role),
        occurredAt: Number(row.occurred_at),
        scope: String(row.scope),
        accountId: row.account_id == null ? null : Number(row.account_id),
        projectId: row.project_id == null ? null : Number(row.project_id),
        provider: row.provider == null ? null : String(row.provider),
        account: row.account == null ? null : String(row.account),
        chat: row.chat == null ? null : String(row.chat),
        message: row.message == null ? null : String(row.message),
      }))
  },
})
