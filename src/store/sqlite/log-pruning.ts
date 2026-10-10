import type { CacheDatabase } from "../driver.js"

const DAY = 86_400_000
const SETTING = "logs_pruned_at"

/** How long the logs that only grow keep what they hold. Member-list reads stay: retention is computed from them. */
export const LOG_RETENTION = { agentActionsMs: 90 * DAY, botUpdatePayloadsMs: 30 * DAY }

/** A handled bot update keeps its row, so a redelivery is still recognised; only the payload goes, as JSON `null`. */
export const pruneLogs = (
  database: CacheDatabase,
  now: number,
): { agentActions: number; botUpdatePayloads: number } => {
  database.exec("BEGIN IMMEDIATE")
  try {
    const agentActions = database
      .prepare("DELETE FROM agent_actions WHERE started_at < ?")
      .run(now - LOG_RETENTION.agentActionsMs).changes
    const botUpdatePayloads = database
      .prepare("UPDATE bot_updates SET payload = 'null' WHERE handled_at < ? AND payload <> 'null'")
      .run(now - LOG_RETENTION.botUpdatePayloadsMs).changes
    database
      .prepare("INSERT OR REPLACE INTO store_settings (key, value, at) VALUES (?, ?, ?)")
      .run(SETTING, String(now), now)
    database.exec("COMMIT")
    return { agentActions, botUpdatePayloads }
  } catch (error) {
    database.exec("ROLLBACK")
    throw error
  }
}

/**
 * Prunes when a day has passed since the last run in any process; between runs a call costs one comparison.
 * Called on open and after each write to a growing log, so a long-running `serve` prunes too.
 */
export const logPruner = (database: CacheDatabase, now: () => number): (() => void) => {
  let due: number | undefined
  return () => {
    const at = now()
    if (due === undefined) {
      const row = database.prepare("SELECT value FROM store_settings WHERE key = ?").get(SETTING)
      due = (row ? Number(row.value) : 0) + DAY
    }
    if (at < due) return
    pruneLogs(database, at)
    due = at + DAY
  }
}
