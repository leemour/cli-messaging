/**
 * The second runtime, actually executed: Bun cannot run the Vitest suite, and the SQLite seam picks
 * a different module under each runtime, so a type check proves nothing about it.
 *
 *   bun run scripts/smoke.ts
 */
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { meetingStoreContract } from "@wirecat/cli-meetings/testing"
import iconv from "iconv-lite"
import { decodeText } from "../src/attachments/encoding.js"
import { extractText, importEngine } from "../src/attachments/extract.js"
import { listRuns, readEvents, recorded, settingsFor } from "../src/cli/index.js"
import { rankingOptions } from "../src/domain/rankings-options.js"
import { formatLocator, parseLocator, renderMessages } from "../src/index.js"
import { migrate, openCache, openStore } from "../src/store/index.js"
import { normalize } from "../src/store/normalize.js"
import { withQuerySelection } from "../src/store/sqlite/lucene.js"
import { meetingStoreOver } from "../src/store/sqlite/meetings.js"
import { openSqlite } from "../src/store/sqlite/open.js"
import { rankQuery } from "../src/store/sqlite/rankings.js"
import { accounts } from "../src/store/sqlite/schema.js"
import { officeFixture } from "../src/testing/office-files.js"

const runtime = typeof (globalThis as { Bun?: unknown }).Bun === "undefined" ? "node" : "bun"
const failures: string[] = []
const check = (what: string, condition: boolean) => {
  if (!condition) failures.push(what)
}

const database = await openCache(join(mkdtempSync(join(tmpdir(), "cli-messaging-smoke-")), "smoke.db"))
database.exec("CREATE VIRTUAL TABLE t USING fts5(text, tokenize='trigram')")
database.prepare("INSERT INTO t (text) VALUES (?)").run("Иван Петров")
check(
  "the SQLite seam opens a database in WAL mode",
  database.prepare("PRAGMA journal_mode").get()?.journal_mode === "wal",
)
check(
  "FTS5 with trigram finds inside a Cyrillic word",
  database.prepare("SELECT * FROM t WHERE t MATCH ?").all("етро").length === 1,
)
database.close()

const locator = { provider: "telegram", account: "1", chat: "-1002", message: "3" }
check("a locator round-trips", JSON.stringify(parseLocator(formatLocator(locator))) === JSON.stringify(locator))
check("an empty feed renders", renderMessages([]) === "(nothing)")

const app = { command: "app", appName: "app-cli", envPrefix: "APP", description: "", version: "0" }
const settings = settingsFor(app).resolveSettings(
  { timeout: "2s" },
  { env: {}, configDir: mkdtempSync(join(tmpdir(), "cli-messaging-smoke-")) },
)
check("settings resolve with no file", settings.profile === "default" && settings.commandTimeoutMs === 2000)

const runsDir = join(mkdtempSync(join(tmpdir(), "cli-messaging-smoke-")), "runs")
const recording = { app, command: "chats list", profile: "default", keepFailed: false, trace: false } as const
await recorded({ ...recording, record: true, format: "json", runsDir }, async (events) => {
  events({ event: "request", operation: "chats.list" })
})
const [kept] = listRuns(runsDir)
check("a recorded run finishes", kept?.status === "success")
check(
  "its log is flushed on finish",
  readEvents(join(runsDir, kept?.startedAt.slice(0, 10) ?? "", kept?.runId ?? "")).length === 1,
)

const store = await openStore({ path: join(mkdtempSync(join(tmpdir(), "cli-messaging-smoke-")), "messages.db") })
const account = { provider: "telegram", account: "1" }
const stored = {
  id: "3",
  chatId: "-1002",
  senderId: "7",
  senderName: "Иван",
  timestamp: "2026-09-27T10:00:00.000Z",
  editedAt: null,
  text: "Иван Петров пишет",
  outgoing: false,
  attachments: [],
  replyTo: null,
  forwardedFrom: null,
  reactions: null,
}
await store.saveMessages(account, "-1002", [stored], { via: "smoke" })
check(
  "the store gives a message back",
  (await store.messages(account, "-1002", { limit: 5 })).items[0]?.text === stored.text,
)
check("the store finds a Cyrillic word by its beginning", (await store.search("Петр", { limit: 5 })).items.length === 1)
await store.close()
const sqlite = await openSqlite(join(mkdtempSync(join(tmpdir(), "cli-messaging-smoke-")), "messages.db"))
migrate(sqlite.database)
sqlite.database
  .prepare("INSERT INTO accounts (provider, external_id, created_at, updated_at) VALUES ('telegram', '1', 0, 0)")
  .run()
check("Drizzle reads the row the seam wrote", (await sqlite.orm.select().from(accounts))[0]?.externalId === "1")
sqlite.database.exec(`
  INSERT INTO chats (id,account_id,external_id,kind,created_at,updated_at) VALUES (1,1,'fixture','group',0,0);
  INSERT INTO messages (chat_id,account_id,external_id,sent_at,text,created_at,source,updated_at)
    VALUES (1,1,'fixture',0,'synthetic',0,'history',0);
`)
check(
  "compiled selection aggregates stored rows in one read transaction",
  withQuerySelection(
    { ...sqlite, now: () => 0 },
    {
      root: {
        kind: "predicate",
        field: "date",
        operator: "range",
        value: "*",
        span: { start: 0, end: 0 },
        resolution: { date: { lowerInclusive: true, upperInclusive: true } },
      },
      accounts: [{ provider: "telegram", account: "1" }],
      limit: 1,
    },
    (selection) =>
      sqlite.database.prepare(`SELECT count(*) AS total FROM (${selection.sql})`).get(...selection.params)?.total,
  ) === 1,
)
sqlite.database.exec(`UPDATE messages SET metadata='{"views":3}'`)
check(
  "ranking aggregation runs under both SQLite runtimes",
  rankQuery(
    { ...sqlite, now: () => 0 },
    {
      root: {
        kind: "predicate",
        field: "date",
        operator: "range",
        value: "*",
        span: { start: 0, end: 0 },
        resolution: { date: { lowerInclusive: true, upperInclusive: true } },
      },
      accounts: [{ provider: "telegram", account: "1" }],
      limit: 1,
    },
    { options: rankingOptions("messages", { measure: "views" }), timezone: "UTC" },
  ).items[0]?.value === 3,
)
sqlite.database.close()
const tasksFile = join(mkdtempSync(join(tmpdir(), "cli-messaging-smoke-")), "messages.db")
const withTasks = await openStore({ path: tasksFile })
await withTasks.tasks.insert({
  id: "t1",
  source: "msg:telegram:1:-1002:3",
  sourceKind: "message",
  account: "telegram:1",
  group: "-1002",
  kind: "question",
  state: "open",
  origin: "rule",
  createdAt: new Date("2026-10-05T10:00:00Z"),
})
await withTasks.close()
const reopened = await openStore({ path: tasksFile })
check("the store keeps a task across a reopen", (await reopened.tasks.get("t1"))?.kind === "question")
await reopened.close()
check(
  "the normalizer folds accents, ё and й as under Node",
  normalize("Ёжик ﬁnds\tЙогурт в València") === "ежик finds иогурт в valencia",
)

for (const encoding of ["windows-1251", "koi8-r", "windows-1252"]) {
  const text = (
    encoding === "windows-1252"
      ? "Café français, déjà reçu. Une facture pour la coopération et les élèves. "
      : "Договор поставки оборудования. Получатель подтверждает получение документов и согласование условий оплаты. "
  ).repeat(20)
  const result = decodeText(iconv.encode(text, encoding))
  check(`legacy text ${encoding} decodes under ${runtime}`, "text" in result && result.text === text)
}
for (const kind of ["odt", "ods", "xlsx", "pptx", "epub"] as const) {
  const result = await extractText(
    officeFixture(kind),
    { kind: "file", name: `fixture.${kind}`, mime: null, path: `/fixture.${kind}` },
    importEngine,
  )
  check(`local ${kind} text reads under ${runtime}`, result.status === "extracted")
}

let missingChecked = false
for (const { name, run } of meetingStoreContract(async () => {
  const { database: meetings } = await openSqlite(join(mkdtempSync(join(tmpdir(), "cli-messaging-smoke-")), "m.db"))
  migrate(meetings)
  const account = meetings.prepare(
    "INSERT INTO accounts (id, provider, external_id, name, created_at, updated_at) VALUES (?, 'example', ?, ?, 1, 1)",
  )
  account.run(1, "first", "First Example")
  account.run(2, "second", "Second Example")
  if (!missingChecked) {
    missingChecked = true
    check(
      `a missing row reads as undefined, not null, under ${runtime}`,
      meetings.prepare("SELECT id FROM accounts WHERE id = 3").get() === undefined,
    )
  }
  return meetingStoreOver({ database: meetings })
}))
  check(
    `meeting contract "${name}" passes under ${runtime}`,
    await run().then(
      () => true,
      () => false,
    ),
  )

if (failures.length > 0) {
  console.error(`smoke failed under ${runtime}:\n${failures.map((one) => `  - ${one}`).join("\n")}`)
  process.exit(1)
}
console.log(`smoke passed under ${runtime}`)
