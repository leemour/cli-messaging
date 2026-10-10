import { existsSync, rmSync } from "node:fs"
import { join } from "node:path"
import { openFile } from "./open.js"

const OLD = "messages.db"

/**
 * The store before `wirecat.db`, unencrypted and never read again, deleted on the owner's word (SEC-21).
 * Unix lets a file be unlinked while it is open, so a failed delete would not tell that an old build still
 * runs on it; an exclusive lock does, and the file is kept until the next open.
 */
export const removeOldStore = async (directory: string): Promise<string | undefined> => {
  const file = join(directory, OLD)
  if (!existsSync(file)) return undefined
  if (await held(file)) return undefined
  for (const suffix of ["", "-wal", "-shm"]) rmSync(`${file}${suffix}`, { force: true })
  return file
}

const held = async (file: string): Promise<boolean> => {
  const database = await openFile(file)
  try {
    database.exec("PRAGMA busy_timeout = 0")
    database.exec("PRAGMA locking_mode = EXCLUSIVE")
    database.exec("BEGIN EXCLUSIVE")
    database.exec("COMMIT")
    return false
  } catch {
    return true
  } finally {
    database.close()
  }
}
