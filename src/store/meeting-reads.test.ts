import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { sampleMeeting } from "@wirecat/cli-meetings/testing"
import { afterEach, describe, expect, it, vi } from "vitest"
import { openCache } from "./open.js"
import { meetingReadsOver } from "./sqlite/meeting-reads.js"
import { openStore } from "./store.js"

const opened: { close(): unknown }[] = []
afterEach(async () => {
  for (const handle of opened.splice(0)) await handle.close()
})
const fixture = async () => {
  const path = join(mkdtempSync(join(tmpdir(), "zm-test-meeting-read-caps-")), "fixture.db")
  const store = await openStore({ path })
  opened.push(store)
  const accountId = await store.saveAccount({ provider: "example", account: "invented" }, { name: "Invented" })
  const otherId = await store.saveAccount({ provider: "example", account: "other" }, { name: "Other invented" })
  const input = sampleMeeting()
  input.meeting.accountId = accountId
  input.transcripts[0].rows[0].text = "Invented cue 0"
  input.transcripts[0].rows.push(
    ...Array.from({ length: 3 }, (_, i) => ({
      ...input.transcripts[0].rows[0],
      position: (i + 1) * 2,
      text: `Invented cue ${i + 1}`,
    })),
  )
  const saved = await store.meetings.saveMeeting(input)
  const transcriptId = saved.transcripts[0]?.transcript.id
  if (!transcriptId) throw new Error("Missing fixture revision")
  const scope = { accountId, meetingId: saved.meeting.id, transcriptId }
  const db = await openCache(path)
  opened.push(db)
  return { path, store, accountId, otherId, input, saved, scope, db }
}
describe("bounded scoped meeting reads", () => {
  it("pages real cue positions and revision ids without returning full details", async () => {
    const { store, scope, saved } = await fixture()
    expect(await store.meetings.meetingMetadata(scope)).toEqual(saved.meeting)
    expect(await store.meetings.transcriptMetadata(scope)).toEqual(saved.transcripts[0]?.transcript)
    const first = await store.meetings.transcriptRows({ ...scope, limit: 2 })
    expect(first.rows.map((row) => row.position)).toEqual([0, 2])
    expect(first.hasMore).toBe(true)
    expect(first.nextPosition).toBe(2)
    const second = await store.meetings.transcriptRows({ ...scope, afterPosition: first.nextPosition, limit: 2 })
    expect(second.rows.map((row) => row.position)).toEqual([4, 6])
    expect(second.hasMore).toBe(false)
    expect(second.nextPosition).toBeUndefined()
    expect(await store.meetings.transcripts({ ...scope, limit: 1 })).toEqual({
      items: [saved.transcripts[0]?.transcript],
      hasMore: false,
    })
  })
  it("defaults to current revisions, permits explicit retained history and rejects deleted parents", async () => {
    const { store, scope, input, saved, otherId } = await fixture()
    await store.meetings.saveMeeting({
      ...input,
      transcripts: [{ ...input.transcripts[0], contentHash: "corrected-hash" }],
      now: 6000,
    })
    await expect(store.meetings.transcriptMetadata(scope)).rejects.toMatchObject({ code: "not_found" })
    await expect(store.meetings.transcriptRows({ ...scope, limit: 2 })).rejects.toMatchObject({ code: "not_found" })
    const historical = await store.meetings.transcriptRows({ ...scope, limit: 2, includeHistorical: true })
    expect(historical.transcript.supersededAt).toBe(6000)
    const current = await store.meetings.transcripts({ ...scope, limit: 1 })
    expect(current.items[0]?.id).not.toBe(scope.transcriptId)
    const history = await store.meetings.transcripts({ ...scope, includeHistorical: true, limit: 1 })
    expect(history.items[0]?.id).toBe(scope.transcriptId)
    expect(history.hasMore).toBe(true)
    expect(
      (await store.meetings.transcripts({ ...scope, includeHistorical: true, afterId: history.nextId, limit: 1 }))
        .hasMore,
    ).toBe(false)
    for (const read of [
      () => store.meetings.meetingMetadata({ ...scope, accountId: otherId }),
      () => store.meetings.transcriptRows({ ...scope, accountId: otherId, limit: 1 }),
      () => store.meetings.transcripts({ ...scope, accountId: otherId, limit: 1 }),
    ])
      await expect(read()).rejects.toMatchObject({ code: "not_found" })
    const other = await store.meetings.saveMeeting({
      ...input,
      meeting: { ...input.meeting, externalId: "other-occurrence" },
    })
    await expect(
      store.meetings.transcriptRows({
        ...scope,
        transcriptId: other.transcripts[0]?.transcript.id ?? 0,
        includeHistorical: true,
        limit: 1,
      }),
    ).rejects.toMatchObject({ code: "not_found" })
    await store.meetings.saveMeeting({ ...input, meeting: { ...input.meeting, deletedAt: 7000 }, now: 7000 })
    await expect(store.meetings.meetingMetadata({ ...scope, meetingId: saved.meeting.id })).rejects.toMatchObject({
      code: "not_found",
    })
    await expect(store.meetings.transcriptRows({ ...scope, includeHistorical: true, limit: 1 })).rejects.toMatchObject({
      code: "not_found",
    })
  })
  it("validates bounds before SQL and leaves queues untouched on read-only snapshots", async () => {
    const { db, scope } = await fixture()
    const read = meetingReadsOver({ database: db })
    const prepared = vi.spyOn(db, "prepare")
    for (const limit of [0, -1, 1001, 1.5])
      await expect(read.transcriptRows({ ...scope, limit })).rejects.toMatchObject({ code: "validation_error" })
    for (const maxReadBytes of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])
      await expect(read.meetingMetadata({ ...scope, maxReadBytes })).rejects.toMatchObject({ code: "validation_error" })
    await expect(read.transcriptRows({ ...scope, afterPosition: -1, limit: 1 })).rejects.toMatchObject({
      code: "validation_error",
    })
    await expect(read.transcripts({ ...scope, afterId: 0, limit: 1 })).rejects.toMatchObject({
      code: "validation_error",
    })
    expect(prepared).not.toHaveBeenCalled()
    prepared.mockRestore()
    const before = db.prepare("SELECT * FROM meeting_index_pending ORDER BY id").all()
    await read.transcriptRows({ ...scope, limit: 1 })
    expect(db.prepare("SELECT * FROM meeting_index_pending ORDER BY id").all()).toEqual(before)
  })
  it("rejects oversized UTF8 metadata and lookahead rows before loading full values", async () => {
    const { db, scope } = await fixture()
    db.prepare("UPDATE meetings SET metadata = ? WHERE id = ?").run(
      JSON.stringify({ example: "界".repeat(200) }),
      scope.meetingId,
    )
    const read = meetingReadsOver({ database: db })
    const spy = vi.spyOn(db, "prepare")
    await expect(read.meetingMetadata({ ...scope, maxReadBytes: 200 })).rejects.toMatchObject({
      code: "validation_error",
    })
    expect(spy.mock.calls.some(([sql]) => sql.startsWith("SELECT * FROM meetings"))).toBe(false)
    spy.mockRestore()
    db.prepare("UPDATE meetings SET metadata = NULL WHERE id = ?").run(scope.meetingId)
    db.prepare(
      "UPDATE meeting_transcript_rows SET normalized_text = ? WHERE meeting_transcript_id = ? AND position = 2",
    ).run("界".repeat(200), scope.transcriptId)
    const rows = vi.spyOn(db, "prepare")
    await expect(read.transcriptRows({ ...scope, limit: 1, maxReadBytes: 400 })).rejects.toMatchObject({
      code: "validation_error",
    })
    expect(rows.mock.calls.some(([sql]) => sql.startsWith("SELECT * FROM meeting_transcript_rows"))).toBe(false)
    rows.mockRestore()
    expect(
      (await read.transcriptRows({ ...scope, afterPosition: 2, limit: 1, maxReadBytes: 400 })).rows[0]?.position,
    ).toBe(4)
  })
  it("holds the byte preflight and row values in one read snapshot despite concurrent growth", async () => {
    const { path, db, scope } = await fixture()
    const writer = await openCache(path)
    opened.push(writer)
    const prepare = db.prepare.bind(db)
    let changed = false
    const database = {
      ...db,
      exec: db.exec.bind(db),
      close: db.close.bind(db),
      prepare(sql: string) {
        const statement = prepare(sql)
        if (!sql.includes("sum(read_bytes)")) return statement
        return {
          ...statement,
          run: statement.run.bind(statement),
          all: statement.all.bind(statement),
          get(...params: Parameters<typeof statement.get>) {
            const result = statement.get(...params)
            if (!changed) {
              changed = true
              writer
                .prepare("UPDATE meeting_transcript_rows SET text = ? WHERE meeting_transcript_id = ? AND position = 0")
                .run("界".repeat(2000), scope.transcriptId)
            }
            return result
          },
        }
      },
    }
    const read = meetingReadsOver({ database })
    const page = await read.transcriptRows({ ...scope, limit: 1, maxReadBytes: 400 })
    expect(changed).toBe(true)
    expect(page.rows[0]?.text).toBe("Invented cue 0")
    await expect(read.transcriptRows({ ...scope, limit: 1, maxReadBytes: 400 })).rejects.toMatchObject({
      code: "validation_error",
    })
  })
  it("reports cancellation after an active row query settles and does not leave a transaction open", async () => {
    const { db, scope } = await fixture()
    const controller = new AbortController()
    const prepare = db.prepare.bind(db)
    const database = {
      ...db,
      exec: db.exec.bind(db),
      close: db.close.bind(db),
      prepare(sql: string) {
        const statement = prepare(sql)
        if (!sql.startsWith("SELECT * FROM meeting_transcript_rows")) return statement
        return {
          ...statement,
          run: statement.run.bind(statement),
          get: statement.get.bind(statement),
          all(...params: Parameters<typeof statement.all>) {
            const result = statement.all(...params)
            controller.abort(new Error("Invented active-read cancellation"))
            return result
          },
        }
      },
    }
    await expect(
      meetingReadsOver({ database }).transcriptRows({ ...scope, limit: 1, signal: controller.signal }),
    ).rejects.toThrow("Invented active-read cancellation")
    expect((await meetingReadsOver({ database: db }).transcriptRows({ ...scope, limit: 1 })).rows).toHaveLength(1)
  })

  it("rolls back on cancellation and missing revisions so the connection remains usable", async () => {
    const { db, scope } = await fixture()
    const controller = new AbortController()
    const prepare = db.prepare.bind(db)
    const database = {
      ...db,
      exec: db.exec.bind(db),
      close: db.close.bind(db),
      prepare(sql: string) {
        const statement = prepare(sql)
        if (!sql.includes("sum(read_bytes)")) return statement
        return {
          ...statement,
          run: statement.run.bind(statement),
          all: statement.all.bind(statement),
          get(...params: Parameters<typeof statement.get>) {
            const result = statement.get(...params)
            controller.abort(new Error("Invented cancellation"))
            return result
          },
        }
      },
    }
    await expect(
      meetingReadsOver({ database }).transcriptRows({ ...scope, limit: 1, signal: controller.signal }),
    ).rejects.toThrow("Invented cancellation")
    await expect(
      meetingReadsOver({ database: db }).transcriptMetadata({ ...scope, transcriptId: 99999 }),
    ).rejects.toMatchObject({ code: "not_found" })
    expect((await meetingReadsOver({ database: db }).transcriptRows({ ...scope, limit: 1 })).rows).toHaveLength(1)
  })
})
