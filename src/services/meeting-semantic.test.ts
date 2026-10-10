import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { sampleMeeting } from "@wirecat/cli-meetings/testing"
import { afterEach, describe, expect, it, vi } from "vitest"
import { type MessageStore, openStore } from "../store/store.js"
import type { MeetingEmbedder } from "./meeting-model.js"
import { applyMeetingEmbedding, proposeMeetingEmbedding, readMeetingSemantic } from "./meeting-semantic.js"

const stores: MessageStore[] = []
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close()
})
const fixture = async () => {
  const store = await openStore({ path: join(mkdtempSync(join(tmpdir(), "zm-test-semantic-")), "store.db") })
  stores.push(store)
  const accountId = await store.saveAccount(
    { provider: "example", account: "alice-example" },
    { name: "Alice Example" },
  )
  const input = sampleMeeting()
  input.meeting.accountId = accountId
  input.transcripts[0].rows[0].text = "Alice Example will send the invented draft"
  const meeting = await store.meetings.saveMeeting(input)
  return { store, accountId, input, meeting }
}
const embedder = (
  embed: MeetingEmbedder["embed"] = async (texts) => texts.map(() => new Float32Array([1, 0, 0])),
): MeetingEmbedder => ({
  key: "example:synthetic:3",
  model: "synthetic",
  dims: 3,
  kind: "remote",
  embed,
  close: async () => {},
})
describe("explicit meeting semantic services", () => {
  it("previews current chunk status without model opening or rebuilding", async () => {
    const { store, accountId } = await fixture()
    const embed = vi.fn(async () => [])
    const selected = embedder(embed)
    expect(await proposeMeetingEmbedding(store.meetingVectors, accountId, selected)).toMatchObject({
      applied: false,
      status: { chunks: 0, embedded: 0 },
      scope: "existing-current-chunks",
      rebuildRequired: "explicit",
    })
    expect(embed).not.toHaveBeenCalled()
  })
  it("explicitly generates current chunks and queries with retained revision/cue provenance", async () => {
    const { store, accountId, meeting } = await fixture()
    await store.meetingVectors.rebuild({ accountId })
    const embed = vi.fn(async (texts: string[]) => texts.map(() => new Float32Array([1, 0, 0])))
    const model = embedder(embed)
    const applied = await applyMeetingEmbedding(store.meetingVectors, accountId, model)
    expect(applied).toMatchObject({ saved: 1, skipped: 0, hasMore: false })
    const found = await readMeetingSemantic(store.meetingVectors, accountId, "invented draft", model, { maxChunks: 1 })
    expect(found.ranking).toBe("scanned-candidates")
    expect(found.items[0]).toMatchObject({
      reference: `meeting:${accountId}/${meeting.meeting.id}/${meeting.transcripts[0]?.transcript.id}`,
      firstCueReference: `meeting:${accountId}/${meeting.meeting.id}/${meeting.transcripts[0]?.transcript.id}/0`,
      score: 1,
    })
    expect(embed.mock.calls).toHaveLength(2)
    const second = await applyMeetingEmbedding(store.meetingVectors, accountId, model)
    expect(second.saved).toBe(0)
    expect(embed.mock.calls).toHaveLength(2)
  })
  it("skips a correction made while the model was running instead of caching stale vectors", async () => {
    const { store, accountId, input } = await fixture()
    await store.meetingVectors.rebuild({ accountId })
    const model = embedder(async (texts) => {
      input.transcripts[0].contentHash = "corrected-example-hash"
      input.transcripts[0].rows[0].text = "Bob Sample corrected the invented draft"
      await store.meetings.saveMeeting(input)
      return texts.map(() => new Float32Array([1, 0, 0]))
    })
    expect(await applyMeetingEmbedding(store.meetingVectors, accountId, model)).toMatchObject({ saved: 0, skipped: 1 })
    expect(await store.meetingVectors.status({ accountId, model: model.key })).toEqual({ chunks: 0, embedded: 0 })
  })
  it("stops after cancellation or invalid vectors without saving", async () => {
    const { store, accountId } = await fixture()
    await store.meetingVectors.rebuild({ accountId })
    const controller = new AbortController()
    const saveCurrent = vi.fn((...args: Parameters<typeof store.meetingVectors.saveCurrent>) =>
      store.meetingVectors.saveCurrent(...args),
    )
    const port = { ...store.meetingVectors, saveCurrent }
    const model = embedder(async (texts) => {
      controller.abort()
      return texts.map(() => new Float32Array([1, 0, 0]))
    })
    await expect(applyMeetingEmbedding(port, accountId, model, { signal: controller.signal })).rejects.toMatchObject({
      code: "cancelled",
    })
    await expect(
      applyMeetingEmbedding(
        port,
        accountId,
        embedder(async () => [new Float32Array([0, 0, 0])]),
      ),
    ).rejects.toMatchObject({ code: "invalid_response" })
    expect(saveCurrent).not.toHaveBeenCalled()
  })
  it("rejects invalid query/limits and text/vector budgets before model execution", async () => {
    const { store, accountId } = await fixture()
    await store.meetingVectors.rebuild({ accountId })
    const embed = vi.fn(async (texts: string[]) => texts.map(() => new Float32Array([1, 0, 0])))
    const model = embedder(embed)
    await expect(readMeetingSemantic(store.meetingVectors, accountId, " ", model)).rejects.toMatchObject({
      code: "validation_error",
    })
    await expect(readMeetingSemantic(store.meetingVectors, 0, "example", model)).rejects.toMatchObject({
      code: "validation_error",
    })
    await expect(
      applyMeetingEmbedding(store.meetingVectors, accountId, model, { maxVectorBytes: 1 }),
    ).rejects.toMatchObject({ code: "validation_error" })
    await expect(
      applyMeetingEmbedding(store.meetingVectors, accountId, model, { maxTextBytes: 1 }),
    ).rejects.toMatchObject({ code: "validation_error" })
    expect(embed).not.toHaveBeenCalled()
  })
  it("preserves an acknowledged write if cancellation arrives immediately after commit", async () => {
    const { store, accountId } = await fixture()
    await store.meetingVectors.rebuild({ accountId })
    const controller = new AbortController()
    const port = {
      ...store.meetingVectors,
      saveCurrent: async (...args: Parameters<typeof store.meetingVectors.saveCurrent>) => {
        const result = await store.meetingVectors.saveCurrent(...args)
        controller.abort()
        return result
      },
    }
    expect(await applyMeetingEmbedding(port, accountId, embedder(), { signal: controller.signal })).toMatchObject({
      saved: 1,
      skipped: 0,
    })
  })
})
