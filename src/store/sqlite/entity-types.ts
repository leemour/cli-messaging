import type { CacheDatabase } from "../driver.js"

/**
 * Every type a `<name>_type` pointer may hold, and the table its `<name>_id` names. A writer that needs
 * a new type adds it here first; `entity-types.test.ts` holds every literal in the store's SQL to this list.
 */
export const ENTITY_TABLES = {
  account: "accounts",
  bot: "bots",
  chat: "chats",
  conversation: "conversations",
  decision: "decisions",
  document: "documents",
  email: "emails",
  email_thread: "email_threads",
  identity: "identities",
  meeting: "meetings",
  memory: "memories",
  message: "messages",
  note: "notes",
  organization: "organizations",
  person: "persons",
  project: "projects",
  tag: "tags",
  task: "tasks",
} as const

export type EntityType = keyof typeof ENTITY_TABLES

export const isEntityType = (type: string): type is EntityType => Object.hasOwn(ENTITY_TABLES, type)

export interface OrphanPointers {
  table: string
  pointer: string
  type: string
  /** Pointers whose row is gone, or every pointer of a type the list does not know. */
  count: number
  known: boolean
}

/** Each `<name>_type` + `<name>_id` pair in the store, found from the tables so a new one is checked too. */
const pointerPairs = (database: CacheDatabase): { table: string; pointer: string }[] =>
  database
    .prepare(
      "SELECT m.name AS tbl, substr(c.name, 1, length(c.name) - 5) AS pointer FROM sqlite_master m " +
        "JOIN pragma_table_info(m.name) c ON c.name LIKE '%\\_type' ESCAPE '\\' " +
        "WHERE m.type = 'table' AND EXISTS (SELECT 1 FROM pragma_table_info(m.name) i " +
        "WHERE i.name = substr(c.name, 1, length(c.name) - 5) || '_id') ORDER BY m.name, c.cid",
    )
    .all()
    .map((row) => ({ table: String(row.tbl), pointer: String(row.pointer) }))

/** Per table, pointer and type: how many pointers name no row. Reports, never repairs. */
export const orphanPointers = (database: CacheDatabase): OrphanPointers[] =>
  pointerPairs(database).flatMap(({ table, pointer }) =>
    database
      .prepare(`SELECT DISTINCT ${pointer}_type AS type FROM ${table} WHERE ${pointer}_type IS NOT NULL ORDER BY type`)
      .all()
      .map((row) => String(row.type))
      .map((type) => {
        const known = isEntityType(type)
        const missing = known
          ? `AND NOT EXISTS (SELECT 1 FROM ${ENTITY_TABLES[type]} t WHERE t.id = p.${pointer}_id)`
          : ""
        const count = Number(
          database.prepare(`SELECT count(*) AS n FROM ${table} p WHERE p.${pointer}_type = ? ${missing}`).get(type)?.n,
        )
        return { table, pointer, type, count, known }
      })
      .filter(({ count }) => count > 0),
  )
