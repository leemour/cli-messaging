import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { sampleMeeting } from "@wirecat/cli-meetings/testing"
import { describe, expect, it } from "vitest"
import { openCache } from "./open.js"
import { openStore } from "./store.js"

const fixture = async () => {
  const path = join(mkdtempSync(join(tmpdir(), "meeting-vectors-example-")), "store.db")
  const store = await openStore({ path })
  const accountId = await store.saveAccount(
    { provider: "example", account: "alice-example" },
    { name: "Alice Example" },
  )
  const foreignId = await store.saveAccount({ provider: "example", account: "bob-sample" }, { name: "Bob Sample" })
  const input = sampleMeeting()
  input.meeting.accountId = accountId
  input.transcripts[0].rows[0].text = "Alice Example will review the draft. ".repeat(100)
  const saved = await store.meetings.saveMeeting(input)
  return { store, path, accountId, foreignId, input, saved }
}
describe("meeting transcript vectors", () => {
  it("uses shared model/hash vectors with bounded candidate ranking and excludes corrected history", async () => {
    const { store, accountId, foreignId, input, saved } = await fixture()
    try {
      const rebuilt = await store.meetingVectors.rebuild({ accountId })
      expect(rebuilt.chunks).toBeGreaterThan(1)
      const missing = await store.meetingVectors.chunksToEmbed("invented-model", { accountId, limit: 1 })
      expect(missing.hasMore).toBe(true)
      const all = await store.meetingVectors.chunksToEmbed("invented-model", { accountId, limit: 100 })
      await store.saveVectors(
        "invented-model",
        2,
        all.items.map((item) => ({ hash: item.hash, vector: new Float32Array([1, 0]) })),
      )
      expect(await store.meetingVectors.status({ accountId, model: "invented-model" })).toEqual({
        chunks: all.items.length,
        embedded: all.items.length,
      })
      const first = await store.meetingVectors.nearest("invented-model", new Float32Array([1, 0]), {
        accountId,
        limit: 10,
        maxChunks: 1,
      })
      expect(first).toMatchObject({ ranking: "scanned-candidates", scanned: 1, complete: false, hasMore: true })
      expect(first.items[0]).toMatchObject({
        meetingId: saved.meeting.id,
        transcriptId: saved.transcripts[0]?.transcript.id,
        firstPosition: 0,
        lastPosition: 0,
        score: 1,
      })
      expect(
        (
          await store.meetingVectors.nearest("invented-model", new Float32Array([1, 0]), {
            accountId: foreignId,
            limit: 10,
          })
        ).items,
      ).toEqual([])
      const next = await store.meetingVectors.nearest("invented-model", new Float32Array([1, 0]), {
        accountId,
        limit: 10,
        afterChunkId: first.nextChunkId,
      })
      expect(next.scanned).toBeGreaterThan(0)
      input.transcripts[0].contentHash = "invented-corrected"
      input.transcripts[0].rows[0].text = "Bob Sample changed the example"
      await store.meetings.saveMeeting(input)
      expect(await store.meetingVectors.status({ accountId, model: "invented-model" })).toEqual({
        chunks: 0,
        embedded: 0,
      })
      await store.meetingVectors.rebuild({ accountId })
      expect((await store.meetingVectors.chunksToEmbed("invented-model", { accountId, limit: 10 })).items).toHaveLength(
        1,
      )
    } finally {
      await store.close()
    }
  })
  it("rejects oversize input before replacing any chunk set and validates scope/cancellation/dimensions", async () => {
    const { store, accountId, path } = await fixture()
    try {
      await store.meetingVectors.rebuild({ accountId })
      const before = await store.meetingVectors.status({ accountId, model: "invented-model" })
      await expect(store.meetingVectors.rebuild({ accountId, maxTextBytes: 1 })).rejects.toMatchObject({
        code: "validation_error",
      })
      expect(await store.meetingVectors.status({ accountId, model: "invented-model" })).toEqual(before)
      await expect(store.meetingVectors.rebuild({ accountId, signal: AbortSignal.abort() })).rejects.toBeDefined()
      await expect(
        store.meetingVectors.nearest("", new Float32Array([1]), { accountId, limit: 1 }),
      ).rejects.toMatchObject({ code: "validation_error" })
      const pending = await store.meetingVectors.chunksToEmbed("invented-model", { accountId, limit: 10 })
      await store.saveVectors(
        "invented-model",
        2,
        pending.items.map((item) => ({ hash: item.hash, vector: new Float32Array([1, 0]) })),
      )
      await expect(
        store.meetingVectors.nearest("invented-model", new Float32Array([1]), { accountId, limit: 1 }),
      ).rejects.toMatchObject({ code: "validation_error" })
      const db = await openCache(path)
      try {
        db.prepare("UPDATE meetings SET deleted_at=1 WHERE account_id=?").run(accountId)
      } finally {
        db.close()
      }
      expect(
        (await store.meetingVectors.nearest("invented-model", new Float32Array([1, 0]), { accountId, limit: 1 })).items,
      ).toEqual([])
    } finally {
      await store.close()
    }
  })
})
