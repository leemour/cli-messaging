import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ParticipantPersonLinkInput } from "@wirecat/cli-meetings"
import { sampleMeeting } from "@wirecat/cli-meetings/testing"
import { afterEach, expect, it } from "vitest"
import { openCache } from "./open.js"
import { meetingContextLinksOver } from "./sqlite/meeting-context-links.js"
import { openSqlite } from "./sqlite/open.js"
import { openStore } from "./store.js"

const opened: { close(): unknown }[] = []
afterEach(async () => {
  for (const item of opened.splice(0)) await item.close()
})
const fixture = async () => {
  const path = join(mkdtempSync(join(tmpdir(), "meeting-test-context-links-")), "fixture.db")
  const store = await openStore({ path, env: { MESSAGING_STORE: path }, now: () => 1000 })
  opened.push(store)
  const accountId = await store.saveAccount({ provider: "example", account: "AliceExample" }, { name: "Alice Example" })
  const otherId = await store.saveAccount({ provider: "other", account: "BobSample" }, { name: "Bob Sample" })
  const input = sampleMeeting()
  input.meeting.accountId = accountId
  for (const item of input.participants) item.identity.associatePerson = false
  const saved = await store.meetings.saveMeeting(input)
  const participantId = saved.participants[0]?.id
  if (!participantId) throw new Error("missing synthetic participant")
  await store.savePeople({ provider: "other", account: "BobSample" }, [{ id: "BobSample", name: "Bob Sample" }])
  const target = await store.personOf({ provider: "other", id: "BobSample" })
  if (!target) throw new Error("missing synthetic target")
  const db = await openCache(path)
  opened.push(db)
  return { store, db, accountId, otherId, input, saved, participantId, target, path }
}
const eventInput = {
  eventSeriesId: null,
  title: "Alice Example planning",
  description: null,
  location: null,
  startsAt: 1000,
  endsAt: 2000,
  timezone: null,
  origin: "owner" as const,
  deletedAt: null,
}
it("links and unlinks an event with scoped compare-and-save, without changing a foreign meeting", async () => {
  const { store, accountId, otherId, saved } = await fixture()
  const event = await store.meetings.createEvent(eventInput, 1000)
  const input = { accountId, meetingId: saved.meeting.id, eventId: event.id, expectedEventId: null, now: 2000 }
  expect(await store.meetings.linkMeetingEvent(input)).toEqual({
    meetingId: saved.meeting.id,
    eventId: event.id,
    previousEventId: null,
    changed: true,
  })
  await expect(store.meetings.linkMeetingEvent(input)).rejects.toMatchObject({ code: "configuration_error" })
  expect(await store.meetings.linkMeetingEvent({ ...input, expectedEventId: event.id })).toMatchObject({
    changed: false,
  })
  await expect(
    store.meetings.linkMeetingEvent({ ...input, accountId: otherId, expectedEventId: event.id }),
  ).rejects.toMatchObject({ code: "not_found" })
  expect(await store.meetings.linkMeetingEvent({ ...input, eventId: null, expectedEventId: event.id })).toMatchObject({
    eventId: null,
    previousEventId: event.id,
    changed: true,
  })
})
it("manually associates a guest with an explicitly selected cross-account person and retains audit across reopen", async () => {
  const { store, db, accountId, otherId, saved, participantId, target, path } = await fixture()
  const read = { accountId, meetingId: saved.meeting.id, participantId }
  expect(await store.meetings.participantPerson(read)).toEqual({
    meetingId: saved.meeting.id,
    participantId,
    personUid: null,
  })
  const input = { ...read, personUid: target.uid, expectedPersonUid: null, now: 2000, author: "owner" as const }
  await expect(store.meetings.linkParticipantPerson(input)).rejects.toMatchObject({ code: "not_found" })
  expect(await store.meetings.linkParticipantPerson({ ...input, targetAccountIds: [otherId] })).toEqual({
    meetingId: saved.meeting.id,
    participantId,
    personUid: target.uid,
    previousPersonUid: null,
    changed: true,
  })
  const audit = db
    .prepare("SELECT method,author,from_person_id,to_person_id FROM identity_link_events WHERE identity_id=?")
    .all(Number(saved.participants[0]?.identityId))
  expect(await store.personSeenInAccounts(target.uid, [accountId])).toBe(true)
  expect(audit).toEqual([
    { method: "manual", author: "owner" as const, from_person_id: null, to_person_id: Number(target.uid) },
  ])
  expect(
    await store.meetings.linkParticipantPerson({
      ...input,
      expectedPersonUid: target.uid,
      targetAccountIds: [otherId],
    }),
  ).toMatchObject({ changed: false })
  expect(
    db
      .prepare("SELECT count(*) AS n FROM identity_link_events WHERE identity_id=?")
      .get(Number(saved.participants[0]?.identityId))?.n,
  ).toBe(1)
  const reopened = await openStore({ path, env: { MESSAGING_STORE: path } })
  opened.push(reopened)
  expect(await reopened.meetings.participantPerson(read)).toMatchObject({ personUid: target.uid })
  await expect(reopened.meetings.participantPerson({ ...read, accountId: otherId })).rejects.toMatchObject({
    code: "not_found",
  })
})
it("moves only the reviewed identity, preserves other identity links, and rejects stale person previews", async () => {
  const { store, accountId, otherId, saved, participantId, target, input } = await fixture()
  for (const item of input.participants) item.identity.associatePerson = true
  input.meeting.externalId = "AliceExample-stable-meeting"
  const stable = await store.meetings.saveMeeting(input)
  const selected = stable.participants[0]
  if (!selected) throw new Error("missing synthetic participant")
  const prior = await store.personOf({
    provider: selected.identityId ? input.participants[0].identity.provider : "example",
    id: input.participants[0].identity.externalId,
  })
  if (!prior) throw new Error("missing synthetic person")
  await store.savePeople({ provider: "example", account: "AliceExample" }, [
    { id: "AliceExample-additional", name: "Alice Example" },
  ])
  await store.linkIdentities(
    { provider: input.participants[0].identity.provider, id: input.participants[0].identity.externalId },
    { provider: "example", id: "AliceExample-additional" },
    { method: "manual", by: "owner" },
  )
  const request = {
    accountId,
    meetingId: stable.meeting.id,
    participantId: selected.id,
    personUid: target.uid,
    expectedPersonUid: prior.uid,
    targetAccountIds: [otherId],
    now: 3000,
    author: "owner" as const,
  }
  expect(await store.meetings.linkParticipantPerson(request)).toMatchObject({
    previousPersonUid: prior.uid,
    changed: true,
  })
  expect((await store.personOf({ provider: "example", id: "AliceExample-additional" }))?.uid).toBe(prior.uid)
  await expect(store.meetings.linkParticipantPerson(request)).rejects.toMatchObject({ code: "configuration_error" })
  await expect(
    store.meetings.linkParticipantPerson({
      ...request,
      meetingId: saved.meeting.id,
      participantId,
      targetAccountIds: [999999],
      expectedPersonUid: target.uid,
    }),
  ).rejects.toMatchObject({ code: "not_found" })
})
it("rejects invalid associations and deleted resources without manufacturing people or events", async () => {
  const { store, accountId, saved, participantId, target, input } = await fixture()
  const base = {
    accountId,
    meetingId: saved.meeting.id,
    participantId,
    personUid: target.uid,
    now: 2000,
    author: "owner" as const,
  }
  for (const change of [
    { accountId: 0 },
    { participantId: 0 },
    { personUid: "01" },
    { expectedPersonUid: "x" },
    { author: "" },
    { author: "owner\nagent" },
    { targetAccountIds: [] },
    { targetAccountIds: [0] },
    { now: -1 },
  ])
    await expect(
      store.meetings.linkParticipantPerson({ ...base, ...change } as ParticipantPersonLinkInput),
    ).rejects.toMatchObject({
      code: "validation_error",
    })
  await expect(
    store.meetings.linkMeetingEvent({ accountId, meetingId: saved.meeting.id, eventId: -1, now: 2000 }),
  ).rejects.toMatchObject({ code: "validation_error" })
  await expect(
    store.meetings.linkMeetingEvent({ accountId, meetingId: saved.meeting.id, eventId: 999999, now: 2000 }),
  ).rejects.toMatchObject({ code: "not_found" })
  input.meeting.deletedAt = 3000
  await store.meetings.saveMeeting(input)
  await expect(store.meetings.participantPerson(base)).rejects.toMatchObject({ code: "not_found" })
  await expect(
    store.meetings.linkMeetingEvent({ accountId, meetingId: saved.meeting.id, eventId: null, now: 4000 }),
  ).rejects.toMatchObject({ code: "not_found" })
})
it("rolls back failed manual association without leaving an audit or identity link", async () => {
  const { path, accountId, otherId, saved, participantId, target, db } = await fixture()
  const store = await openStore({ path, env: { MESSAGING_STORE: path } })
  opened.push(store)
  db.exec(
    "CREATE TRIGGER refuse_example_link BEFORE INSERT ON identity_links WHEN NEW.method='manual' BEGIN SELECT RAISE(ABORT,'Example rollback'); END",
  )
  await expect(
    store.meetings.linkParticipantPerson({
      accountId,
      meetingId: saved.meeting.id,
      participantId,
      personUid: target.uid,
      targetAccountIds: [otherId],
      expectedPersonUid: null,
      now: 3000,
      author: "owner" as const,
    }),
  ).rejects.toThrow()
  expect(
    await store.meetings.participantPerson({ accountId, meetingId: saved.meeting.id, participantId }),
  ).toMatchObject({ personUid: null })
})

it("rolls back an event association when cancellation arrives after its SQL write", async () => {
  const { path, store, accountId, saved } = await fixture()
  const event = await store.meetings.createEvent(eventInput, 1000)
  const underlying = await openSqlite(path)
  opened.push(underlying.database)
  const cancelled = new AbortController()
  const database = {
    ...underlying.database,
    prepare: (sql: string) => {
      const statement = underlying.database.prepare(sql)
      return /^UPDATE meetings/.test(sql)
        ? {
            ...statement,
            run: (...args: Parameters<typeof statement.run>) => {
              const result = statement.run(...args)
              cancelled.abort()
              return result
            },
          }
        : statement
    },
  }
  const links = meetingContextLinksOver({ ...underlying, database, now: () => 1000 })
  await expect(
    links.linkMeetingEvent({
      accountId,
      meetingId: saved.meeting.id,
      eventId: event.id,
      expectedEventId: null,
      now: 2000,
      signal: cancelled.signal,
    }),
  ).rejects.toThrow()
  expect((await store.meetings.meeting(saved.meeting.id))?.meeting.eventId).toBeNull()
})
it("reads only a scoped person UID and bounds selected-account inputs before touching global person metadata", async () => {
  const { store, db, accountId, otherId, saved, participantId, target } = await fixture()
  db.prepare("UPDATE persons SET name=? WHERE id=?").run("é".repeat(2000000), Number(target.uid))
  await store.meetings.linkParticipantPerson({
    accountId,
    meetingId: saved.meeting.id,
    participantId,
    personUid: target.uid,
    targetAccountIds: [otherId],
    expectedPersonUid: null,
    now: 2000,
    author: "owner" as const,
  })
  expect(
    await store.meetings.participantPerson({
      accountId,
      meetingId: saved.meeting.id,
      participantId,
      maxReadBytes: 100,
    }),
  ).toEqual({ meetingId: saved.meeting.id, participantId, personUid: target.uid })
  await expect(
    store.meetings.participantPerson({
      accountId: otherId,
      meetingId: saved.meeting.id,
      participantId,
      maxReadBytes: 100,
    }),
  ).rejects.toMatchObject({ code: "not_found" })
  await expect(
    store.meetings.participantPerson({ accountId, meetingId: saved.meeting.id, participantId, maxReadBytes: 0 }),
  ).rejects.toMatchObject({ code: "validation_error" })
  const cancelled = new AbortController()
  cancelled.abort()
  await expect(
    store.meetings.participantPerson({
      accountId,
      meetingId: saved.meeting.id,
      participantId,
      signal: cancelled.signal,
    }),
  ).rejects.toThrow()
  await expect(
    store.meetings.linkParticipantPerson({
      accountId,
      meetingId: saved.meeting.id,
      participantId,
      personUid: target.uid,
      targetAccountIds: Array(1001).fill(otherId),
      now: 2000,
      author: "owner" as const,
    }),
  ).rejects.toMatchObject({ code: "validation_error" })
})
