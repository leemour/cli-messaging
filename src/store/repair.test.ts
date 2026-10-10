import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import type { CacheDatabase, SqlValue } from "./driver.js"
import { migrate } from "./migrations.js"
import { openCache } from "./open.js"
import { copiesIn, deleteCopy, repairStore } from "./repair.js"
import { openStore } from "./store.js"

/** A deliberately incomplete conversation schema for repair checks. */
const DRAFT_13 = [
  `CREATE TABLE conversation_messages (
     conversation_id integer NOT NULL,
     message_id integer NOT NULL UNIQUE,
     CONSTRAINT fk_conversation_messages_conversation_pk_conversations_pk_fk FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
     CONSTRAINT fk_conversation_messages_message_pk_messages_pk_fk FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
   )`,
  `CREATE TABLE conversation_state (
     chat_id integer PRIMARY KEY,
     enabled_at integer NOT NULL,
     built_at integer,
     algorithm_version integer,
     CONSTRAINT fk_conversation_state_chat_pk_chats_pk_fk FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE CASCADE
   )`,
  `CREATE TABLE conversations (
     id integer PRIMARY KEY,
     chat_id integer NOT NULL,
     first_message_id integer NOT NULL,
     first_at integer NOT NULL,
     last_at integer NOT NULL,
     message_count integer NOT NULL,
     built_at integer NOT NULL,
     algorithm_version integer NOT NULL,
     CONSTRAINT fk_conversations_chat_pk_chats_pk_fk FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE CASCADE,
     CONSTRAINT fk_conversations_first_message_pk_messages_pk_fk FOREIGN KEY (first_message_id) REFERENCES messages(id) ON DELETE CASCADE
   )`,
  `CREATE TABLE message_links (
     message_id integer NOT NULL,
     parent_id integer,
     source text NOT NULL,
     kind text NOT NULL,
     confidence real NOT NULL,
     method text NOT NULL,
     version text,
     batch text,
     created_at integer NOT NULL,
     stale_at integer,
     CONSTRAINT fk_message_links_message_pk_messages_pk_fk FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE,
     CONSTRAINT fk_message_links_parent_id_messages_pk_fk FOREIGN KEY (parent_id) REFERENCES messages(id) ON DELETE CASCADE,
     CONSTRAINT message_links_message_pk_parent_id_source_kind_unique UNIQUE(message_id, parent_id, source, kind)
   )`,
  "CREATE INDEX conversation_messages_by_conversation ON conversation_messages (conversation_id)",
  "CREATE INDEX conversations_by_chat ON conversations (chat_id, first_at)",
  "CREATE UNIQUE INDEX message_links_start ON message_links (message_id, source, kind) WHERE parent_id IS NULL",
  "CREATE INDEX message_links_by_parent ON message_links (parent_id)",
]

/** Fills a row's required columns with placeholders, so a fixture survives columns added later. */
const insert = (database: CacheDatabase, table: string, given: Record<string, SqlValue>): number => {
  const required = database
    .prepare(
      `SELECT name, type FROM pragma_table_info('${table}') WHERE "notnull" = 1 AND dflt_value IS NULL AND pk = 0`,
    )
    .all()
  const values: Record<string, SqlValue> = {}
  for (const { name, type } of required) values[String(name)] = /INT|REAL/i.test(String(type)) ? 1 : "x"
  Object.assign(values, given)
  const names = Object.keys(values)
  const run = database
    .prepare(`INSERT INTO ${table} (${names.join(", ")}) VALUES (${names.map(() => "?").join(", ")})`)
    .run(...Object.values(values))
  expect(run.changes).toBe(1)
  return Number(database.prepare("SELECT last_insert_rowid() AS pk").get()?.pk)
}

/** A baseline store with incomplete conversation tables and one synthetic message. */
const draftStore = async ({ rows = false } = {}) => {
  const path = join(mkdtempSync(join(tmpdir(), "repair-")), "messages.db")
  const database = await openCache(path)
  migrate(database)
  database.exec(
    "PRAGMA foreign_keys=OFF; DROP TABLE conversation_messages; DROP TABLE conversation_state; DROP TABLE conversations; DROP TABLE message_links; DROP TRIGGER involvement_message_au; ALTER TABLE messages DROP COLUMN mentions",
  )
  for (const statement of DRAFT_13) database.exec(statement)
  database.exec("PRAGMA foreign_keys=ON")
  const account = insert(database, "accounts", { provider: "telegram", external_id: "100" })
  const chat = insert(database, "chats", { account_id: account, external_id: "-1001" })
  const message = insert(database, "messages", { account_id: account, chat_id: chat, external_id: "1", text: "hello" })
  if (rows) {
    const conversation = insert(database, "conversations", { chat_id: chat, first_message_id: message })
    insert(database, "conversation_messages", { conversation_id: conversation, message_id: message })
    insert(database, "conversation_state", { chat_id: chat, enabled_at: 1 })
    insert(database, "message_links", { message_id: message, source: "reply", kind: "reply" })
  }
  return { path, database }
}

const shapeOf = (database: CacheDatabase) =>
  database
    .prepare(
      "SELECT type, name, tbl_name FROM sqlite_master WHERE tbl_name NOT LIKE '%__repair_%' AND name NOT LIKE 'sqlite_%' ORDER BY type, name",
    )
    .all()

const publishedShape = async () => {
  const database = await openCache(":memory:")
  migrate(database)
  const shape = shapeOf(database)
  database.close()
  return shape
}

const repair = async (database: CacheDatabase, options: { dryRun?: boolean } = {}) => {
  const fresh = await openCache(":memory:")
  try {
    return repairStore(database, fresh, options)
  } finally {
    fresh.close()
  }
}

const columnsOf = (database: CacheDatabase, table: string) =>
  database
    .prepare(`SELECT name FROM pragma_table_info('${table}')`)
    .all()
    .map((row) => String(row.name))

describe("store repair", () => {
  it("brings an incomplete store to the published shape, keeping its messages and the old tables as copies", async () => {
    const { database } = await draftStore()

    const report = await repair(database)

    expect(shapeOf(database)).toEqual(await publishedShape())
    expect(columnsOf(database, "messages")).toContain("mentions")
    expect(Number(database.prepare("SELECT count(*) AS n FROM messages").get()?.n)).toBe(1)
    expect(report.repaired.find((one) => one.table === "messages")).toEqual({
      table: "messages",
      action: "columns-added",
      columnsAdded: ["mentions"],
    })
    expect(report.repaired.find((one) => one.table === "conversation_state")).toMatchObject({
      action: "columns-added",
      columnsAdded: ["current_build"],
    })
    expect(
      report.repaired
        .filter((one) => one.action === "rebuilt")
        .map((one) => one.table)
        .sort(),
    ).toEqual(["conversation_messages", "conversations", "message_links"])
    expect(report.copies.map((one) => one.name.replace(/[0-9a-f]{8}$/, "<hash>"))).toEqual([
      "conversation_messages__repair_<hash>",
      "conversations__repair_<hash>",
      "message_links__repair_<hash>",
    ])
    expect(report.mismatches).toEqual([])
    expect(report.foreignKeyViolations).toEqual([])
    database.close()
  })

  it("points other tables' keys at the new table, not the copy", async () => {
    const { database } = await draftStore()

    await repair(database)

    const parents = database
      .prepare("SELECT DISTINCT \"table\" AS parent FROM pragma_foreign_key_list('conversation_messages')")
      .all()
      .map((row) => String(row.parent))
      .sort()
    expect(parents).toEqual(["conversations", "messages"])
    database.close()
  })

  it("copies the rows that fit and keeps the rest in the copy, counted", async () => {
    const { database } = await draftStore({ rows: true })

    const report = await repair(database)
    const by = (table: string) => report.repaired.find((one) => one.table === table)

    // `conversations.build` and `message_links.chat_id` are NOT NULL with nothing to fill them from.
    expect(by("conversations")).toMatchObject({ rowsInCopy: 1, rowsCopied: 0 })
    expect(by("message_links")).toMatchObject({ rowsInCopy: 1, rowsCopied: 0 })
    expect(by("conversation_messages")).toMatchObject({ rowsInCopy: 1, rowsCopied: 1 })
    expect(Number(database.prepare("SELECT count(*) AS n FROM conversation_state").get()?.n)).toBe(1)
    expect(report.copies.every((one) => one.rows === 1)).toBe(true)
    database.close()
  })

  it("does nothing the second time", async () => {
    const { database } = await draftStore()
    await repair(database)

    const again = await repair(database)

    expect(again.repaired).toEqual([])
    expect(again.indexesCreated).toEqual([])
    expect(again.copies).toHaveLength(3)
    database.close()
  })

  it("reports exactly on a dry run and changes nothing", async () => {
    const { database } = await draftStore()
    migrate(database)
    const before = database.prepare("SELECT type, name, sql FROM sqlite_master ORDER BY name").all()

    const dry = await repair(database, { dryRun: true })

    expect(dry.dryRun).toBe(true)
    expect(dry.repaired).toHaveLength(5)
    expect(database.prepare("SELECT type, name, sql FROM sqlite_master ORDER BY name").all()).toEqual(before)
    database.close()
  })

  it("refuses a dry run on a file behind this build, which it could not compare without migrating", async () => {
    const { database } = await draftStore()

    database.exec("DELETE FROM schema_migrations")
    await expect(repair(database, { dryRun: true })).rejects.toThrow("store migrate")
    database.close()
  })

  it("lets a store read its messages again, which the draft broke", async () => {
    const { path, database } = await draftStore()
    const env = { MESSAGING_STORE: path }
    const read = async () => {
      const store = await openStore({ env })
      try {
        return await store.message({ provider: "telegram", account: "100" }, "1", { chatId: "-1001" })
      } finally {
        await store.close()
      }
    }

    await expect(read()).rejects.toThrow("Failed query")
    await repair(database)
    database.close()

    expect((await read())?.text).toBe("hello")
  })

  it("deletes one copy by its exact name and refuses anything else", async () => {
    const { database } = await draftStore()
    await repair(database)
    const [first] = copiesIn(database)

    expect(() => deleteCopy(database, "messages")).toThrow("not a repair copy")
    expect(() => deleteCopy(database, "conversations__repair_00000000")).toThrow("not a repair copy")
    expect(deleteCopy(database, first?.name ?? "")).toEqual(first)
    expect(copiesIn(database)).toHaveLength(2)
    database.close()
  })
})
