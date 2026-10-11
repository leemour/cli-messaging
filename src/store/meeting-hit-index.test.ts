import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CliError } from "@wirecat/cli-core"
import { sampleMeeting } from "@wirecat/cli-meetings/testing"
import { afterEach, expect, it } from "vitest"
import { openCache } from "./open.js"
import { meetingHitIndexOver } from "./sqlite/meeting-hit-index.js"
import { openSqlite } from "./sqlite/open.js"
import { openStore } from "./store.js"

const opened: { close(): unknown }[] = []
afterEach(async () => {
  for (const item of opened.splice(0)) await item.close()
})
const fixture = async () => {
  const path = join(mkdtempSync(join(tmpdir(), "meeting-test-hit-index-")), "fixture.db")
  const store = await openStore({ path, env: { MESSAGING_STORE: path }, now: () => 1000 })
  opened.push(store)
  const accountId = await store.saveAccount({ provider: "example", account: "AliceExample" }, { name: "Alice Example" })
  const otherId = await store.saveAccount({ provider: "example", account: "BobSample" }, { name: "Bob Sample" })
  const input = sampleMeeting()
  input.meeting.accountId = accountId
  const saved = await store.meetings.saveMeeting(input)
  await store.meetings.saveMeeting({ ...input, meeting: { ...input.meeting, accountId: otherId } })
  const db = await openCache(path)
  opened.push(db)
  return { store, db, accountId, otherId, input, saved, path }
}
it("indexes one bounded selected-account batch and leaves other queues untouched", async () => {
  const { store, db, accountId, otherId } = await fixture()
  expect((await store.meetings.searchHits("example", { accountId })).coverage.indexing).toBe("pending")
  const before = Number(db.prepare("SELECT count(*) AS n FROM meeting_index_pending").get()?.n)
  const first = await store.meetings.indexSearch({ accountId, limit: 1 })
  expect(first.indexed).toBe(1)
  expect(first.remaining).toBeGreaterThan(0)
  expect(Number(db.prepare("SELECT count(*) AS n FROM meeting_index_pending").get()?.n)).toBe(before - 1)
  while ((await store.meetings.indexSearch({ accountId, limit: 1 })).remaining) {}
  expect((await store.meetings.searchHits("example", { accountId })).coverage.indexing).toBe("ready")
  expect((await store.meetings.searchHits("example", { accountId })).items.length).toBeGreaterThan(0)
  expect((await store.meetings.searchHits("example", { accountId: otherId })).coverage.indexing).toBe("pending")
  expect(await store.meetings.indexSearch({ accountId })).toEqual({ indexed: 0, remaining: 0 })
})
it("rejects an oversized cue or aggregate batch before replacing index data or dropping queue work", async () => {
  const { store, db, accountId, input } = await fixture()
  await store.meetings.indexSearch({ accountId })
  input.transcripts[0].contentHash = "changed-AliceExample"
  input.transcripts[0].rows[0].text = `needle ${"é".repeat(3000000)}`
  await store.meetings.saveMeeting(input)
  const queue = db.prepare("SELECT * FROM meeting_index_pending ORDER BY indexable_type,id").all()
  const words = db.prepare("SELECT rowid FROM meeting_words ORDER BY rowid").all()
  await expect(store.meetings.indexSearch({ accountId })).rejects.toMatchObject({ code: "validation_error" })
  expect(db.prepare("SELECT * FROM meeting_index_pending ORDER BY indexable_type,id").all()).toEqual(queue)
  expect(db.prepare("SELECT rowid FROM meeting_words ORDER BY rowid").all()).toEqual(words)
  expect((await store.meetings.indexSearch({ accountId, maxReadBytes: 8 * 1024 ** 2 })).remaining).toBe(0)
  expect((await store.meetings.searchHits("needle", { accountId, maxReadBytes: 8 * 1024 ** 2 })).items).toHaveLength(1)
})
it("rolls back cancellation after a queue item was removed and preserves standard timeout reasons", async () => {
  const { store, db, accountId, path } = await fixture()
  const before = db.prepare("SELECT * FROM meeting_index_pending ORDER BY indexable_type,id").all()
  const underlying = await openSqlite(path)
  opened.push(underlying.database)
  const controller = new AbortController()
  const database = {
    ...underlying.database,
    prepare: (sql: string) => {
      const statement = underlying.database.prepare(sql)
      return /^DELETE FROM meeting_index_pending/.test(sql)
        ? {
            ...statement,
            run: (...args: Parameters<typeof statement.run>) => {
              const result = statement.run(...args)
              controller.abort(new CliError("timeout", "Example timeout"))
              return result
            },
          }
        : statement
    },
  }
  await expect(
    meetingHitIndexOver({ ...underlying, database, now: () => 1000 }).indexSearch({
      accountId,
      signal: controller.signal,
    }),
  ).rejects.toMatchObject({ code: "timeout" })
  expect(db.prepare("SELECT * FROM meeting_index_pending ORDER BY indexable_type,id").all()).toEqual(before)
  expect((await store.meetings.searchHits("example", { accountId })).items).toEqual([])
})
it("invalidates obsolete queued rows without reading their huge retained text", async () => {
  const { store, accountId, input, db } = await fixture()
  const rowId = db
    .prepare(
      "SELECT r.id FROM meeting_transcript_rows r JOIN meeting_transcripts t ON t.id=r.meeting_transcript_id JOIN meetings m ON m.id=t.meeting_id WHERE m.account_id=? LIMIT 1",
    )
    .get(accountId)?.id
  if (!rowId) throw new Error("missing synthetic row")
  db.prepare("UPDATE meeting_transcript_rows SET text=? WHERE id=?").run("x".repeat(5000000), Number(rowId))
  input.meeting.deletedAt = 2000
  await store.meetings.saveMeeting(input)
  expect((await store.meetings.indexSearch({ accountId, maxReadBytes: 1 })).remaining).toBe(0)
})
it("validates options and retains malformed summary queues without leaking stored text", async () => {
  const { store, accountId, db } = await fixture()
  for (const change of [
    { accountId: 0 },
    { limit: 0 },
    { limit: 1001 },
    { maxReadBytes: 0 },
    { maxReadBytes: 64 * 1024 ** 2 + 1 },
  ])
    await expect(store.meetings.indexSearch({ accountId, ...change })).rejects.toMatchObject({
      code: "validation_error",
    })
  const aborted = new AbortController()
  aborted.abort(new DOMException("Example timeout", "TimeoutError"))
  await expect(store.meetings.indexSearch({ accountId, signal: aborted.signal })).rejects.toMatchObject({
    code: "timeout",
  })
  db.prepare("UPDATE meeting_summaries SET sections=?").run("Private AliceExample invalid JSON")
  const queue = db.prepare("SELECT count(*) AS n FROM meeting_index_pending").get()?.n
  await expect(store.meetings.indexSearch({ accountId })).rejects.toMatchObject({ code: "invalid_response" })
  try {
    await store.meetings.indexSearch({ accountId })
  } catch (error) {
    expect(String(error)).not.toContain("Private AliceExample")
  }
  expect(db.prepare("SELECT count(*) AS n FROM meeting_index_pending").get()?.n).toBe(queue)
})
it("does not hydrate or parse huge unrelated summary metadata within a small text budget", async () => {
  const { store, db, accountId } = await fixture()
  db.prepare("UPDATE meeting_summaries SET metadata=?,doc_url=?").run(
    "Private AliceExample invalid metadata ".repeat(100000),
    `https://example.invalid/${"x".repeat(2000000)}`,
  )
  expect((await store.meetings.indexSearch({ accountId, maxReadBytes: 4096 })).remaining).toBe(0)
  const page = await store.meetings.searchHits("example", { accountId, maxReadBytes: 4096 })
  expect(page.items.some((item) => item.scope === "summary")).toBe(true)
  expect(JSON.stringify(page)).not.toContain("Private AliceExample")
})
