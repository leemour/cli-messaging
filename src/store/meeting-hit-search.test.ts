import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { sampleMeeting } from "@wirecat/cli-meetings/testing"
import { afterEach, expect, it } from "vitest"
import { openCache } from "./open.js"
import { openStore } from "./store.js"

const opened: { close(): unknown }[] = []
afterEach(async () => {
  for (const item of opened.splice(0)) await item.close()
})
const fixture = async () => {
  const path = join(mkdtempSync(join(tmpdir(), "meeting-test-hit-search-")), "fixture.db")
  const store = await openStore({ path, env: { MESSAGING_STORE: path }, now: () => 1000 })
  opened.push(store)
  const accountId = await store.saveAccount({ provider: "example", account: "AliceExample" }, { name: "Alice Example" })
  const otherId = await store.saveAccount({ provider: "example", account: "BobSample" }, { name: "Bob Sample" })
  const db = await openCache(path)
  opened.push(db)
  const input = sampleMeeting()
  input.meeting.accountId = accountId
  return { store, db, accountId, otherId, input, path }
}
it("continues individual cue hits across a long transcript and isolates another account", async () => {
  const { store, accountId, otherId, input } = await fixture()
  const original = input.transcripts[0]
  if (!original?.rows[0]) throw new Error("missing synthetic transcript")
  const originalRow = original.rows[0]
  const generatedRows = Array.from({ length: 17 }, (_, i) => ({
    ...originalRow,
    position: i,
    text: `Alice Example needle ${i}`,
    speakerParticipantPosition: null,
  }))
  original.rows.splice(0, original.rows.length, ...generatedRows)
  const saved = await store.meetings.saveMeeting(input)
  await store.meetings.saveMeeting({ ...input, meeting: { ...input.meeting, accountId: otherId } })
  await store.meetings.search("needle", { accountId })
  const hits = []
  let after: string | undefined
  do {
    const page = await store.meetings.searchHits("needle", { accountId, limit: 3, ...(after ? { after } : {}) })
    expect(page.coverage).toEqual({
      archiveCompleteness: "unknown",
      currentRevisions: true,
      indexing: "ready",
      indexCompleteness: "unknown",
    })
    expect(page.items.every((item) => item.meetingId === saved.meeting.id)).toBe(true)
    hits.push(...page.items)
    after = page.nextCursor ?? undefined
  } while (after)
  expect(hits).toHaveLength(17)
  expect(new Set(hits.map((item) => item.id)).size).toBe(17)
})
it("reports pending indexing without draining write queues and skips superseded/deleted transcripts", async () => {
  const { store, db, accountId, input } = await fixture()
  const before = await store.meetings.saveMeeting(input)
  const pending = db.prepare("SELECT count(*) AS n FROM meeting_index_pending").get()?.n
  expect(await store.meetings.searchHits("example", { accountId })).toMatchObject({
    items: [],
    coverage: { indexing: "pending" },
  })
  expect(db.prepare("SELECT count(*) AS n FROM meeting_index_pending").get()?.n).toBe(pending)
  await store.meetings.search("example", { accountId })
  input.transcripts[0].contentHash = "corrected-AliceExample"
  input.transcripts[0].rows[0].text = "Bob Sample correction"
  await store.meetings.saveMeeting(input)
  expect(
    (await store.meetings.searchHits("example", { accountId })).items.every((hit) => hit.scope !== "transcript"),
  ).toBe(true)
  expect((await store.meetings.searchHits("!!!", { accountId })).items).toEqual([])
  input.meeting.deletedAt = 2000
  await store.meetings.saveMeeting(input)
  expect((await store.meetings.searchHits("example", { accountId, meetingId: before.meeting.id })).items).toEqual([])
})
it("binds cursors to account/query/filter and applies ordered temporal filters", async () => {
  const { store, accountId, otherId, input } = await fixture()
  await store.meetings.saveMeeting(input)
  await store.meetings.search("example", { accountId })
  const first = await store.meetings.searchHits("example", { accountId, limit: 1 })
  const cursor = first.nextCursor
  if (!cursor) throw new Error("missing synthetic continuation")
  for (const change of [{ accountId: otherId }, { since: 100 }, { until: 100 }])
    await expect(store.meetings.searchHits("example", { accountId, ...change, after: cursor })).rejects.toMatchObject({
      code: "validation_error",
    })
  await expect(store.meetings.searchHits("other", { accountId, after: cursor })).rejects.toMatchObject({
    code: "validation_error",
  })
  expect((await store.meetings.searchHits("example", { accountId, since: 100000, until: 200000 })).items).toEqual([])
  for (const after of [
    "!",
    "eA",
    Buffer.from("null").toString("base64url"),
    Buffer.from(JSON.stringify({ version: 2 })).toString("base64url"),
  ])
    await expect(store.meetings.searchHits("example", { accountId, after })).rejects.toMatchObject({
      code: "validation_error",
    })
})
it("preflights UTF8 bytes including lookahead without hydrating huge cue text", async () => {
  const { store, accountId, input, db } = await fixture()
  input.transcripts[0].rows[0].text = `needle ${"é".repeat(3000000)}`
  const saved = await store.meetings.saveMeeting(input)
  const rowId = saved.transcripts[0]?.rows[0]?.id
  if (!rowId) throw new Error("missing synthetic row")
  db.prepare("INSERT INTO meeting_words(rowid,normalized_text,scope) VALUES (?,?,'meeting_transcript_row')").run(
    rowId * 4 + 1,
    "needle",
  )
  await expect(store.meetings.searchHits("needle", { accountId })).rejects.toMatchObject({ code: "validation_error" })
  const page = await store.meetings.searchHits("needle", { accountId, maxReadBytes: 8 * 1024 ** 2, limit: 1 })
  expect(page.items[0]?.text.length).toBe(3000007)
})
it("validates bounded inputs and cancellation before querying", async () => {
  const { store, accountId } = await fixture()
  for (const change of [
    { accountId: 0 },
    { meetingId: -1 },
    { limit: 0 },
    { limit: 1001 },
    { maxReadBytes: 0 },
    { maxReadBytes: 64 * 1024 ** 2 + 1 },
    { since: Number.NaN },
    { since: 10, until: 1 },
  ])
    await expect(store.meetings.searchHits("example", { accountId, ...change })).rejects.toMatchObject({
      code: "validation_error",
    })
  await expect(store.meetings.searchHits("x".repeat(65537), { accountId })).rejects.toMatchObject({
    code: "validation_error",
  })
  const cancelled = new AbortController()
  cancelled.abort()
  await expect(store.meetings.searchHits("example", { accountId, signal: cancelled.signal })).rejects.toThrow()
})
