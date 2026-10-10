import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { sampleMeeting } from "@wirecat/cli-meetings/testing"
import { describe, expect, it } from "vitest"
import { openCache } from "./open.js"
import { openStore } from "./store.js"

const fixture = async (now?: () => number) => {
  const path = join(mkdtempSync(join(tmpdir(), "meeting-vectors-example-")), "store.db")
  const store = await openStore({ path, now })
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

it("rolls back model results when cancellation arrives during the write transaction", async () => {
  const controller = new AbortController()
  let cancelOnWrite = false
  const { store, accountId } = await fixture(() => {
    if (cancelOnWrite) controller.abort()
    return 1000
  })
  try {
    await store.meetingVectors.rebuild({ accountId })
    const pending = await store.meetingVectors.chunksToEmbed("invented-model", { accountId, limit: 10 })
    cancelOnWrite = true
    await expect(
      store.meetingVectors.saveCurrent(
        "invented-model",
        2,
        pending.items.map(({ hash }) => ({ hash, vector: new Float32Array([1, 0]) })),
        { accountId, signal: controller.signal },
      ),
    ).rejects.toBeDefined()
    expect(await store.meetingVectors.status({ accountId, model: "invented-model" })).toEqual({
      chunks: pending.items.length,
      embedded: 0,
    })
  } finally {
    await store.close()
  }
})

it("rejects aggregate text budgets and stale chunks before exposing mismatched evidence", async () => {
  const { store, accountId, input, path } = await fixture()
  try {
    await store.meetingVectors.rebuild({ accountId })
    const current = await store.meetingVectors.chunksToEmbed("invented-model", { accountId, limit: 10 })
    await expect(
      store.meetingVectors.chunksToEmbed("invented-model", { accountId, limit: 10, maxTextBytes: 1 }),
    ).rejects.toMatchObject({ code: "validation_error" })
    await expect(
      store.meetingVectors.chunksToEmbed("invented-model", { accountId, limit: 10, afterHash: "bad" }),
    ).rejects.toMatchObject({ code: "validation_error" })
    await expect(store.meetingVectors.rebuild({ accountId: 0 })).rejects.toMatchObject({ code: "validation_error" })
    await expect(store.meetingVectors.rebuild({ accountId, limit: 1001 })).rejects.toMatchObject({
      code: "validation_error",
    })
    await expect(
      store.meetingVectors.nearest("invented-model", new Float32Array([NaN]), { accountId, limit: 1 }),
    ).rejects.toMatchObject({ code: "validation_error" })
    await store.saveVectors(
      "invented-model",
      2,
      current.items.map((item) => ({ hash: item.hash, vector: new Float32Array([1, 0]) })),
    )
    const db = await openCache(path)
    try {
      db.prepare(
        "UPDATE meeting_transcript_rows SET text='Invented changed text' WHERE meeting_transcript_id IN (SELECT id FROM meeting_transcripts WHERE meeting_id IN (SELECT id FROM meetings WHERE account_id=?))",
      ).run(accountId)
    } finally {
      db.close()
    }
    await expect(
      store.meetingVectors.nearest("invented-model", new Float32Array([1, 0]), { accountId, limit: 1 }),
    ).rejects.toMatchObject({ code: "invalid_response" })
    await store.meetingVectors.rebuild({ accountId })
    expect(
      (await store.meetingVectors.chunksToEmbed("invented-model", { accountId, limit: 10 })).items[0]?.text,
    ).toContain("Invented changed text")
    input.meeting.externalId = "second-invented-occurrence"
    await store.meetings.saveMeeting(input)
    await expect(store.meetingVectors.rebuild({ accountId, maxTextBytes: 100 })).rejects.toMatchObject({
      code: "validation_error",
    })
  } finally {
    await store.close()
  }
})

it("atomically revalidates parent scope after model work and acknowledges cached, duplicate and inactive hashes", async () => {
  const { store, accountId, foreignId, input } = await fixture()
  try {
    await store.meetingVectors.rebuild({ accountId })
    const pending = await store.meetingVectors.chunksToEmbed("invented-model", { accountId, limit: 10 })
    const vectors = pending.items.map((item) => ({ hash: item.hash, vector: new Float32Array([1, 0]) }))
    expect(await store.meetingVectors.saveCurrent("invented-model", 2, vectors, { accountId: foreignId })).toEqual({
      saved: 0,
      skipped: vectors.length,
    })
    const first = vectors[0]
    if (!first) throw new Error("Missing invented vector")
    expect(await store.meetingVectors.saveCurrent("invented-model", 2, [first, first], { accountId })).toEqual({
      saved: 1,
      skipped: 1,
    })
    expect(await store.meetingVectors.saveCurrent("invented-model", 2, [first], { accountId })).toEqual({
      saved: 0,
      skipped: 1,
    })
    input.transcripts[0].contentHash = "invented-post-model-correction"
    input.transcripts[0].rows[0].text = "Changed during model await"
    await store.meetings.saveMeeting(input)
    expect(await store.meetingVectors.saveCurrent("invented-model", 2, vectors, { accountId })).toEqual({
      saved: 0,
      skipped: vectors.length,
    })
    await expect(store.meetingVectors.saveCurrent("invented-model", 3, [first], { accountId })).rejects.toMatchObject({
      code: "validation_error",
    })
    await expect(
      store.meetingVectors.saveCurrent("invented-model", 2, [{ ...first, vector: new Float32Array([NaN, 0]) }], {
        accountId,
      }),
    ).rejects.toMatchObject({ code: "validation_error" })
  } finally {
    await store.close()
  }
})
