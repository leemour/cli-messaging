import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { meetingStoreContract, meetingTranscriptStoreContract, sampleMeeting } from "@wirecat/cli-meetings/testing"
import { afterEach, describe, expect, it } from "vitest"
import { migrate } from "./migrations.js"
import { meetingRowid, meetingStoreOver } from "./sqlite/meetings.js"
import type { StoreContext } from "./sqlite/open.js"
import { openSqlite } from "./sqlite/open.js"
import { openStore } from "./store.js"

const opened: { close(): unknown }[] = []
afterEach(async () => {
  for (const handle of opened.splice(0)) await handle.close()
})

const freshPath = () => join(mkdtempSync(join(tmpdir(), "meetings-")), "store.db")

/** The contract's two invented accounts, ids 1 and 2. */
const seeded = async (): Promise<StoreContext> => {
  const { database, orm } = await openSqlite(freshPath())
  opened.push(database)
  migrate(database)
  const account = database.prepare(
    "INSERT INTO accounts (id, provider, external_id, name, created_at, updated_at) VALUES (?, 'example', ?, ?, 1, 1)",
  )
  account.run(1, "first", "First Example")
  account.run(2, "second", "Second Example")
  return { database, orm, now: () => 3000 }
}

describe("SQLite meeting store", () => {
  for (const { name, run } of meetingStoreContract(async () => meetingStoreOver(await seeded())))
    it(`contract: ${name}`, run)

  for (const { name, run } of meetingTranscriptStoreContract(async () => meetingStoreOver(await seeded())))
    it(`append contract: ${name}`, run)

  it("keeps a transcript row and a summary with the same id apart in search, and drops one deleted", async () => {
    const context = await seeded()
    const { database } = context
    const store = meetingStoreOver(context)
    const input = sampleMeeting()
    input.transcripts[0].rows[0].text = "Overlap transcript words"
    input.summaries = [
      { ...(input.summaries?.[0] as NonNullable<typeof input.summaries>[0]), title: "Overlap summary" },
    ]
    const saved = await store.saveMeeting(input)
    const rowId = saved.transcripts[0]?.rows[0]?.id
    expect(rowId).toBe(saved.summaries[0]?.id)
    expect(meetingRowid("meeting_transcript_row", 1)).not.toBe(meetingRowid("meeting_summary", 1))

    expect((await store.search("overlap")).map((hit) => [hit.scope, hit.id])).toEqual([
      ["transcript", rowId],
      ["summary", rowId],
    ])

    database.prepare("DELETE FROM meeting_summaries WHERE id = ?").run(Number(rowId))
    expect((await store.search("overlap")).map((hit) => hit.scope)).toEqual(["transcript"])
    expect(database.prepare("SELECT count(*) AS n FROM meeting_index_pending").get()?.n).toBe(0)
  })

  it("is the shared store's meetings, built on first use", async () => {
    const store = await openStore({ path: freshPath() })
    opened.push(store)
    expect(await store.meetings.meetings()).toEqual([])
    expect(store.meetings).toBe(store.meetings)
  })
})
