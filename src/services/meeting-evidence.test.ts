import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CliError } from "@wirecat/cli-core"
import type { MeetingSave } from "@wirecat/cli-meetings"
import { sampleMeeting } from "@wirecat/cli-meetings/testing"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  canonicalMeetingReference,
  formatMeetingReference,
  parseMeetingReference,
} from "../domain/meeting-reference.js"
import { type MessageStore, openStore } from "../store/store.js"
import { readMeetingEvidence } from "./meeting-evidence.js"
import { type MeetingReadStore, resolveMeetingReference } from "./meeting-reference.js"
import { proposeMeetingTask } from "./meeting-task-proposal.js"
import { type PersonMeetingReadStore, personMeetingContext } from "./person-meeting-context.js"

const opened: MessageStore[] = []
afterEach(async () => {
  for (const store of opened.splice(0)) await store.close()
})
const unread = (meeting: MeetingReadStore["meetingMetadata"]): MeetingReadStore => ({
  meetingMetadata: meeting,
  transcriptMetadata: vi.fn(),
  transcripts: vi.fn(),
  transcriptRows: vi.fn(),
})
const fixture = async () => {
  const owner = await openStore({ path: join(mkdtempSync(join(tmpdir(), "zm-test-bounded-evidence-")), "store.db") })
  opened.push(owner)
  await owner.saveAccount({ provider: "example", account: "alice-example" }, { name: "Alice Example" })
  const store = owner.meetings
  const input = sampleMeeting()
  input.meeting.title = "Alice Example and Bob Sample"
  input.transcripts[0].rows[0].speakerName = "Alice Example"
  input.transcripts[0].rows[0].text = "Alice Example will send the draft 🚀"
  const details = await store.saveMeeting(input)
  const transcriptId = details.transcripts[0]?.transcript.id as number
  const position = details.transcripts[0]?.rows[0]?.position as number
  const reference = formatMeetingReference({
    type: "meeting",
    accountId: input.meeting.accountId,
    meetingId: details.meeting.id,
    transcriptId,
    cuePosition: position,
  })
  return { store, input, details, reference }
}

describe("meeting evidence references", () => {
  it("canonicalizes safe local IDs and preserves cue zero", () => {
    expect(canonicalMeetingReference(" meeting:0001/02/03/00 ")).toBe("meeting:1/2/3/0")
    expect(parseMeetingReference("meeting:1/2")).toEqual({ type: "meeting", accountId: 1, meetingId: 2 })
    for (const value of [
      "meeting:0/2",
      "meeting:1/-2",
      "meeting:1/2/3/-1",
      "meeting:1/2/3/4/5",
      "meeting:1/",
      "meeting:1/9007199254740992",
      "meeting:1/2/3/1e1",
      "meeting:%31/2",
      "msg:1/2",
    ])
      expect(() => parseMeetingReference(value)).toThrow(expect.objectContaining({ code: "validation_error" }))
    expect(() => formatMeetingReference({ type: "meeting", accountId: 1, meetingId: 2, cuePosition: 0 })).toThrow()
  })

  it("denies a foreign account before asking the store for rows", async () => {
    const meeting = vi.fn()
    await expect(resolveMeetingReference(unread(meeting), 2, "meeting:1/1/1/0")).rejects.toMatchObject({
      code: "not_found",
    })
    expect(meeting).not.toHaveBeenCalled()
  })

  it("retains original cue identity and fingerprint after a correction", async () => {
    const { store, input, reference, details } = await fixture()
    const first = await readMeetingEvidence(store, input.meeting.accountId, reference)
    const proposal = await proposeMeetingTask(store, input.meeting.accountId, reference, "promise")
    input.transcripts[0].contentHash = "corrected-example"
    input.transcripts[0].rows[0].text = "Bob Sample will send a different draft"
    await store.saveMeeting(input)
    const old = await resolveMeetingReference(store, input.meeting.accountId, reference)
    expect(old.cue?.text).toContain("Alice Example")
    expect(old.revision).toBe("superseded")
    const historical = await readMeetingEvidence(store, input.meeting.accountId, reference)
    expect(historical.items[0]?.fingerprint).toBe(first.items[0]?.fingerprint)
    const current = await readMeetingEvidence(
      store,
      input.meeting.accountId,
      `meeting:${input.meeting.accountId}/${details.meeting.id}`,
    )
    expect(current.items.some((item) => item.text.includes("different draft"))).toBe(true)
    expect(current.items.every((item) => item.revision === "current")).toBe(true)
    const nextProposal = await proposeMeetingTask(store, input.meeting.accountId, reference, "promise")
    expect(nextProposal.id).toBe(proposal.id)
    expect(nextProposal).toMatchObject({ applied: false, persistence: "proposal-only", revision: "superseded" })
  })

  it("keeps whole UTF-8 cues within the exact array budget", async () => {
    const { store, input, reference } = await fixture()
    const full = await readMeetingEvidence(store, input.meeting.accountId, reference)
    expect(full.contentBytes).toBe(Buffer.byteLength(JSON.stringify(full.items), "utf8"))
    const small = await readMeetingEvidence(store, input.meeting.accountId, reference, { bytes: full.contentBytes - 1 })
    expect(small.items).toEqual([])
    expect(small.contentBytes).toBe(2)
    expect(small.coverage).toMatchObject({
      included: 0,
      omitted: null,
      truncatedBy: "bytes",
      input: "bounded-meeting-pages",
    })
    expect(
      (await readMeetingEvidence(store, input.meeting.accountId, reference, { bytes: full.contentBytes })).items,
    ).toEqual(full.items)
  })

  it("reports remaining complete cues when the cue-count limit is reached", async () => {
    const { store, input, details } = await fixture()
    input.transcripts[0].contentHash = "two-example-cues"
    input.transcripts[0].rows.push({ ...input.transcripts[0].rows[0], position: 1, text: "Bob Sample will review it" })
    await store.saveMeeting(input)
    const packet = await readMeetingEvidence(
      store,
      input.meeting.accountId,
      `meeting:${input.meeting.accountId}/${details.meeting.id}`,
      { cues: 1 },
    )
    expect(packet.items).toHaveLength(1)
    expect(packet.coverage).toMatchObject({ provided: 2, omitted: null, hasMore: true, truncatedBy: "cues" })
  })

  it("rejects missing revisions and cues, invalid limits and cancelled reads", async () => {
    const { store, input, details } = await fixture()
    for (const ref of [
      `meeting:${input.meeting.accountId}/${details.meeting.id}/9999`,
      `meeting:${input.meeting.accountId}/${details.meeting.id}/1/9999`,
    ])
      await expect(readMeetingEvidence(store, input.meeting.accountId, ref)).rejects.toMatchObject({
        code: "not_found",
      })
    const meeting = vi.fn()
    await expect(readMeetingEvidence(unread(meeting), 1, "meeting:1/1", { cues: 0 })).rejects.toMatchObject({
      code: "validation_error",
    })
    await expect(
      readMeetingEvidence(unread(meeting), 1, "meeting:1/1", { signal: AbortSignal.abort() }),
    ).rejects.toMatchObject({ code: "cancelled" })
    expect(meeting).not.toHaveBeenCalled()
  })

  it("rejects deleted parents and mismatched revision ownership", async () => {
    const { details, input, reference } = await fixture()
    const accountId = input.meeting.accountId
    const wrapped = (value: typeof details): MeetingReadStore => ({
      meetingMetadata: async () => value.meeting,
      transcriptMetadata: async () =>
        value.transcripts[0]?.transcript as (typeof details.transcripts)[number]["transcript"],
      transcripts: async () => ({ items: value.transcripts.map((part) => part.transcript), hasMore: false }),
      transcriptRows: async () => ({
        meeting: value.meeting,
        transcript: value.transcripts[0]?.transcript as (typeof details.transcripts)[number]["transcript"],
        rows: value.transcripts[0]?.rows ?? [],
        hasMore: false,
      }),
    })
    await expect(
      resolveMeetingReference(
        wrapped({ ...details, meeting: { ...details.meeting, deletedAt: 1 } }),
        accountId,
        reference,
      ),
    ).rejects.toMatchObject({ code: "not_found" })
    await expect(
      resolveMeetingReference(
        wrapped({ ...details, meeting: { ...details.meeting, accountId: 999 } }),
        accountId,
        reference,
      ),
    ).rejects.toMatchObject({ code: "not_found" })
    const part = details.transcripts[0] as (typeof details.transcripts)[number]
    await expect(
      resolveMeetingReference(
        wrapped({ ...details, transcripts: [{ ...part, transcript: { ...part.transcript, deletedAt: 1 } }] }),
        accountId,
        reference,
      ),
    ).rejects.toMatchObject({ code: "not_found" })
    await expect(
      resolveMeetingReference(
        wrapped({ ...details, transcripts: [{ ...part, transcript: { ...part.transcript, meetingId: 999 } }] }),
        accountId,
        reference,
      ),
    ).rejects.toMatchObject({ code: "not_found" })
    await expect(
      readMeetingEvidence(
        wrapped({
          ...details,
          transcripts: [{ ...part, rows: part.rows.map((row) => ({ ...row, meetingTranscriptId: 999 })) }],
        }),
        accountId,
        reference,
      ),
    ).rejects.toMatchObject({ code: "invalid_response" })
  })

  it("does not return evidence when cancellation arrives during the store read", async () => {
    const { details, reference, input, store } = await fixture()
    const controller = new AbortController()
    await expect(
      readMeetingEvidence(
        {
          ...store,
          meetingMetadata: async () => {
            controller.abort()
            return details.meeting
          },
        },
        input.meeting.accountId,
        reference,
        { signal: controller.signal },
      ),
    ).rejects.toMatchObject({ code: "cancelled" })
  })

  it("persists historical references across a real store reopen without creating tasks", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "meeting-evidence-example-")), "store.db")
    let store = await openStore({ path })
    const accountId = await store.saveAccount(
      { provider: "example", account: "alice-example" },
      { name: "Alice Example" },
    )
    const input = sampleMeeting()
    input.meeting.accountId = accountId
    const first = await store.meetings.saveMeeting(input)
    const ref = `meeting:${accountId}/${first.meeting.id}/${first.transcripts[0]?.transcript.id}/${first.transcripts[0]?.rows[0]?.position}`
    await proposeMeetingTask(store.meetings, accountId, ref, "request")
    input.transcripts[0].contentHash = "example-correction"
    input.transcripts[0].rows[0].text = "Bob Sample corrected the draft"
    await store.meetings.saveMeeting(input)
    await store.close()
    store = await openStore({ path })
    try {
      const resolved = await resolveMeetingReference(store.meetings, accountId, ref)
      expect(resolved.revision).toBe("superseded")
      expect(resolved.cue?.text).not.toBe("Bob Sample corrected the draft")
      expect(await store.tasks.list({ account: "example:alice-example" })).toEqual([])
    } finally {
      await store.close()
    }
  })
})

it("person context honors explicit account scope and reports mixed-index scan limits", async () => {
  const { store: meetings, input, details } = await fixture()
  const foreign = {
    personId: 1,
    identityId: null,
    subjectType: "meeting",
    subjectId: 999,
    role: "participant",
    occurredAt: 1,
    scope: "work",
    accountId: 2,
    projectId: null,
    provider: "example",
    account: "bob-sample",
    chat: null,
    message: null,
  }
  const port: PersonMeetingReadStore = {
    meetings,
    personSeenInAccounts: async () => true,
    personByUid: vi.fn(async () => ({ uid: "1", name: "Alice Example", identities: [] })),
    involvements: {
      pending: () => 3,
      forPerson: () => [foreign, { ...foreign, subjectId: details.meeting.id, accountId: input.meeting.accountId }],
      rebuild: () => {
        throw new Error("must not rebuild")
      },
      drain: () => {
        throw new Error("must not drain")
      },
    },
  }
  const result = await personMeetingContext(port, "person:1", { accountIds: [input.meeting.accountId], scanLimit: 2 })
  expect(result.items).toHaveLength(1)
  expect(result.items[0]?.reference).toBe(`meeting:${input.meeting.accountId}/${details.meeting.id}`)
  expect(result.coverage).toMatchObject({ scanLimitReached: true, pending: 3, complete: false })
  expect(result.contentBytes).toBe(Buffer.byteLength(JSON.stringify(result.items), "utf8"))
  const bounded = await personMeetingContext(port, "person:1", { accountIds: [input.meeting.accountId], bytes: 2 })
  expect(bounded.items).toEqual([])
  expect(bounded.coverage.truncatedBy).toBe("bytes")
  await expect(personMeetingContext(port, "person:1", { accountIds: [] })).rejects.toMatchObject({
    code: "validation_error",
  })
})

it("person context skips stale missing meetings while preserving other typed failures", async () => {
  const { store: meetings, input, details } = await fixture()
  const row = {
    personId: 1,
    identityId: null,
    subjectType: "meeting",
    subjectId: 999,
    role: "participant",
    occurredAt: 1,
    scope: "work",
    accountId: input.meeting.accountId,
    projectId: null,
    provider: "example",
    account: "alice-example",
    chat: null,
    message: null,
  }
  const port: PersonMeetingReadStore = {
    meetings,
    personSeenInAccounts: async () => true,
    personByUid: async () => ({ uid: "1", name: "Alice Example", identities: [] }),
    involvements: {
      pending: () => 1,
      forPerson: () => [row, { ...row, subjectId: details.meeting.id }],
      rebuild: () => {
        throw new Error("must not rebuild")
      },
      drain: () => {
        throw new Error("must not drain")
      },
    },
  }
  const result = await personMeetingContext(port, "person:1", { accountIds: [input.meeting.accountId] })
  expect(result.items).toHaveLength(1)
  expect(result.coverage.skippedUnavailable).toBe(1)
  const broken = {
    ...port,
    meetings: {
      ...meetings,
      meetingMetadata: async () => {
        throw new CliError("invalid_response", "invented source error")
      },
    },
  }
  await expect(
    personMeetingContext(broken, "person:1", { accountIds: [input.meeting.accountId] }),
  ).rejects.toMatchObject({ code: "invalid_response" })
})

it("reads bounded pages, resumes exact cues and never materializes meeting history", async () => {
  const { store, input, details } = await fixture()
  input.transcripts[0].contentHash = "bounded-example"
  input.transcripts[0].rows.splice(
    0,
    input.transcripts[0].rows.length,
    ...Array.from({ length: 5 }, (_, position) => ({
      ...input.transcripts[0].rows[0],
      position,
      text: `Alice Example cue ${position}`,
    })),
  )
  await store.saveMeeting(input)
  const fullRead = vi.fn(async () => {
    throw new Error("History materialization is forbidden")
  })
  const port = { ...store, meeting: fullRead }
  const source = `meeting:${input.meeting.accountId}/${details.meeting.id}`
  const first = await readMeetingEvidence(port, input.meeting.accountId, source, { cues: 1 })
  expect(first.items.map((item) => item.position)).toEqual([0])
  expect(first.coverage).toMatchObject({
    provided: 2,
    providedExact: false,
    omitted: null,
    hasMore: true,
    input: "bounded-meeting-pages",
  })
  const second = await readMeetingEvidence(port, input.meeting.accountId, source, {
    cues: 1,
    after: first.coverage.nextReference ?? undefined,
  })
  expect(second.items.map((item) => item.position)).toEqual([1])
  const final = await readMeetingEvidence(port, input.meeting.accountId, source, {
    cues: 10,
    after: second.coverage.nextReference ?? undefined,
  })
  expect(final.items.map((item) => item.position)).toEqual([2, 3, 4])
  expect(final.coverage).toMatchObject({ hasMore: false, providedExact: true, omitted: 0, nextReference: null })
  expect(fullRead).not.toHaveBeenCalled()
  await expect(
    readMeetingEvidence(port, input.meeting.accountId, source, { after: "meeting:999/1/1/0" }),
  ).rejects.toMatchObject({ code: "validation_error" })
})

it("rejects an oversized stored cue before producing JSON and seeks exact cue positions", async () => {
  const { store, input, details } = await fixture()
  input.transcripts[0].contentHash = "gap-example"
  input.transcripts[0].rows.splice(
    0,
    input.transcripts[0].rows.length,
    ...[0, 2].map((position) => ({
      ...input.transcripts[0].rows[0],
      position,
      text: `Alice Example ${"x".repeat(2000)}`,
    })),
  )
  const saved = await store.saveMeeting(input)
  const transcriptId = saved.transcripts.find((part) => part.transcript.supersededAt === null)?.transcript.id
  const source = `meeting:${input.meeting.accountId}/${details.meeting.id}/${transcriptId}`
  await expect(
    readMeetingEvidence(store, input.meeting.accountId, source, { maxReadBytes: 200 }),
  ).rejects.toMatchObject({ code: "validation_error" })
  await expect(resolveMeetingReference(store, input.meeting.accountId, `${source}/1`)).rejects.toMatchObject({
    code: "not_found",
  })
  expect((await resolveMeetingReference(store, input.meeting.accountId, `${source}/2`)).cue?.position).toBe(2)
})

it("bounds empty revision work and exposes a revision seek continuation", async () => {
  const { store, input, details } = await fixture()
  const save: MeetingSave = {
    ...input,
    transcripts: [0, 1, 2].map((index) => ({
      ...input.transcripts[0],
      source: index === 0 ? input.transcripts[0].source : `empty-example-${index}`,
      contentHash: `empty-example-${index}`,
      rows: [],
    })),
  }
  await store.saveMeeting(save)
  const source = `meeting:${input.meeting.accountId}/${details.meeting.id}`
  const first = await readMeetingEvidence(store, input.meeting.accountId, source, { maxTranscriptPages: 1 })
  expect(first.items).toEqual([])
  expect(first.coverage).toMatchObject({
    providedExact: false,
    omitted: null,
    hasMore: true,
    truncatedBy: "transcripts",
    nextReference: null,
    transcriptPages: 1,
  })
  expect(first.coverage.nextTranscriptId).not.toBeNull()
  const remainder = await readMeetingEvidence(store, input.meeting.accountId, source, {
    afterTranscriptId: first.coverage.nextTranscriptId ?? undefined,
  })
  expect(remainder.items).toEqual([])
  expect(remainder.coverage).toMatchObject({ providedExact: true, hasMore: false, transcriptPages: 2 })
})
