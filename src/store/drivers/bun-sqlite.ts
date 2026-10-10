import type { CacheDatabase, SqlValue } from "../driver.js"

interface BunStatement {
  run(...parameters: SqlValue[]): { changes: number }
  get(...parameters: SqlValue[]): unknown
  all(...parameters: SqlValue[]): unknown[]
}

export interface BunDatabase {
  exec(sql: string): void
  query(sql: string): BunStatement
  close(): void
}

export interface BunDatabaseClass {
  new (path: string): BunDatabase
  setCustomSQLite(path: string): void
}

let customised = false

/**
 * Bun on macOS takes the system's SQLite, which can be older than the store needs, so it always
 * loads ours — once, before the first database: Bun refuses a second, different library. Without
 * the package (an install that skipped it) the system's stays, and the store's check decides.
 */
const ownLibrary = async (): Promise<string | undefined> => {
  try {
    const { libraryFor } = await import("@wirecat/cli-messaging-sqlite")
    return libraryFor()
  } catch {
    return undefined
  }
}

/**
 * The specifier is a variable on purpose: written inline, TypeScript tries to resolve `bun:sqlite`
 * and fails, because Bun's types are not installed and would only be right for one of the two
 * runtimes anyway. The import is reached only under Bun, so Node never evaluates it.
 */
export const bunDatabase = async (): Promise<BunDatabaseClass> => {
  const specifier = "bun:sqlite"
  const { Database } = (await import(specifier)) as { Database: BunDatabaseClass }
  if (process.platform === "darwin" && !customised) {
    customised = true
    const library = await ownLibrary()
    if (library) Database.setCustomSQLite(library)
  }
  return Database
}

export const openWithBunSqlite = async (path: string): Promise<CacheDatabase> =>
  cacheOverBunSqlite(new (await bunDatabase())(path))

export const cacheOverBunSqlite = (database: BunDatabase): CacheDatabase => {
  return {
    exec: (sql) => database.exec(sql),
    prepare: (sql) => {
      const statement = database.query(sql)
      return {
        run: (...parameters: SqlValue[]) => ({ changes: Number(statement.run(...parameters).changes) }),
        // Bun answers null for no row; the seam promises undefined, and `!== undefined` checks rely on it.
        get: (...parameters: SqlValue[]) =>
          (statement.get(...parameters) ?? undefined) as Record<string, unknown> | undefined,
        all: (...parameters: SqlValue[]) => statement.all(...parameters) as Record<string, unknown>[],
      }
    },
    close: () => database.close(),
  }
}
