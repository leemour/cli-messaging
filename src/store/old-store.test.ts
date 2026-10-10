import { existsSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { openCache } from "./open.js"
import { openStore } from "./store.js"

const stateDir = (): string => {
  const directory = mkdtempSync(join(tmpdir(), "old-store-"))
  const old = join(directory, "messages.db")
  for (const suffix of ["", "-wal", "-shm"]) writeFileSync(`${old}${suffix}`, "")
  return directory
}

describe("the old messages.db beside the store", () => {
  afterEach(() => vi.restoreAllMocks())

  it("is deleted with its -wal and -shm when the store opens at the default path, and says so", async () => {
    const directory = stateDir()
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true)

    const store = await openStore({ env: { MESSAGING_STATE_DIR: directory } })
    await store.close()

    for (const suffix of ["", "-wal", "-shm"]) expect(existsSync(join(directory, `messages.db${suffix}`))).toBe(false)
    expect(existsSync(join(directory, "wirecat.db"))).toBe(true)
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining(join(directory, "messages.db")))
  })

  it("is kept when MESSAGING_STORE names the store", async () => {
    const directory = stateDir()

    const store = await openStore({ env: { MESSAGING_STORE: join(directory, "wirecat.db") } })
    await store.close()

    expect(existsSync(join(directory, "messages.db"))).toBe(true)
  })

  it("is kept while another connection holds it, and deleted on the next open after", async () => {
    const directory = stateDir()
    const old = join(directory, "messages.db")
    writeFileSync(old, "")
    const holder = await openCache(old)
    holder.exec("CREATE TABLE t (a)")
    const env = { MESSAGING_STATE_DIR: directory }
    vi.spyOn(process.stderr, "write").mockReturnValue(true)

    await (await openStore({ env })).close()
    expect(existsSync(old)).toBe(true)

    holder.close()
    await (await openStore({ env })).close()
    expect(existsSync(old)).toBe(false)
  })
})
