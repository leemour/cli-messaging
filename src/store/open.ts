import { CliError } from "@wirecat/cli-core"
import { type CacheDatabase, PRAGMAS } from "./driver.js"

/**
 * Opens the cache with whichever SQLite the runtime actually has.
 *
 * **Both imports are dynamic, and that is the whole point.** A static `import` of
 * `node:sqlite` fails under Bun at load time, and one of `bun:sqlite` fails under Node the same
 * way — before any code runs, so nothing can catch it and no test can reach it. Reaching the
 * import only inside the branch that can satisfy it is what makes one build serve both runtimes.
 *
 * Measured 2026-09-19: `node:sqlite` exists on Node 22.23.2 and 24 and not in Bun; `bun:sqlite`
 * is the reverse (`NEED-11`).
 */
export const openCache = async (path: string): Promise<CacheDatabase> => {
  const database = await openFile(path)
  database.exec(PRAGMAS)
  return database
}

/** Without the store's pragmas: a caller that sets `locking_mode` needs it before the first read. */
export const openFile = (path: string): Promise<CacheDatabase> =>
  "Bun" in globalThis ? openUnderBun(path) : openUnderNode(path)

const openUnderBun = async (path: string): Promise<CacheDatabase> => {
  const { openWithBunSqlite } = await import("./drivers/bun-sqlite.js")
  return await openWithBunSqlite(path)
}

const openUnderNode = async (path: string): Promise<CacheDatabase> => {
  const { openWithNodeSqlite } = await import("./drivers/node-sqlite.js")
  return openWithNodeSqlite(path)
}

const runtime = (): string => {
  const bun = (globalThis as { Bun?: { version: string } }).Bun
  return bun ? `Bun ${bun.version}` : `Node ${process.versions.node}`
}

/** The two kinds of full-text table the migrations create, made and dropped in `temp`. */
export const CAPABILITY_STATEMENTS = [
  `CREATE VIRTUAL TABLE temp.capability_words USING fts5(a, content = '', contentless_delete = 1,
     tokenize = 'unicode61 remove_diacritics 2')`,
  "CREATE VIRTUAL TABLE temp.capability_text USING fts5(a, tokenize = 'trigram')",
  "DROP TABLE temp.capability_words",
  "DROP TABLE temp.capability_text",
]

/**
 * Refuses a SQLite the store's migrations cannot run on, before anything is written. The version
 * number alone does not tell: official Node 22.0–22.15 ships SQLite 3.46–3.49 without FTS5, and
 * Bun on macOS uses the system library, which can predate `contentless_delete` (3.43).
 */
export const assertStoreCapable = (database: CacheDatabase, on: string = runtime()): void => {
  try {
    for (const statement of CAPABILITY_STATEMENTS) database.exec(statement)
  } catch (error) {
    const version = String(database.prepare("SELECT sqlite_version() AS version").get()?.version)
    const remedy = on.startsWith("Bun")
      ? "Run it under Node 22.16 or newer instead"
      : "Update Node to 22.16 or newer, or run it under Bun"
    throw new CliError(
      "configuration_error",
      `the message store needs full-text search that this SQLite (${version}, ${on}) does not have. ${remedy}.`,
      { sqlite: version, runtime: on, cause: error instanceof Error ? error.message : String(error) },
    )
  }
}

let capable: Promise<void> | undefined

/** Once per process: the runtime's SQLite does not change while it runs. */
export const storeCapable = (): Promise<void> => {
  capable ??= openCache(":memory:").then((database) => {
    try {
      assertStoreCapable(database)
    } finally {
      database.close()
    }
  })
  return capable
}
