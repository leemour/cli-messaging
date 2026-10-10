import { formatLocator } from "../../domain/locator.js"
import { formatReference, parseReference, type Reference } from "../../domain/references.js"
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
  const parsed = typeof reference === "string" ? parseReference(reference) : reference
  const found = (type: EntityType, row: Record<string, unknown> | undefined) =>
    row ? { type, id: Number(row.id) } : undefined
  switch (parsed.type) {
    case "message":
      return found(
        "message",
        database
          .prepare(
            "SELECT m.id FROM messages m JOIN chats c ON c.id = m.chat_id JOIN accounts a ON a.id = c.account_id " +
              "WHERE a.provider = ? AND a.external_id = ? AND c.external_id = ? AND m.external_id = ?",
          )
          .get(parsed.provider, parsed.account, parsed.chat, parsed.message),
      )
    case "chat":
      return found(
        "chat",
        database
          .prepare(
            "SELECT c.id FROM chats c JOIN accounts a ON a.id = c.account_id WHERE a.provider = ? AND a.external_id = ? AND c.external_id = ?",
          )
          .get(parsed.provider, parsed.account, parsed.chat),
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

/** The reference people and agents read for a row; `undefined` once the row is gone. */
export const referenceOfThing = (database: CacheDatabase, thing: Thing): string | undefined => {
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
