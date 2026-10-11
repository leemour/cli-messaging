import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CliError } from "@wirecat/cli-core"
import { MeetingError } from "@wirecat/cli-meetings"
import { sampleMeeting } from "@wirecat/cli-meetings/testing"
import { afterEach, expect, it } from "vitest"
import { openStore } from "./store.js"

const opened: { close(): unknown }[] = []
afterEach(async () => {
  for (const item of opened.splice(0)) await item.close()
})
it("reports creation, correction and historical replay from the same atomic append", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "meeting-test-append-receipt-")), "fixture.db")
  const store = await openStore({ path, env: { MESSAGING_STORE: path } })
  opened.push(store)
  const accountId = await store.saveAccount({ provider: "example", account: "AliceExample" }, { name: "Alice Example" })
  const original = sampleMeeting().transcripts[0]
  const transcript = {
    ...original,
    contentHash: "original-AliceExample",
    rows: original.rows.map(({ speakerParticipantPosition: _position, ...row }) => row),
  }
  const input = {
    accountId,
    externalId: "AliceExample-occurrence",
    now: 1000,
    create: { title: "Alice Example planning", startedAt: 1000, timezone: null },
    transcripts: [transcript],
  }
  expect(await store.meetings.appendTranscriptsWithReceipt(input)).toMatchObject({
    created: true,
    insertedTranscripts: 1,
    replayedTranscripts: 0,
    supersededTranscripts: 0,
  })
  const other = await openStore({ path, env: { MESSAGING_STORE: path } })
  opened.push(other)
  expect(await other.meetings.appendTranscriptsWithReceipt(input)).toMatchObject({
    created: false,
    insertedTranscripts: 0,
    replayedTranscripts: 1,
    supersededTranscripts: 0,
  })
  expect(
    await other.meetings.appendTranscriptsWithReceipt({
      ...input,
      now: 2000,
      transcripts: [{ ...transcript, contentHash: "corrected-BobSample" }],
    }),
  ).toMatchObject({ created: false, insertedTranscripts: 1, replayedTranscripts: 0, supersededTranscripts: 1 })
  expect(await store.meetings.appendTranscriptsWithReceipt(input)).toMatchObject({
    created: false,
    insertedTranscripts: 0,
    replayedTranscripts: 1,
    supersededTranscripts: 0,
  })
  expect((await store.meetings.appendTranscripts(input)).transcripts).toHaveLength(2)
})
it("returns standard typed receipt errors without changing legacy append error identity", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "meeting-test-append-errors-")), "fixture.db")
  const store = await openStore({ path, env: { MESSAGING_STORE: path } })
  opened.push(store)
  const accountId = await store.saveAccount({ provider: "example", account: "AliceExample" }, { name: "Alice Example" })
  const original = sampleMeeting().transcripts[0]
  const transcripts = [
    {
      ...original,
      contentHash: "AliceExample",
      rows: original.rows.map(({ speakerParticipantPosition: _position, ...row }) => row),
    },
  ]
  await expect(
    store.meetings.appendTranscriptsWithReceipt({ accountId, externalId: "missing", now: 1000, transcripts }),
  ).rejects.toBeInstanceOf(CliError)
  await expect(
    store.meetings.appendTranscriptsWithReceipt({ accountId: 0, externalId: "missing", now: 1000, transcripts }),
  ).rejects.toMatchObject({ code: "validation_error" })
  try {
    await store.meetings.appendTranscripts({ accountId, externalId: "missing", now: 1000, transcripts })
  } catch (error) {
    expect(error).toBeInstanceOf(MeetingError)
    expect(error).not.toBeInstanceOf(CliError)
  }
})
