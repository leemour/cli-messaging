import type { CacheDatabase } from "../driver.js"
import { drainInvolvementQueue } from "./involvement-queue.js"

let depth = 0

/**
 * One write transaction. The outermost takes the write lock at once (`BEGIN IMMEDIATE`): a deferred one that
 * reads first fails with SQLITE_BUSY when another process writes in between, and tg, max, memo and zm share
 * the file. A nested call is a savepoint.
 */
export const atomic = <T>(database: CacheDatabase, body: () => T): T => {
  const outer = depth === 0
  const name = `k${depth + 1}`
  database.exec(outer ? "BEGIN IMMEDIATE" : `SAVEPOINT ${name}`)
  depth += 1
  try {
    const result = body()
    if (outer) drainInvolvementQueue(database)
    database.exec(outer ? "COMMIT" : `RELEASE ${name}`)
    return result
  } catch (error) {
    database.exec(outer ? "ROLLBACK" : `ROLLBACK TO ${name}; RELEASE ${name}`)
    throw error
  } finally {
    depth -= 1
  }
}
