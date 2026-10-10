import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { TranscriptAppend } from "@wirecat/cli-meetings"
import { sampleMeeting } from "@wirecat/cli-meetings/testing"
import { afterEach, describe, expect, it } from "vitest"
import { openCache } from "./open.js"
import { openStore } from "./store.js"

const opened: { close(): unknown }[] = []
afterEach(async () => {
  for (const handle of opened.splice(0)) await handle.close()
})
const account = { provider: "example", account: "invented-one" }
const fixture = async () => {
  const path = join(mkdtempSync(join(tmpdir(), "zm-test-native-append-")), "fixture.db")
  const store = await openStore({ path, now: () => 4000 })
  opened.push(store)
  const accountId = await store.saveAccount(account, { name: "Invented" })
  const db = await openCache(path)
  opened.push(db)
  return { path, store, accountId, db }
}
const append = (accountId: number, hash = "archive-hash"): TranscriptAppend => {
  const original = sampleMeeting().transcripts[0]
  return {
    accountId,
    externalId: "example-occurrence",
    now: 5000,
    transcripts: [
      {
        ...original,
        source: "archive-asset",
        contentHash: hash,
        rows: original.rows.map(({ speakerParticipantPosition: _position, ...row }) => row),
      },
    ],
  }
}

describe("persistent atomic transcript append", () => {
  it("preserves the latest edit from another connection and survives reopen", async () => {
    const { path, store, accountId } = await fixture()
    const input = sampleMeeting()
    input.participants[0].identity = { ...input.participants[0].identity, associatePerson: true }
    input.meeting.accountId = accountId
    const saved = await store.meetings.saveMeeting(input)
    const other = await openStore({ path, now: () => 4500 })
    opened.push(other)
    await other.meetings.saveMeeting({
      ...input,
      meeting: { ...input.meeting, title: "Owner revised example", metadata: { owner: "retained" } },
      now: 4500,
    })
    const before = await other.meetings.meeting(saved.meeting.id)
    const result = await store.meetings.appendTranscripts({
      ...append(accountId),
      create: { title: "Stale archive title", startedAt: 1, timezone: null },
    })
    expect(result.meeting).toEqual(before?.meeting)
    expect(result.participants).toEqual(before?.participants)
    expect(result.transcripts.at(-1)?.rows[0]?.speakerParticipantId).toBeNull()
    const reopened = await openStore({ path })
    opened.push(reopened)
    expect(await reopened.meetings.meeting(saved.meeting.id)).toEqual(result)
    expect((await reopened.meetings.search("example", { accountId })).length).toBeGreaterThan(0)
  })

  it("rolls back creation, prior supersession and index queues on a later SQL failure", async () => {
    const { store, accountId, db } = await fixture()
    const request = append(accountId)
    const transcript = request.transcripts[0]
    const row = transcript?.rows[0]
    if (!transcript || !row) throw new Error("Invented transcript fixture missing")
    const bad = {
      ...transcript,
      source: "bad-asset",
      rows: [
        { ...row, position: 0 },
        { ...row, position: 0 },
      ],
    }
    await expect(
      store.meetings.appendTranscripts({
        ...request,
        create: { title: null, startedAt: 1, timezone: null },
        transcripts: [...request.transcripts, bad],
      }),
    ).rejects.toThrow()
    expect(await store.meetings.meetings()).toEqual([])
    expect(db.prepare("SELECT count(*) AS n FROM meeting_index_pending").get()?.n).toBe(0)
    const created = await store.meetings.appendTranscripts({
      ...request,
      create: { title: null, startedAt: 1, timezone: null },
    })
    await expect(
      store.meetings.appendTranscripts({
        ...request,
        transcripts: [{ ...transcript, contentHash: "corrected-hash" }, bad],
      }),
    ).rejects.toThrow()
    expect(await store.meetings.meeting(created.meeting.id)).toEqual(created)
    expect(await store.meetings.appendTranscripts(request)).toEqual(created)
  })
})

describe("stable meeting identity associations", () => {
  it("keeps omitted and explicitly false guest associations detached while retaining owner links", async () => {
    const { store, accountId, db } = await fixture()
    const beforePeople = db.prepare("SELECT count(*) AS n FROM persons").get()?.n
    const input = sampleMeeting()
    input.meeting.accountId = accountId
    const participant = input.participants[0]
    participant.identity = { provider: "example", externalId: "alice-example", name: "Alice Example", metadata: null }
    input.participants.push({
      ...participant,
      identity: { ...participant.identity, externalId: "invented-guest-two", associatePerson: false },
    })
    await store.meetings.saveMeeting(input)
    expect(await store.personOf({ provider: "example", id: "alice-example" })).toBeUndefined()
    expect(await store.personOf({ provider: "example", id: "invented-guest-two" })).toBeUndefined()
    expect(db.prepare("SELECT count(*) AS n FROM persons").get()?.n).toBe(beforePeople)
    expect(db.prepare("SELECT count(*) AS n FROM account_identities").get()?.n).toBe(0)
    await store.savePeople(account, [
      { id: "alice-example", name: "Alice Example" },
      { id: "invented-guest-two", name: "Bob Sample" },
    ])
    await store.linkIdentities(
      { provider: "example", id: "alice-example" },
      { provider: "example", id: "invented-guest-two" },
      { method: "manual", by: "owner" },
    )
    const links = db.prepare("SELECT * FROM identity_links ORDER BY identity_id").all()
    const presence = db.prepare("SELECT * FROM account_identities ORDER BY identity_id").all()
    await store.meetings.saveMeeting({ ...input, now: 7000 })
    expect(db.prepare("SELECT * FROM identity_links ORDER BY identity_id").all()).toEqual(links)
    expect(db.prepare("SELECT * FROM account_identities ORDER BY identity_id").all()).toEqual(presence)
  })

  it("creates account presence and separate people for equal participant labels, preserves owner links and reopening", async () => {
    const { path, store, accountId, db } = await fixture()
    const input = sampleMeeting()
    input.participants[0].identity = { ...input.participants[0].identity, associatePerson: true }
    input.meeting.accountId = accountId
    const participant = input.participants[0]
    participant.identity.metadata = { source: "invented-participant" }
    input.participants.push({ ...participant, identity: { ...participant.identity, externalId: "bob-sample" } })
    await store.meetings.saveMeeting(input)
    const alice = await store.personOf({ provider: "example", id: "alice-example" })
    const bob = await store.personOf({ provider: "example", id: "bob-sample" })
    expect(alice?.uid).toBeDefined()
    expect(bob?.uid).toBeDefined()
    expect(alice?.uid).not.toBe(bob?.uid)
    expect(db.prepare("SELECT count(*) AS n FROM account_identities WHERE account_id = ?").get(accountId)?.n).toBe(2)
    expect(await store.countContacts(account)).toBe(0)
    expect(
      JSON.parse(
        String(db.prepare("SELECT metadata FROM identities WHERE external_id = 'alice-example'").get()?.metadata),
      ),
    ).toEqual({ source: "invented-participant" })
    expect(
      store.involvements
        .forPerson(Number(alice?.uid))
        .some((row) => row.subjectType === "meeting" && row.accountId === accountId),
    ).toBe(true)
    const linked = await store.linkIdentities(
      { provider: "example", id: "alice-example" },
      { provider: "example", id: "bob-sample" },
      { method: "manual", by: "owner" },
    )
    const before = db.prepare("SELECT * FROM identity_links ORDER BY identity_id").all()
    await store.meetings.saveMeeting({ ...input, now: 6000 })
    expect(db.prepare("SELECT * FROM identity_links ORDER BY identity_id").all()).toEqual(before)
    const second = await store.saveAccount(
      { provider: "example", account: "invented-two" },
      { name: "Second invented" },
    )
    await store.meetings.saveMeeting({ ...input, meeting: { ...input.meeting, accountId: second } })
    expect(db.prepare("SELECT count(*) AS n FROM account_identities WHERE account_id = ?").get(second)?.n).toBe(2)
    const reopened = await openStore({ path })
    opened.push(reopened)
    expect((await reopened.personOf({ provider: "example", id: "alice-example" }))?.uid).toBe(linked.uid)
  })

  it("repairs old orphan identities on either meeting ingestion or ordinary stable-key profile ingestion", async () => {
    const { store, accountId, db } = await fixture()
    const beforePeople = Number(db.prepare("SELECT count(*) AS n FROM persons").get()?.n)
    const insert = db.prepare(
      "INSERT INTO identities (provider, external_id, name, created_at, updated_at) VALUES ('example', ?, 'Alice Example', 1, 1)",
    )
    insert.run("alice-example")
    insert.run("bob-sample")
    expect(await store.personOf({ provider: "example", id: "alice-example" })).toBeUndefined()
    const input = sampleMeeting()
    input.participants[0].identity = { ...input.participants[0].identity, associatePerson: true }
    input.meeting.accountId = accountId
    await store.meetings.saveMeeting(input)
    const alice = await store.personOf({ provider: "example", id: "alice-example" })
    expect(alice?.uid).toBeDefined()
    await store.savePeople(account, [{ id: "bob-sample", name: "Alice Example" }])
    const bob = await store.personOf({ provider: "example", id: "bob-sample" })
    expect(bob?.uid).toBeDefined()
    expect(bob?.uid).not.toBe(alice?.uid)
    expect(db.prepare("SELECT count(*) AS n FROM identity_link_events WHERE method='initial'").get()?.n).toBe(2)
    await store.meetings.saveMeeting(input)
    await store.savePeople(account, [{ id: "bob-sample", name: "Alice Example" }])
    expect(db.prepare("SELECT count(*) AS n FROM persons").get()?.n).toBe(beforePeople + 2)
    expect(db.prepare("SELECT count(*) AS n FROM identity_link_events WHERE method='initial'").get()?.n).toBe(2)
  })

  it("never resolves document names during meeting ingestion and rolls back identity repair with an invalid meeting", async () => {
    const { store, accountId, db } = await fixture()
    const beforePeople = db.prepare("SELECT count(*) AS n FROM persons").get()?.n
    const folder = await store.notes.addFolder({ name: "Invented notes", format: "markdown" })
    const { note } = await store.notes.saveFileNote({
      folderId: folder.id,
      path: "example.md",
      title: "Example",
      text: "[[Alice Example]]",
      contentHash: "invented-note-hash",
    })
    await store.notes.replaceFileLinks(note.id, [{ kind: "links-to", targetText: "Alice Example" }])
    const input = sampleMeeting()
    input.participants[0].identity = { ...input.participants[0].identity, associatePerson: true }
    input.meeting.accountId = accountId
    const invalid = {
      ...input,
      transcripts: [
        { ...input.transcripts[0], rows: [{ ...input.transcripts[0].rows[0], speakerParticipantPosition: 10 }] },
      ],
    }
    await expect(store.meetings.saveMeeting(invalid)).rejects.toThrow()
    expect(db.prepare("SELECT count(*) AS n FROM persons").get()?.n).toBe(beforePeople)
    expect(db.prepare("SELECT count(*) AS n FROM identities").get()?.n).toBe(0)
    expect(db.prepare("SELECT count(*) AS n FROM account_identities").get()?.n).toBe(0)
    await store.meetings.saveMeeting(input)
    expect(db.prepare("SELECT to_id FROM links WHERE target_folded = 'alice example'").get()?.to_id).toBeNull()
    await store.meetings.saveMeeting({
      ...input,
      participants: [
        { ...input.participants[0], identity: { ...input.participants[0].identity, name: "Alice Revised Example" } },
      ],
      now: 6000,
    })
    expect(db.prepare("SELECT to_id FROM links WHERE target_folded = 'alice example'").get()?.to_id).toBeNull()
  })
})
