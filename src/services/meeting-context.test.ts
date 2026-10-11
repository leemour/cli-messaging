import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { sampleMeeting } from "@wirecat/cli-meetings/testing"
import { afterEach, expect, it, vi } from "vitest"
import { type AccountKey, type MessageStore, openStore } from "../store/store.js"
import { createMeetingContextService, type MeetingContextServiceStore } from "./meeting-context.js"

const account: AccountKey = { provider: "example", account: "AliceExample", scope: "work" }
const handles: MessageStore[] = []
afterEach(async () => {
  for (const store of handles.splice(0)) await store.close()
})
const fixture = async () => {
  const directory = mkdtempSync(join(tmpdir(), "meeting-test-system-context-"))
  const path = join(directory, "fixture.db")
  const env = {
    HOME: directory,
    USERPROFILE: directory,
    APPDATA: directory,
    LOCALAPPDATA: directory,
    XDG_CONFIG_HOME: directory,
    XDG_CACHE_HOME: directory,
    XDG_DATA_HOME: directory,
    XDG_STATE_HOME: directory,
    MESSAGING_STORE: path,
  }
  const store = await openStore({ path, env, now: () => 5000 })
  handles.push(store)
  const accountId = await store.saveAccount(account, { name: "Alice Example" })
  const input = sampleMeeting()
  input.meeting.accountId = accountId
  const details = await store.meetings.saveMeeting(input)
  const root = `meeting:${accountId}/${details.meeting.id}`
  const cue = `${root}/${details.transcripts[0]?.transcript.id}/0`
  return { store, accountId, input, details, root, cue, path, env }
}

it("shares meeting notes, tags and memories with existing records and retains original cue evidence", async () => {
  const { store, details, root, cue, input, accountId, path, env } = await fixture()
  const service = await createMeetingContextService(store, account, { now: () => 5000 })
  const id = details.meeting.id
  expect((await service.change(id, { action: "note.add", text: "Invented memo", title: "Example note" })).applied).toBe(
    false,
  )
  expect((await store.notes.notes({ about: root })).items).toHaveLength(0)
  const note = await service.change(
    id,
    { action: "note.add", text: "Invented memo", title: "Example note" },
    { apply: true },
  )
  expect(note.result).toMatchObject({ text: "Invented memo", title: "Example note", source: "internal" })
  expect((await store.notes.notes({ about: root })).items).toHaveLength(1)
  await service.change(id, { action: "tags.add", tags: ["example", "planning"] }, { apply: true })
  expect(await store.knowledge.tags(account, { type: "meeting", id: String(id) })).toEqual(["example", "planning"])
  await service.change(id, { action: "tags.remove", tags: ["planning"] }, { apply: true })
  expect(await store.knowledge.tags(account, { type: "meeting", id: String(id) })).toEqual(["example"])
  const memory = await service.change(
    id,
    { action: "memory.add", body: "Invented decision", kind: "fact", scope: "work", evidence: [cue] },
    { apply: true },
  )
  expect(memory.result).toMatchObject({ subject: root, evidence: [cue], status: "confirmed", scope: "work" })
  input.transcripts[0].contentHash = "example-corrected"
  input.transcripts[0].rows[0].text = "Bob Sample proposed a different plan"
  await store.meetings.saveMeeting(input)
  await service.change(
    id,
    {
      action: "memory.add",
      body: "Invented summary",
      kind: "summary",
      scope: "personal",
      evidence: [root, cue],
      subject: root,
    },
    { apply: true },
  )
  expect(await store.memories.list({ subject: root })).toHaveLength(2)
  const reopened = await openStore({ path, env })
  handles.push(reopened)
  expect((await reopened.notes.notes({ about: root })).items[0]?.text).toBe("Invented memo")
  expect(await reopened.memories.list({ subject: root })).toHaveLength(2)
  expect(
    (
      await reopened.meetings.transcriptMetadata({
        accountId,
        meetingId: id,
        transcriptId: details.transcripts[0]?.transcript.id ?? 0,
        includeHistorical: true,
      })
    ).supersededAt,
  ).not.toBeNull()
})

it("denies foreign/deleted meeting and memory evidence before writing", async () => {
  const { store, accountId, details, root, input } = await fixture()
  const other: AccountKey = { provider: "other", account: "BobSample" }
  const otherId = await store.saveAccount(other, { name: "Bob Sample" })
  const otherInput = sampleMeeting()
  otherInput.meeting.accountId = otherId
  const foreign = await store.meetings.saveMeeting(otherInput)
  const service = await createMeetingContextService(store, account)
  await expect(
    service.change(foreign.meeting.id, { action: "note.add", text: "Example" }, { apply: true }),
  ).rejects.toMatchObject({ code: "not_found" })
  for (const reference of [`meeting:${otherId}/${foreign.meeting.id}`, `meeting:${accountId}/999999`, "person:1"]) {
    await expect(
      service.change(
        details.meeting.id,
        { action: "memory.add", body: "Example", kind: "fact", scope: "work", evidence: [reference] },
        { apply: true },
      ),
    ).rejects.toThrow()
  }
  await expect(
    service.change(
      details.meeting.id,
      {
        action: "memory.add",
        body: "Example",
        kind: "fact",
        scope: "work",
        evidence: [root],
        subject: `meeting:${otherId}/${foreign.meeting.id}`,
      },
      { apply: true },
    ),
  ).rejects.toMatchObject({ code: "not_found" })
  expect(await store.memories.list()).toHaveLength(0)
  expect((await store.notes.notes({ about: root })).items).toHaveLength(0)
  input.meeting.deletedAt = 6000
  await store.meetings.saveMeeting(input)
  await expect(
    service.change(details.meeting.id, { action: "tags.add", tags: ["example"] }, { apply: true }),
  ).rejects.toMatchObject({ code: "not_found" })
})

it("captures account and approval, preserves cancellation and dispatches scoped links", async () => {
  const { store, accountId, details } = await fixture()
  const mutable = { ...account }
  const service = await createMeetingContextService(store, mutable, { now: () => 7000 })
  mutable.account = "foreign"
  expect(service.scope.account).toBe("AliceExample")
  const event = await store.meetings.createEvent(
    {
      eventSeriesId: null,
      title: "Example event",
      description: null,
      location: null,
      startsAt: 1000,
      endsAt: 2000,
      timezone: "UTC",
      origin: "owner",
      deletedAt: null,
    },
    1000,
  )
  expect(
    (
      await service.change(
        details.meeting.id,
        { action: "event.link", eventId: event.id, expectedEventId: null },
        { apply: true },
      )
    ).result,
  ).toMatchObject({ changed: true, eventId: event.id })
  const participantId = details.participants[0]?.id ?? 0
  const current = await store.meetings.participantPerson({ accountId, meetingId: details.meeting.id, participantId })
  expect(current.personUid).not.toBeNull()
  expect(
    (
      await service.change(
        details.meeting.id,
        {
          action: "person.link",
          participantId,
          personUid: current.personUid ?? "1",
          expectedPersonUid: current.personUid,
          targetAccountIds: [accountId],
        },
        { apply: true },
      )
    ).result,
  ).toMatchObject({ changed: false })
  const controller = new AbortController()
  controller.abort()
  await expect(
    service.change(
      details.meeting.id,
      { action: "note.add", text: "Example" },
      { apply: true, signal: controller.signal },
    ),
  ).rejects.toMatchObject({ code: "cancelled" })
  const options = { apply: false }
  const addNote = vi.spyOn(store.notes, "addNote")
  const wrapped: MeetingContextServiceStore = {
    ...store,
    meetings: {
      ...store.meetings,
      meetingMetadata: async (input) => {
        options.apply = true
        return store.meetings.meetingMetadata(input)
      },
    },
  }
  const captured = await createMeetingContextService(wrapped, account)
  expect((await captured.change(details.meeting.id, { action: "note.add", text: "Example" }, options)).applied).toBe(
    false,
  )
  expect(addNote).not.toHaveBeenCalled()
  await expect(
    createMeetingContextService(
      { ...store, storedAccount: async () => ({ ...(await store.storedAccount(account)), provider: "foreign" }) },
      account,
    ),
  ).rejects.toMatchObject({ code: "not_found" })
})
