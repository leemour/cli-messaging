import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"
import { openStore } from "./store.js"

it("records bot updates once per account and keeps handling and replay state", async () => {
  let now = 100
  const store = await openStore({ path: join(mkdtempSync(join(tmpdir(), "updates-")), "store.db"), now: () => now })
  const account = { provider: "synthetic", account: "bot-1" }
  try {
    const updates = store.botUpdates
    const update = { externalId: "42", kind: "message", payload: { text: "Synthetic update" } }
    expect(updates.save(account, update)).toBe(true)
    now = 200
    expect(updates.save(account, { ...update, payload: { text: "Redelivery" } })).toBe(false)
    expect(updates.recent(account)[0]).toMatchObject({ payload: update.payload, receivedAt: 100, handledAt: null })
    updates.failed(account, "42", "handler_failed")
    expect(updates.recent(account)[0]?.error).toBe("handler_failed")
    expect(updates.handledOf(account, ["42"])).toEqual(new Set())
    updates.handled(account, "42")
    expect(updates.handledOf(account, ["42", "43"])).toEqual(new Set(["42"]))
    expect(updates.handledOf({ ...account, account: "unknown" }, ["42"])).toEqual(new Set())
    now = 300
    updates.replayed(account, "42")
    expect(updates.recent(account)).toMatchObject([{ externalId: "42", handledAt: 200, replayedAt: 300, error: null }])
    expect(updates.save({ ...account, account: "bot-2" }, update)).toBe(true)
    expect(updates.recent({ ...account, account: "unknown" })).toEqual([])
    expect(() => updates.handled(account, "unknown")).toThrow("no stored bot update")
    expect(() => updates.recent(account, 0)).toThrow("1–1000")
    expect(() => updates.save(account, { ...update, payload: undefined })).toThrow("JSON payload")
  } finally {
    await store.close()
  }
})
