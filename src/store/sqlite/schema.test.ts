import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { eq } from "drizzle-orm"
import { afterEach, describe, expect, it } from "vitest"
import type { CacheDatabase } from "../driver.js"
import { migrate } from "../migrations.js"
import { openCache } from "../open.js"
import { openStore } from "../store.js"
import { LINK_KINDS } from "./link-kinds.js"
import { type OpenedSqlite, openSqlite } from "./open.js"
import { accounts } from "./schema.js"

const DOC = join(import.meta.dirname, "../../../docs/storage/schema.md")
const fresh = () => join(mkdtempSync(join(tmpdir(), "schema-")), "messages.db")
const opened: CacheDatabase[] = []
afterEach(() => {
  for (const database of opened.splice(0)) database.close()
})

const open = async (): Promise<CacheDatabase> => {
  const database = await openCache(fresh())
  opened.push(database)
  return database
}

/** A column as the page writes it: name, type, its constraints and what it references. */
const column = (name: string, type: string, flags: string[], reference: string | undefined): string =>
  [name, type, flags.filter(Boolean).join(", "), reference && `→ ${reference}`].filter(Boolean).join(" ")

/** Every table the page lists, with its columns in order; a full-text index has none. */
const documented = (): Record<string, string[]> => {
  const tables: Record<string, string[]> = {}
  let current: string[] | undefined
  for (const line of readFileSync(DOC, "utf8").split("\n")) {
    if (line.startsWith("## ")) current = undefined
    const heading = /^### `(\w+)`/.exec(line)
    if (heading?.[1]) tables[heading[1]] = current = []
    const virtual = /^CREATE VIRTUAL TABLE (\w+)/.exec(line)
    if (virtual?.[1]) tables[virtual[1]] = []
    if (!current || !/^\| `\w+`/.test(line)) continue
    const [, name = "", type = "", flags = "", reference = ""] = line.split("|").map((cell) => cell.trim())
    current.push(column(/`(\w+)`/.exec(name)?.[1] ?? "", type, flags.split(", "), /`([\w.]+)`/.exec(reference)?.[1]))
  }
  return tables
}

/** What SQLite built, the same way: FTS5's own shadow tables left out. */
const built = (database: CacheDatabase): Record<string, string[]> => {
  const rows = (sql: string) => database.prepare(sql).all()
  const virtual = rows(`SELECT name FROM sqlite_schema WHERE type = 'table' AND sql LIKE 'CREATE VIRTUAL TABLE%'`).map(
    (row) => String(row.name),
  )
  const shadows = new Set(
    virtual.flatMap((name) => ["data", "idx", "docsize", "config", "content"].map((s) => `${name}_${s}`)),
  )
  const tables = rows(`SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`)
    .map((row) => String(row.name))
    .filter((name) => !shadows.has(name))
  const columns = (table: string): string[] => {
    const info = rows(`SELECT name, type, "notnull", pk FROM pragma_table_info('${table}') ORDER BY cid`)
    const singleKey = info.filter((row) => Number(row.pk) > 0).length === 1
    const references = new Map(
      rows(`SELECT "from", "table", "to" FROM pragma_foreign_key_list('${table}')`).map((row) => [
        String(row.from),
        `${String(row.table)}.${String(row.to)}`,
      ]),
    )
    const unique = new Set(
      rows(`SELECT name FROM pragma_index_list('${table}') WHERE "unique" = 1 AND origin = 'u'`)
        .map((index) => rows(`SELECT name FROM pragma_index_info('${String(index.name)}')`))
        .filter((keyed) => keyed.length === 1)
        .map((keyed) => String(keyed[0]?.name)),
    )
    return info.map((row) => {
      const name = String(row.name)
      const key = singleKey && Number(row.pk) > 0
      const flags = [key ? "PK" : "", Number(row.notnull) && !key ? "not null" : "", unique.has(name) ? "unique" : ""]
      return column(name, String(row.type).toLowerCase(), flags, references.get(name))
    })
  }
  return Object.fromEntries(tables.map((name) => [name, virtual.includes(name) ? [] : columns(name)]))
}

/**
 * SQLite compiles a table's triggers into every statement that writes it, so preparing an insert, an
 * update of every column and a delete reaches every trigger body — a column it names that does not exist
 * fails here, not on the first real write.
 */
const writesReachingEveryTrigger = (database: CacheDatabase): string[] => {
  const rows = (sql: string) => database.prepare(sql).all()
  return rows(`SELECT DISTINCT tbl_name FROM sqlite_schema WHERE type = 'trigger' ORDER BY tbl_name`).flatMap((row) => {
    const table = String(row.tbl_name)
    const names = rows(`SELECT name FROM pragma_table_info('${table}')`).map((column) => `"${String(column.name)}"`)
    return [
      `INSERT INTO ${table} SELECT * FROM ${table} WHERE 0`,
      `UPDATE ${table} SET ${names.map((name) => `${name} = ${name}`).join(", ")} WHERE 0`,
      `DELETE FROM ${table} WHERE 0`,
    ]
  })
}

describe("the initial migration", () => {
  it("**creates exactly the tables and columns schema.md lists** when a store opens on an empty path", async () => {
    const path = fresh()
    await (await openStore({ path })).close()
    const database = await openCache(path)
    opened.push(database)

    expect(built(database)).toEqual(documented())
  })

  it("**compiles every trigger** against the columns the tables really have", async () => {
    const database = await open()
    migrate(database)

    const writes = writesReachingEveryTrigger(database)
    expect(writes.length).toBeGreaterThan(30)
    for (const write of writes) expect(() => database.prepare(write), write).not.toThrow()
  })

  it("runs the triggers and full-text indexes on real rows: counts, cleanups, queues and matches", async () => {
    const database = await open()
    migrate(database)
    const run = (sql: string) => database.exec(sql)
    const all = (sql: string) => database.prepare(sql).all()
    const one = (sql: string) => database.prepare(sql).get()

    run(
      `INSERT INTO accounts (provider, external_id, name, created_at, updated_at) VALUES ('telegram', '1', 'Alice', 1, 1)`,
    )
    run(`INSERT INTO identities (provider, external_id, name, username, created_at, updated_at)
           VALUES ('telegram', '2', 'Bob Sample', 'bobsample', 1, 1)`)
    run(`INSERT INTO chats (account_id, external_id, kind, title, updated_at, created_at)
           VALUES (1, '3', 'group', 'Garden club', 1, 1)`)
    run(`INSERT INTO messages (chat_id, account_id, external_id, sender_identity_id, sent_at, text, created_at, source,
           normalized_text, updated_at) VALUES (1, 1, '4', 1, 1, 'Tomatoes ripen', 1, 'sync', 'tomatoes ripen', 1)`)
    run(`INSERT INTO attachments (attachable_type, attachable_id, position, kind, text, normalized_text, created_at,
           updated_at) VALUES ('message', 1, 0, 'document', 'Seed catalogue', 'seed catalogue', 1, 1)`)
    run(`INSERT INTO tags (name, created_at, updated_at) VALUES ('garden', 1, 1)`)
    run(`INSERT INTO taggings (tag_id, taggable_type, taggable_id, source, created_at, updated_at)
           VALUES (1, 'message', 1, 'owner', 1, 1), (1, 'chat', 1, 'owner', 1, 1)`)
    run(`INSERT INTO auto_tag_claims (chat_id, tag_id, algorithm, score, fields, created_at, updated_at)
           VALUES (1, 1, 'rule', 1, '[]', 1, 1)`)
    run(`INSERT INTO aliases (aliasable_type, aliasable_id, account_id, name, name_folded, source, created_at, updated_at)
           VALUES ('identity', 1, NULL, 'Bobby', 'bobby', 'owner', 1, 1), ('chat', 1, NULL, 'Club', 'club', 'owner', 1, 1),
                  ('person', 9, 1, 'B', 'b', 'owner', 1, 1)`)

    for (const index of ["identities_fts", "chats_fts", "messages_fts"])
      run(`INSERT INTO ${index} (${index}) VALUES ('integrity-check')`)
    expect(all(`SELECT rowid FROM identities_fts WHERE identities_fts MATCH 'Sample'`)).toEqual([{ rowid: 1 }])
    expect(all(`SELECT rowid FROM chats_fts WHERE chats_fts MATCH 'Garden'`)).toEqual([{ rowid: 1 }])
    expect(all(`SELECT rowid FROM messages_fts WHERE messages_fts MATCH 'ripen'`)).toEqual([{ rowid: 1 }])
    expect(all(`SELECT rowid FROM message_words WHERE message_words MATCH 'tomatoes AND scope:c1'`)).toEqual([
      { rowid: 1 },
    ])
    expect(all(`SELECT term FROM message_words_vocab WHERE col = 'normalized_text' ORDER BY term`)).toEqual([
      { term: "ripen" },
      { term: "tomatoes" },
    ])
    expect(all(`SELECT rowid FROM attachment_words WHERE attachment_words MATCH 'catalogue'`)).toEqual([{ rowid: 1 }])
    expect(all("SELECT id FROM message_stems_pending")).toEqual([{ id: 1 }])
    expect(one("SELECT message_count FROM chats")).toEqual({ message_count: 1 })

    run("UPDATE messages SET deleted_at = 2")
    expect(one("SELECT message_count FROM chats")).toEqual({ message_count: 0 })
    expect(one("SELECT text, normalized_text FROM attachments")).toEqual({ text: null, normalized_text: null })
    expect(all(`SELECT rowid FROM attachment_words WHERE attachment_words MATCH 'catalogue'`)).toEqual([])
    expect(all("SELECT taggable_type FROM taggings")).toEqual([{ taggable_type: "chat" }])
    run("UPDATE messages SET deleted_at = NULL")
    expect(one("SELECT message_count FROM chats")).toEqual({ message_count: 1 })

    run("DELETE FROM messages")
    expect(one("SELECT count(*) AS n FROM attachments")).toEqual({ n: 0 })
    expect(one("SELECT count(*) AS n FROM message_stems_pending")).toEqual({ n: 0 })
    expect(all(`SELECT rowid FROM message_words WHERE message_words MATCH 'tomatoes'`)).toEqual([])
    run("DELETE FROM chats")
    expect(all("SELECT name FROM aliases ORDER BY name")).toEqual([{ name: "B" }, { name: "Bobby" }])
    expect(one("SELECT count(*) AS n FROM taggings")).toEqual({ n: 0 })
    expect(one("SELECT count(*) AS n FROM auto_tag_claims")).toEqual({ n: 0 })
    run("DELETE FROM identities")
    expect(all("SELECT name FROM aliases")).toEqual([{ name: "B" }])
    run("INSERT INTO identities_fts (identities_fts) VALUES ('integrity-check')")

    run(`INSERT INTO projects (key, name, type, created_at, updated_at) VALUES ('MEET', 'Meetings', 'work', 1, 1)`)
    run(`INSERT INTO tasks (project_id, number, key, title, type, status, author_type, author_id, source, created_at,
           updated_at) VALUES (1, 1, 'MEET-1', 'Send the notes', 'promise', 'open', 'person', 1, 'owner', 1, 1)`)
    run(`INSERT INTO reminders (task_id, account_id, due_at, timezone, state, created_at, updated_at)
           VALUES (1, 1, 5, 'UTC', 'pending', 1, 1), (1, 1, 6, 'UTC', 'pending', 1, 1)`)
    run("UPDATE tasks SET status = 'in_progress'")
    expect(all("SELECT DISTINCT state FROM reminders")).toEqual([{ state: "pending" }])
    run("UPDATE tasks SET status = 'done'")
    expect(all("SELECT DISTINCT state, revision FROM reminders")).toEqual([{ state: "cancelled", revision: 2 }])
    run("DELETE FROM reminders WHERE id = 2")
    run("DELETE FROM accounts")
    expect(one("SELECT count(*) AS n FROM aliases")).toEqual({ n: 0 })
    expect(one("SELECT count(*) AS n FROM reminders")).toEqual({ n: 0 })
  })

  it("queues documents, notes and emails for the indexer and clears what hangs off them on delete", async () => {
    const database = await open()
    migrate(database)
    const run = (sql: string) => database.exec(sql)
    const all = (sql: string) => database.prepare(sql).all()

    run(`INSERT INTO accounts (provider, external_id, created_at, updated_at) VALUES ('folder', 'notes', 1, 1)`)
    run(`INSERT INTO documents (account_id, external_id, kind, title, body, revision, created_at, updated_at)
           VALUES (1, 'a.md', 'file', 'Seeds', 'Sow in March', 1, 1, 1)`)
    run(`INSERT INTO document_revisions (document_id, body, revision, created_at) VALUES (1, 'Sow', 0, 1)`)
    run(`INSERT INTO notes (notable_type, notable_id, body, revision, created_at, updated_at)
           VALUES ('document', 1, 'Check the frost dates', 1, 1, 1)`)
    run(`INSERT INTO chunks (chunkable_type, chunkable_id, position, start_offset, end_offset, content_hash, created_at,
           updated_at) VALUES ('document', 1, 0, 0, 4, 'shared', 1, 1), ('document', 1, 1, 4, 8, 'own', 1, 1),
                              ('note', 1, 0, 0, 5, 'shared', 1, 1)`)
    run(`INSERT INTO embeddings (model, content_hash, dims, vector, created_at, updated_at)
           VALUES ('m', 'shared', 1, x'00000000', 1, 1), ('m', 'own', 1, x'00000000', 1, 1)`)
    run(`INSERT INTO email_threads (account_id, external_id, created_at, updated_at) VALUES (1, 't', 1, 1)`)
    run(`INSERT INTO emails (account_id, email_thread_id, external_id, subject, "references", created_at, updated_at)
           VALUES (1, 1, '<a@example.com>', 'Seeds', '[]', 1, 1)`)
    run(`INSERT INTO email_words (rowid, normalized_text, scope) VALUES (1, 'seeds', '')`)

    expect(all("SELECT indexable_type, id FROM document_index_pending")).toEqual([
      { indexable_type: "document", id: 1 },
    ])
    expect(all("SELECT indexable_type, id FROM note_index_pending")).toEqual([{ indexable_type: "note", id: 1 }])
    expect(all("SELECT indexable_type, id FROM email_index_pending")).toEqual([{ indexable_type: "email", id: 1 }])

    run("DELETE FROM documents")
    expect(all("SELECT content_hash FROM embeddings")).toEqual([{ content_hash: "shared" }])
    expect(all("SELECT chunkable_type FROM chunks")).toEqual([{ chunkable_type: "note" }])
    expect(all("SELECT count(*) AS n FROM document_revisions")).toEqual([{ n: 0 }])
    expect(all("SELECT count(*) AS n FROM document_index_pending")).toEqual([{ n: 0 }])
    run("DELETE FROM notes")
    expect(all("SELECT count(*) AS n FROM embeddings")).toEqual([{ n: 0 }])
    run("DELETE FROM emails")
    expect(all("SELECT count(*) AS n FROM email_index_pending")).toEqual([{ n: 0 }])
    expect(all(`SELECT rowid FROM email_words WHERE email_words MATCH 'seeds'`)).toEqual([])
  })

  it("queues every meeting text by type, so rows of different tables with one id both wait", async () => {
    const database = await open()
    migrate(database)
    const run = (sql: string) => database.exec(sql)

    run(`INSERT INTO accounts (provider, external_id, created_at, updated_at) VALUES ('zoom', 'z', 1, 1)`)
    run(
      `INSERT INTO identities (provider, external_id, name, created_at, updated_at) VALUES ('zoom', 'p', 'Alice Example', 1, 1)`,
    )
    run(`INSERT INTO meetings (account_id, external_id, created_at, updated_at) VALUES (1, 'm', 1, 1)`)
    run(`INSERT INTO meeting_participants (meeting_id, identity_id, created_at, updated_at) VALUES (1, 1, 1, 1)`)
    run(`INSERT INTO meeting_transcripts (meeting_id, source, created_at, updated_at) VALUES (1, 'api', 1, 1)`)
    run(`INSERT INTO meeting_transcript_rows (meeting_transcript_id, position, start_ms, end_ms, speaker_participant_id,
           text, created_at) VALUES (1, 0, 0, 900, 1, 'Hello', 1)`)
    run(
      `INSERT INTO meeting_chat_messages (meeting_id, sent_at, text, created_at, updated_at) VALUES (1, 1, 'Hi', 1, 1)`,
    )
    run(
      `INSERT INTO meeting_summaries (meeting_id, source, overview, created_at, updated_at) VALUES (1, 'llm', 'A call', 1, 1)`,
    )
    run("DELETE FROM meeting_index_pending")
    run("UPDATE meeting_transcript_rows SET text = 'Hello there'")
    run("DELETE FROM meeting_chat_messages")

    expect(
      database.prepare("SELECT indexable_type, id FROM meeting_index_pending ORDER BY indexable_type").all(),
    ).toEqual([
      { indexable_type: "meeting_chat_message", id: 1 },
      { indexable_type: "meeting_transcript_row", id: 1 },
    ])
  })

  it("nests chats and threads, and keeps one main topic per thing", async () => {
    const database = await open()
    migrate(database)
    const run = (sql: string) => database.exec(sql)
    const all = (sql: string) => database.prepare(sql).all()

    run(`INSERT INTO accounts (provider, external_id, created_at, updated_at) VALUES ('telegram', '1', 1, 1)`)
    run(`INSERT INTO chats (account_id, external_id, kind, title, updated_at, created_at)
           VALUES (1, 'g', 'group', 'Garden club', 1, 1)`)
    run(`INSERT INTO chats (account_id, external_id, kind, title, parent_chat_id, updated_at, created_at)
           VALUES (1, 'g/7', 'topic', 'Tomatoes', 1, 1, 1)`)
    run(`INSERT INTO messages (chat_id, account_id, external_id, sent_at, text, created_at, source, updated_at)
           VALUES (2, 1, '10', 1, 'Which variety?', 1, 'sync', 1)`)
    run(`INSERT INTO messages (chat_id, account_id, external_id, sent_at, text, created_at, source, thread_root_id,
           updated_at) VALUES (2, 1, '11', 2, 'Cherry ones', 1, 'sync', 1, 1)`)
    expect(
      all("SELECT c.title FROM chats c JOIN chats p ON p.id = c.parent_chat_id WHERE p.title = 'Garden club'"),
    ).toEqual([{ title: "Tomatoes" }])
    expect(() =>
      run(`INSERT INTO messages (chat_id, account_id, external_id, sent_at, text, created_at, source,
           thread_root_id, updated_at) VALUES (2, 1, '12', 3, 'x', 1, 'sync', 99, 1)`),
    ).toThrow(/FOREIGN KEY/)

    run(`INSERT INTO tags (name, kind, created_at, updated_at) VALUES ('Food', 'topic', 1, 1), ('Wellbeing', 'topic', 1, 1),
           ('animals', 'tag', 1, 1)`)
    expect(() => run(`INSERT INTO tags (name, kind, created_at, updated_at) VALUES ('Food', 'tag', 1, 1)`)).toThrow(
      /UNIQUE/,
    )
    run(`INSERT INTO taggings (tag_id, taggable_type, taggable_id, main, source, created_at, updated_at)
           VALUES (1, 'chat', 1, 1, 'owner', 1, 1), (3, 'chat', 1, 0, 'owner', 1, 1)`)
    expect(() =>
      run(`INSERT INTO taggings (tag_id, taggable_type, taggable_id, main, source, created_at, updated_at)
           VALUES (2, 'chat', 1, 1, 'owner', 1, 1)`),
    ).toThrow(/UNIQUE/)
    run(`INSERT INTO taggings (tag_id, taggable_type, taggable_id, source, created_at, updated_at)
           VALUES (2, 'chat', 1, 'owner', 1, 1)`)
    expect(all("SELECT count(*) AS n FROM taggings WHERE taggable_id = 1")).toEqual([{ n: 3 }])
  })

  it("queues memories for the indexer and drops their chunks, orphan vectors and evidence links with them", async () => {
    const database = await open()
    migrate(database)
    const run = (sql: string) => database.exec(sql)
    const all = (sql: string) => database.prepare(sql).all()

    run(`INSERT INTO memories (kind, body, subject_type, subject_id, author_type, author_id, status, scope, created_at,
           updated_at) VALUES ('fact', 'Prefers weekly reports', 'person', 1, 'bot', 1, 'proposed', 'work', 1, 1)`)
    expect(all("SELECT indexable_type, id FROM memory_index_pending")).toEqual([{ indexable_type: "memory", id: 1 }])
    run(`INSERT INTO chunks (chunkable_type, chunkable_id, position, start_offset, end_offset, content_hash, created_at,
           updated_at) VALUES ('memory', 1, 0, 0, 5, 'm1', 1, 1)`)
    run(`INSERT INTO embeddings (model, content_hash, dims, vector, created_at, updated_at)
           VALUES ('m', 'm1', 1, x'00000000', 1, 1)`)
    run(`INSERT INTO links (from_type, from_id, to_type, to_id, kind, source, confirmed, created_at, updated_at)
           VALUES ('memory', 1, 'message', 5, 'evidence', 'agent', 1, 1, 1)`)
    run("DELETE FROM memories")

    for (const table of ["memory_index_pending", "chunks", "embeddings", "links"])
      expect(all(`SELECT count(*) AS n FROM ${table}`), table).toEqual([{ n: 0 }])
  })

  it("finds everything a person took part in through one index", async () => {
    const database = await open()
    migrate(database)
    database.exec(`INSERT INTO persons (name, created_at, updated_at) VALUES ('Alice Example', 1, 1)`)
    database.exec(`INSERT INTO involvements (person_id, subject_type, subject_id, role, occurred_at, scope, created_at)
           VALUES (1, 'message', 3, 'sender', 10, 'work', 1), (1, 'meeting', 1, 'participant', 20, 'work', 1),
                  (1, 'message', 4, 'mentioned', 5, 'personal', 1)`)
    const query =
      "SELECT subject_type, subject_id FROM involvements WHERE person_id = 1 AND scope = 'work' ORDER BY occurred_at DESC"

    expect(database.prepare(query).all()).toEqual([
      { subject_type: "meeting", subject_id: 1 },
      { subject_type: "message", subject_id: 3 },
    ])
    expect(JSON.stringify(database.prepare(`EXPLAIN QUERY PLAN ${query}`).all())).toMatch(/involvements_by_person/)
  })

  it("reads through Drizzle what the hand-written SQL wrote, over one connection", async () => {
    const store: OpenedSqlite = await openSqlite(fresh())
    migrate(store.database)
    store.database
      .prepare("INSERT INTO accounts (provider, external_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
      .run("telegram", "100", "Alice", 1, 2)

    expect(await store.orm.select().from(accounts).where(eq(accounts.externalId, "100"))).toEqual([
      {
        id: 1,
        provider: "telegram",
        externalId: "100",
        name: "Alice",
        createdAt: 1,
        settings: null,
        status: null,
        updatedAt: 2,
        scope: "personal",
        organizationId: null,
      },
    ])
    store.database.close()
  })
})

describe("what the initial migration seeds and enforces", () => {
  it("seeds the owner person, the rule and agent bots, and a state row for every search index", async () => {
    const database = await open()
    migrate(database)

    expect(database.prepare("SELECT name, owner FROM persons").all()).toEqual([{ name: null, owner: 1 }])
    expect(database.prepare("SELECT name, kind FROM bots ORDER BY name").all()).toEqual([
      { name: "agent", kind: "agent" },
      { name: "rule", kind: "script" },
    ])
    expect(
      database
        .prepare("SELECT name FROM search_index_state ORDER BY name")
        .all()
        .map((row) => row.name),
    ).toEqual(["document_index", "memory_index", "message_stems", "message_words", "note_index"])
  })

  it("refuses a second displayed alias, a second summary from one source and a repeated meeting chat line", async () => {
    const database = await open()
    migrate(database)
    const run = (sql: string) => database.exec(sql)
    const alias = (account: string, display: number) =>
      `INSERT INTO aliases (aliasable_type, aliasable_id, account_id, name, name_folded, display, source, created_at,
         updated_at) VALUES ('person', 1, ${account}, 'Ali', 'ali', ${display}, 'owner', 1, 1)`
    run(
      `INSERT INTO accounts (provider, external_id, scope, created_at, updated_at) VALUES ('zoom', 'a', 'work', 1, 1)`,
    )
    run(alias("NULL", 1))
    run(alias("NULL", 0))
    run(alias("1", 1))
    run(`INSERT INTO meetings (account_id, external_id, created_at, updated_at) VALUES (1, 'm', 1, 1)`)
    run(`INSERT INTO meeting_summaries (meeting_id, source, created_at, updated_at) VALUES (1, 'zoom-ai', 1, 1)`)
    const line = (externalId: string) =>
      `INSERT INTO meeting_chat_messages (meeting_id, external_id, sent_at, text, created_at, updated_at)
         VALUES (1, ${externalId}, 1, 'hi', 1, 1)`
    run(line("'c1'"))
    run(line("NULL"))
    run(line("NULL"))

    expect(() => run(alias("NULL", 1))).toThrow(/UNIQUE/)
    expect(() =>
      run(`INSERT INTO meeting_summaries (meeting_id, source, created_at, updated_at) VALUES (1, 'zoom-ai', 1, 1)`),
    ).toThrow(/UNIQUE/)
    expect(() => run(line("'c1'"))).toThrow(/UNIQUE/)
  })

  it("purges an email with its recipients, mailboxes, chunks and unshared embeddings, and an account's links", async () => {
    const database = await open()
    migrate(database)
    const run = (sql: string) => database.exec(sql)
    const count = (table: string) => Number(database.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.n)
    run(
      `INSERT INTO accounts (provider, external_id, scope, created_at, updated_at) VALUES ('mail', 'a', 'work', 1, 1)`,
    )
    run(
      `INSERT INTO email_threads (account_id, external_id, emails_count, created_at, updated_at) VALUES (1, 't', 2, 1, 1)`,
    )
    for (const id of [1, 2])
      run(`INSERT INTO emails (id, account_id, email_thread_id, external_id, created_at, updated_at)
             VALUES (${id}, 1, 1, 'e${id}', 1, 1)`)
    run(`INSERT INTO email_recipients (email_id, address, role, position, created_at, updated_at)
           VALUES (1, 'bob@example.com', 'to', 0, 1, 1)`)
    run(
      `INSERT INTO mailboxes (account_id, external_id, name, created_at, updated_at) VALUES (1, 'INBOX', 'Inbox', 1, 1)`,
    )
    run(`INSERT INTO email_mailboxes (email_id, mailbox_id, created_at) VALUES (1, 1, 1)`)
    for (const [email, hash] of [
      [1, "only"],
      [1, "shared"],
      [2, "shared"],
    ] as const)
      run(`INSERT INTO chunks (chunkable_type, chunkable_id, position, start_offset, end_offset, content_hash, created_at,
             updated_at) VALUES ('email', ${email}, ${hash === "only" ? 0 : email}, 0, 1, '${hash}', 1, 1)`)
    for (const hash of ["only", "shared"])
      run(`INSERT INTO embeddings (model, content_hash, dims, vector, created_at, updated_at)
             VALUES ('m', '${hash}', 1, x'00', 1, 1)`)
    run(`INSERT INTO tags (name, kind, created_at, updated_at) VALUES ('work', 'tag', 1, 1)`)
    run(`INSERT INTO links (from_type, from_id, to_type, to_id, kind, anchor, source, created_at, updated_at)
           VALUES ('account', 1, 'tag', 1, 'labelled', 'Projects', 'owner', 1, 1)`)

    run("DELETE FROM emails WHERE id = 1")
    expect([count("email_recipients"), count("email_mailboxes"), count("chunks")]).toEqual([0, 0, 1])
    expect(database.prepare("SELECT content_hash FROM embeddings").all()).toEqual([{ content_hash: "shared" }])

    run("DELETE FROM emails")
    run("DELETE FROM email_threads")
    run("DELETE FROM mailboxes")
    run("DELETE FROM accounts")
    expect(count("links")).toBe(0)
  })
})

describe("the link kinds", () => {
  it("are the ones the schema doc describes for `links`, no more and no fewer", () => {
    const page = readFileSync(DOC, "utf8")
    const description = page.slice(page.indexOf("### `links`")).split("\n\n")[1] ?? ""
    // A kind is named outside parentheses; what it explains inside them may name a column.
    const named = [...description.replace(/\([^)]*\)/g, "").matchAll(/`([a-z-]+)`/g)].map((match) => match[1])

    expect(named.sort()).toEqual([...LINK_KINDS].sort())
  })
})
