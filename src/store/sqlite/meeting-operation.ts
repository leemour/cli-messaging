import { CliError } from "@wirecat/cli-core"
import type { CacheDatabase } from "../driver.js"

export function checkMeetingCancelled(signal?: AbortSignal): void {
  if (!signal?.aborted) return
  if (signal.reason instanceof CliError) throw signal.reason
  const timeout = signal.reason instanceof Error && signal.reason.name === "TimeoutError"
  throw new CliError(
    timeout ? "timeout" : "cancelled",
    timeout ? "Meeting operation timed out" : "Meeting operation cancelled",
  )
}
export function meetingWriteSnapshot<T>(database: CacheDatabase, body: () => T): T {
  database.exec("BEGIN IMMEDIATE")
  try {
    const result = body()
    database.exec("COMMIT")
    return result
  } catch (error) {
    database.exec("ROLLBACK")
    throw error
  }
}
