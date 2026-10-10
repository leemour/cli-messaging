import { spawn } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { captureStreams } from "@wirecat/cli-core"
import { describe, expect, it } from "vitest"
import { holdersOf } from "../../background/processes.js"
import { RULES_VERSION } from "../../conversations/link.js"
import { MIGRATIONS, migrate } from "../../store/migrations.js"
import { openCache } from "../../store/open.js"
import { configCommand } from "../config-command.js"
import { run } from "../program.js"
import { settingsFor } from "../settings.js"
import { storeCommand } from "./archive-commands.js"
import type { Messenger } from "./context.js"
import { lockPath } from "./serve-command.js"

const app = { command: "chat", appName: "chat-cli", envPrefix: "CHAT", description: "A test", version: "1.0.0" }
const latest = MIGRATIONS.at(-1)?.version ?? 0
const DAY = 24 * 60 * 60 * 1000

const envFor = () => {
  const root = mkdtempSync(join(tmpdir(), "store-maintenance-"))
  return {
    CHAT_STATE_DIR: join(root, "state"),
    CHAT_CONFIG_DIR: join(root, "config"),
    MESSAGING_STORE: join(root, "m.db"),
  }
}

/** A file at `version`, one chat whose list says a message came a day after the newest one held. */
const seeded = async (env: NodeJS.ProcessEnv, version = latest) => {
  const database = await openCache(String(env.MESSAGING_STORE))
  migrate(database, { migrations: MIGRATIONS.filter((migration) => migration.version <= version) })
  database.exec(
    `INSERT INTO accounts (id, provider, external_id, created_at,updated_at) VALUES (1, 'chat', '500', 0,0)`,
  )
  database.exec(
    `INSERT INTO chats (id, account_id, external_id, kind, title, last_message_at, updated_at,created_at)
     VALUES (1, 1, '7', 'group', 'Book club', ${2 * DAY}, ${DAY},0), (2, 1, '8', 'private', 'Ana', ${DAY}, ${DAY},0)`,
  )
  database.exec(
    `INSERT INTO messages (chat_id, account_id, external_id, sent_at, text, created_at, source,updated_at)
     VALUES (1, 1, '1', ${DAY}, 'Hola, ¿qué tal?', 0, 'fetch',0), (2, 1, '1', ${DAY}, 'Ёлка', 0, 'fetch',0)`,
  )
  return database
}

const call = async (argv: string[], env: NodeJS.ProcessEnv) => {
  const messenger: Messenger = {
    app,
    provider: "chat",
    resolveSettings: settingsFor(app).resolveSettings,
    connect: async () => {
      throw new Error("the store's maintenance never connects")
    },
    chatArgument: "a chat",
  }
  const streams = captureStreams()
  const commands = () => [storeCommand(messenger), configCommand(app, settingsFor(app))]
  const code = await run(argv, { app, commands }, { streams, tty: false, env })
  return { code, stdout: streams.stdout, stderr: streams.stderr, answer: JSON.parse(streams.stdout[0] ?? "null") }
}

describe("store info", () => {
  it("says there is no file rather than creating one", async () => {
    const env = envFor()
    const { answer } = await call(["store", "info", "--json"], env)
    expect(answer).toEqual({ path: env.MESSAGING_STORE, exists: false })
  })

  it("reads a baseline file without changing its normalization state", async () => {
    const env = envFor()
    ;(await seeded(env, latest)).close()

    const { answer } = await call(["store", "info", "--json"], env)
    expect(answer).toMatchObject({
      schema: { version: latest, speaks: latest, writable: true },
      rows: { accounts: 1, chats: 2, messages: 2 },
      pendingNormalization: 2,
    })
    expect((await call(["store", "info", "--json"], env)).answer.schema.version).toBe(latest)
  })
})

describe("store check", () => {
  it("**prints one JSON value on stdout and the advice on stderr**", async () => {
    const env = envFor()
    ;(await seeded(env)).close()

    const { code, stdout, stderr, answer } = await call(["store", "check", "--json"], env)
    expect(code).toBe(0)
    expect(stdout).toHaveLength(1)
    expect(answer).toMatchObject({
      ok: true,
      integrity: ["ok"],
      foreignKeyViolations: 0,
      searchIndexes: { messages_fts: "ok", chats_fts: "ok", identities_fts: "ok" },
    })
    expect(stderr.join("\n")).toContain("chat store fetch <chat>")
  })

  it("names a note left on a deleted message, and a pointer of an unknown type, as orphans", async () => {
    const env = envFor()
    const database = await seeded(env)
    database.exec(
      `INSERT INTO notes (notable_type, notable_id, body, created_at, updated_at)
       VALUES ('message', 1, 'kept', 0, 0), ('message', 2, 'orphaned', 0, 0), ('gizmo', 1, 'unknown', 0, 0);
       DELETE FROM messages WHERE id = 2`,
    )
    database.close()

    const { answer, stderr } = await call(["store", "check", "--json"], env)
    expect(answer.orphanPointers).toEqual([
      { table: "notes", pointer: "notable", type: "gizmo", count: 1, known: false },
      { table: "notes", pointer: "notable", type: "message", count: 1, known: true },
    ])
    expect(stderr.join("\n")).toContain("2 pointers name a row that is gone")
  })

  it("names the chat whose held history stops before its newest message", async () => {
    const env = envFor()
    ;(await seeded(env)).close()

    const { answer } = await call(["store", "check", "--json"], env)
    expect(answer.chatsBehind).toEqual([
      {
        provider: "chat",
        account: "500",
        chat: "7",
        title: "Book club",
        newest: new Date(2 * DAY).toISOString(),
        held: new Date(DAY).toISOString(),
        refreshed: new Date(DAY).toISOString(),
      },
    ])
  })

  it("names the chats whose conversations older rules built, and the agent links gone stale", async () => {
    const env = envFor()
    const database = await seeded(env)
    database.exec(
      `INSERT INTO conversation_state (chat_id, enabled_at, built_at, algorithm_version, current_build)
       VALUES (1, 0, ${DAY}, 1, 1), (2, 0, ${2 * DAY}, ${RULES_VERSION}, 1)`,
    )
    database.exec(
      `INSERT INTO message_links (chat_id, message_id, parent_id, source, kind, confidence, method, created_at, stale_at,updated_at)
       SELECT chat_id, id, NULL, 'agent', 'start', 0.9, 'model', 0, ${DAY} ,0 FROM messages WHERE chat_id = 1`,
    )
    database.close()

    const { answer, stderr } = await call(["store", "check", "--json"], env)
    expect(answer.conversations).toEqual([
      expect.objectContaining({ chat: "8", rulesVersion: RULES_VERSION, current: true, staleAgentLinks: 0 }),
      expect.objectContaining({ chat: "7", rulesVersion: 1, current: false, staleAgentLinks: 1 }),
    ])
    expect(stderr.join("\n")).toContain("1 chats' conversations were built by older rules — `chat conversations build")
  })

  it("**reports a search index that no longer matches its table**, and repairs nothing", async () => {
    const env = envFor()
    const database = await seeded(env)
    database.exec("DROP TRIGGER messages_fts_au")
    database.exec("UPDATE messages SET text = 'changed behind the index' WHERE id = 1")
    database.close()

    const first = (await call(["store", "check", "--json"], env)).answer
    expect(first.ok).toBe(false)
    expect(first.checks.searchIndexes).toBe(false)
    expect(first.searchIndexes.messages_fts).not.toBe("ok")
    expect((await call(["store", "check", "--json"], env)).answer.searchIndexes).toEqual(first.searchIndexes)
  })
})

describe("a file that is empty or is not a database", () => {
  it("answers for the empty file a store makes before its first migration", async () => {
    const env = envFor()
    writeFileSync(String(env.MESSAGING_STORE), "")

    expect((await call(["store", "info", "--json"], env)).answer).toMatchObject({ schema: { version: 0 }, rows: {} })
    const { answer, stdout } = await call(["store", "check", "--json"], env)
    expect(stdout).toHaveLength(1)
    expect(answer).toMatchObject({ opens: true, ok: false, checks: { schema: false }, searchIndexes: {} })
  })

  it("**says a file that will not open does not open**, instead of failing", async () => {
    const env = envFor()
    writeFileSync(String(env.MESSAGING_STORE), "not a database, not even close".repeat(40))

    for (const command of ["info", "check"]) {
      const { code, stdout, answer } = await call(["store", command, "--json"], env)
      expect(code).toBe(0)
      expect(stdout).toHaveLength(1)
      expect(answer).toMatchObject({ exists: true, opens: false, error: expect.any(String) })
    }
  })
})

describe("store migrate", () => {
  it("normalizes the baseline file, saying so on stderr", async () => {
    const env = envFor()
    ;(await seeded(env, latest)).close()

    const { answer, stderr } = await call(["store", "migrate", "--json"], env)
    expect(answer).toEqual({
      path: env.MESSAGING_STORE,
      exists: true,
      from: latest,
      to: latest,
      normalized: 2,
      indexed: 0,
      terms: 4,
      stemmed: 2,
      notesIndexed: 0,
    })
    expect(stderr.join("\n")).toContain("2 of 2 normalized")

    const database = await openCache(String(env.MESSAGING_STORE))
    expect(database.prepare("SELECT normalized_text FROM messages ORDER BY id").all()).toEqual([
      { normalized_text: "hola, ¿que tal?" },
      { normalized_text: "елка" },
    ])
    database.close()
    expect((await call(["store", "migrate", "--json"], env)).answer).toMatchObject({ from: latest, normalized: 0 })
  })
})

describe("the word index", () => {
  const words = async (env: NodeJS.ProcessEnv, word: string) => {
    const database = await openCache(String(env.MESSAGING_STORE))
    try {
      return database
        .prepare("SELECT rowid FROM message_words WHERE message_words MATCH ?")
        .all(`normalized_text: ${word}`).length
    } finally {
      database.close()
    }
  }

  it("**`store reindex` rebuilds it and its vocabulary** from the stored messages", async () => {
    const env = envFor()
    ;(await seeded(env)).close()
    await call(["store", "migrate", "--json"], env)

    const { answer } = await call(["store", "reindex", "--json"], env)

    expect(answer).toEqual({
      path: env.MESSAGING_STORE,
      exists: true,
      normalized: 0,
      indexed: 2,
      terms: 4,
      fileTexts: 0,
      stemmed: 2,
      notesIndexed: 0,
      involvements: 0,
    })
    expect(await words(env, "hola")).toBe(1)
    const { answer: info } = await call(["store", "info", "--json"], env)
    expect(info.wordIndex).toMatchObject({ watermark: 2, filledThrough: 2, ready: true, pendingNormalization: 0 })
  })

  it("**`store check` checks it, and says how far a large file's fill has come**", async () => {
    const env = envFor()
    const database = await seeded(env)
    database.exec("UPDATE search_index_state SET watermark = 10, filled_through = 1")
    database.close()

    const { answer, stderr } = await call(["store", "check", "--json"], env)

    expect(answer.searchIndexes.message_words).toBe("ok")
    expect(answer.searchIndexes.attachment_words).toBe("ok")
    expect(answer.wordIndex).toMatchObject({ watermark: 10, filledThrough: 1, ready: false })
    expect(stderr.join("\n")).toContain("the word index reaches message 1 of 10 — `chat store migrate` finishes it")
  })

  it("`store reindex` refuses a file requiring a newer build", async () => {
    const env = envFor()
    const database = await seeded(env)
    migrate(database, {
      migrations: [...MIGRATIONS, { version: latest + 1, minCompatible: latest + 1, statements: [] }],
    })
    database.close()
    const { code, stderr } = await call(["store", "reindex", "--json"], env)
    expect(code).not.toBe(0)
    expect(stderr.join("\n")).toContain("upgrade this tool")
  })
})

const messagesIn = async (path: string) => {
  const database = await openCache(path)
  try {
    return Number(database.prepare("SELECT count(*) AS n FROM messages").get()?.n)
  } finally {
    database.close()
  }
}

const backedUp = async () => {
  const env = envFor()
  ;(await seeded(env)).close()
  const file = join(dirname(String(env.MESSAGING_STORE)), "copy.db")
  const { answer } = await call(["store", "backup", file, "--json"], env)
  return { env, file, answer }
}

describe("store backup", () => {
  it("**writes a copy that opens with the same counts, readable by the owner alone**", async () => {
    const { file, answer } = await backedUp()

    expect(answer).toMatchObject({ path: file, schema: latest, rows: { chats: 2, messages: 2 } })
    expect(await messagesIn(file)).toBe(2)
    expect(statSync(file).mode & 0o777).toBe(0o600)
  })

  it("never overwrites a file", async () => {
    const { env, file } = await backedUp()
    const { code, stdout } = await call(["store", "backup", file, "--json"], env)
    expect(code).not.toBe(0)
    expect(stdout).toEqual([])
  })
})

describe("store restore", () => {
  it("**puts the backup in place and keeps the store it replaced**", async () => {
    const { env, file } = await backedUp()
    const database = await openCache(String(env.MESSAGING_STORE))
    database.exec("DELETE FROM messages WHERE id = 1")
    database.close()

    const { answer } = await call(["store", "restore", file, "--json"], env)
    expect(answer).toMatchObject({ path: env.MESSAGING_STORE, restoredFrom: file, schema: latest })
    expect(await messagesIn(String(env.MESSAGING_STORE))).toBe(2)
    expect(await messagesIn(answer.keptAt)).toBe(1)
    expect(existsSync(file)).toBe(true)
  })

  it("**refuses while another connection is writing**, and leaves the store where it was", async () => {
    const { env, file } = await backedUp()
    const writer = await openCache(String(env.MESSAGING_STORE))
    writer.exec("BEGIN IMMEDIATE")
    try {
      const { code, stderr } = await call(["store", "restore", file, "--json"], env)
      expect(code).not.toBe(0)
      expect(stderr.join("\n")).toContain("a write to the store is under way")
    } finally {
      writer.exec("ROLLBACK")
      writer.close()
    }
    expect(readdirSync(dirname(String(env.MESSAGING_STORE))).some((name) => name.includes("before-restore"))).toBe(
      false,
    )
  })

  it.skipIf(process.platform !== "linux")(
    "**refuses while another process has the store open**, whichever CLI it is",
    async () => {
      const { env, file } = await backedUp()
      const path = String(env.MESSAGING_STORE)
      const holder = spawn(
        process.execPath,
        ["-e", `require("node:fs").openSync(${JSON.stringify(path)}, "r"); setInterval(() => {}, 1000)`],
        { stdio: "ignore" },
      )
      try {
        await expect.poll(() => holdersOf([realpathSync(path)])).toContain(holder.pid)
        const { code, stderr } = await call(["store", "restore", file, "--json"], env)
        expect(code).not.toBe(0)
        expect(stderr.join("\n")).toContain(`the store is open in process ${holder.pid}`)
      } finally {
        holder.kill()
      }
    },
  )

  it("refuses while this CLI's serve runs, before that serve has opened the store", async () => {
    const { env, file } = await backedUp()
    const serve = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" })
    try {
      const lock = lockPath(app, "default", env)
      mkdirSync(dirname(lock), { recursive: true })
      writeFileSync(lock, JSON.stringify({ pid: serve.pid, startedAt: new Date().toISOString() }))

      const { code, stderr } = await call(["store", "restore", file, "--json"], env)
      expect(code).not.toBe(0)
      expect(stderr.join("\n")).toContain("chat serve is running for default")
    } finally {
      serve.kill()
    }
  })

  it("refuses a backup a newer version wrote, with the upgrade message", async () => {
    const { env, file } = await backedUp()
    const database = await openCache(file)
    migrate(database, {
      migrations: [...MIGRATIONS, { version: latest + 1, minCompatible: latest + 1, statements: [] }],
    })
    database.close()

    const { code, stderr } = await call(["store", "restore", file, "--json"], env)
    expect(code).not.toBe(0)
    expect(stderr.join("\n")).toContain("upgrade this tool")
  })
})

describe("store reset", () => {
  it("**backs the store up beside it, then starts an empty one** — never unasked, never under a writer", async () => {
    const env = envFor()
    ;(await seeded(env)).close()
    const path = String(env.MESSAGING_STORE)

    const unasked = await call(["store", "reset", "--json"], env)
    expect(unasked.code).not.toBe(0)
    expect(unasked.stderr.join("\n")).toContain("add --yes")

    const writer = await openCache(path)
    writer.exec("BEGIN IMMEDIATE")
    try {
      const held = await call(["store", "reset", "--yes", "--json"], env)
      expect(held.code).not.toBe(0)
      expect(held.stderr.join("\n")).toContain("a write to the store is under way")
    } finally {
      writer.exec("ROLLBACK")
      writer.close()
    }
    expect(readdirSync(dirname(path)).some((name) => name.includes(".backup-"))).toBe(false)
    expect(await messagesIn(path)).toBe(2)

    const { code, answer, stderr } = await call(["store", "reset", "--yes", "--json"], env)
    expect(code).toBe(0)
    expect(answer).toMatchObject({ path, reset: true, schema: latest, backedUp: { rows: { messages: 2 } } })
    expect(answer.backup).toMatch(/m\.db\.backup-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/)
    expect(stderr.join("\n")).toContain(`backed the store up to ${answer.backup}`)
    expect(await messagesIn(answer.backup)).toBe(2)
    expect(statSync(answer.backup).mode & 0o777).toBe(0o600)
    expect(await messagesIn(path)).toBe(0)
  })

  it("**--no-backup** resets without a copy beside the store", async () => {
    const env = envFor()
    ;(await seeded(env)).close()
    const path = String(env.MESSAGING_STORE)

    const { code, answer, stderr } = await call(["store", "reset", "--no-backup", "--yes", "--json"], env)
    expect(code).toBe(0)
    expect(answer).toMatchObject({ path, reset: true, schema: latest, backup: null, backedUp: null })
    expect(stderr.join("\n")).toContain("there is no backup")
    expect(readdirSync(dirname(path)).some((name) => name.includes(".backup-"))).toBe(false)
    expect(await messagesIn(path)).toBe(0)
  })

  it("**a migration that fails names `store reset`**, keeping SQLite's own words", async () => {
    const env = envFor()
    const database = await seeded(env)
    database.exec("DELETE FROM schema_migrations")
    database.close()

    const { code, stderr } = await call(["store", "migrate", "--json"], env)
    expect(code).not.toBe(0)
    expect(stderr.join("\n")).toContain("already exists")
    expect(stderr.join("\n")).toContain("`chat store reset` takes a backup of it first")
  })
})

describe("the stems", () => {
  it("**`config set searchStemmers.*` is store-wide**: stems wait for `store reindex`, which rebuilds them", async () => {
    const env = envFor()
    ;(await seeded(env)).close()
    await call(["store", "migrate", "--json"], env)

    const set = await call(["config", "set", "searchStemmers.latin", "english", "--json"], env)
    expect(set.answer).toEqual({
      store: env.MESSAGING_STORE,
      scope: "store",
      setting: "searchStemmers.latin",
      value: "english",
    })
    expect(set.stderr.join("\n")).toContain("store-wide")
    expect((await call(["store", "info", "--json"], env)).answer.stemIndex).toMatchObject({
      ready: false,
      cause: "stemmer_changed",
      wanted: "snowball-3.1.1 cyrillic=russian latin=english",
    })

    expect((await call(["store", "reindex", "--json"], env)).answer).toMatchObject({ stemmed: 2 })
    expect((await call(["store", "info", "--json"], env)).answer.stemIndex).toMatchObject({
      ready: true,
      built: "snowball-3.1.1 cyrillic=russian latin=english",
    })
    const shown = (await call(["config", "show", "--json"], env)).answer.storeSettings
    expect(shown).toContainEqual({ setting: "searchStemmers.latin", value: "english", from: "store", scope: "store" })
  })

  it("**refuses to change the store-wide setting from a process locked to one profile**", async () => {
    const env = { ...envFor(), CHAT_PROFILE_LOCK: "work" }
    const { code, stderr } = await call(["config", "set", "searchStemmers.latin", "english", "--json"], env)
    expect(code).not.toBe(0)
    expect(stderr.join("\n")).toContain("changes every profile")
  })

  it("**refuses a stemmer of the other script**, naming the allowed ones", async () => {
    const env = envFor()
    const { code, stderr } = await call(["config", "set", "searchStemmers.cyrillic", "english", "--json"], env)
    expect(code).not.toBe(0)
    expect(stderr.join("\n")).toContain("russian, none")
  })

  it("**`store migrate` rebuilds stems built by other choices**", async () => {
    const env = envFor()
    ;(await seeded(env)).close()
    await call(["store", "migrate", "--json"], env)
    await call(["config", "set", "searchStemmers.cyrillic", "none", "--json"], env)

    const { answer, stderr } = await call(["store", "migrate", "--json"], env)
    expect(answer).toMatchObject({ stemmed: 2 })
    expect(stderr.join("\n")).toContain("rebuilding them with snowball-3.1.1 cyrillic=none latin=english,spanish")
  })
})

describe("store repair and store copies delete", () => {
  it("repairs nothing in a healthy store, and deletes only a repair copy, by name", async () => {
    const env = envFor()
    const database = await seeded(env)
    database.exec("CREATE TABLE chats__repair_0123abcd (pk integer)")
    database.close()

    const dry = await call(["store", "repair", "--dry-run", "--json"], env)
    const refused = await call(["store", "copies", "delete", "chats", "--json"], env)
    const deleted = await call(["store", "copies", "delete", "chats__repair_0123abcd", "--json"], env)

    expect(dry.answer).toMatchObject({
      dryRun: true,
      repaired: [],
      mismatches: [],
      copies: [{ name: "chats__repair_0123abcd" }],
    })
    expect(refused.code).not.toBe(0)
    expect(deleted.answer).toMatchObject({ deleted: { name: "chats__repair_0123abcd", rows: 0 } })
    expect((await call(["store", "info", "--json"], env)).answer.rows.chats).toBe(2)
  })
})
