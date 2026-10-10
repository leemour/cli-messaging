import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CliError } from "@wirecat/cli-core"
import { sampleMeeting } from "@wirecat/cli-meetings/testing"
import { createTaskService } from "@wirecat/cli-tasks"
import { afterEach, describe, expect, it, vi } from "vitest"
import { type AccountKey, type MessageStore, openStore } from "../store/store.js"
import { createTaskFromMeeting, type MeetingTaskStore, readMeetingTask } from "./meeting-tasks.js"

const handles: MessageStore[] = []
afterEach(async () => {
  for (const store of handles.splice(0)) await store.close()
})
const account: AccountKey = { provider: "example", account: "alice-example" }
const fixture = async () => {
  const path = join(mkdtempSync(join(tmpdir(), "meeting-task-example-")), "store.db")
  const store = await openStore({ path })
  handles.push(store)
  const accountId = await store.saveAccount(account, { name: "Alice Example" })
  const input = sampleMeeting()
  input.meeting.accountId = accountId
  input.transcripts[0].rows[0].text = "Alice Example will send the invented draft"
  const details = await store.meetings.saveMeeting(input)
  const source = `meeting:${accountId}/${details.meeting.id}/${details.transcripts[0]?.transcript.id}/${details.transcripts[0]?.rows[0]?.position}`
  return { store, path, input, details, source, accountId }
}

describe("explicit meeting task provenance", () => {
  it("creates one canonical task, retains a closed task, and reads original cue after correction", async () => {
    const { store, source, input } = await fixture()
    const first = await createTaskFromMeeting(store, account, { source, kind: "promise", origin: "owner" })
    expect(first.created).toBe(true)
    expect(first.task).toMatchObject({ sourceKind: "meeting", source, account: "example:alice-example" })
    expect(first.task).not.toHaveProperty("preview")
    expect(
      await createTaskFromMeeting(store, account, {
        source: source.replace("meeting:", "meeting:00"),
        kind: "promise",
        origin: "agent",
      }),
    ).toMatchObject({ created: false, task: { id: first.task.id } })
    await createTaskService({ store: store.tasks }).close(first.task.id, { as: "dismissed", by: "owner" })
    input.transcripts[0].contentHash = "invented-corrected-hash"
    input.transcripts[0].rows[0].text = "Bob Sample will send a different draft"
    await store.meetings.saveMeeting(input)
    const repeat = await createTaskFromMeeting(store, account, { source, kind: "request", origin: "rule" })
    expect(repeat).toMatchObject({ created: false, task: { id: first.task.id, state: "dismissed" } })
    const view = await readMeetingTask(store, account, first.task.id)
    expect(view).toMatchObject({
      state: "available",
      source: { revision: "superseded", preview: "Alice Example will send the invented draft" },
    })
  })

  it("keeps references across close/reopen and never registers a missing account", async () => {
    const { store, path, source } = await fixture()
    const created = await createTaskFromMeeting(store, account, {
      source,
      kind: "request",
      origin: "owner",
      dueAt: new Date("2026-10-15T12:00:00Z"),
    })
    await store.close()
    handles.splice(handles.indexOf(store), 1)
    const reopened = await openStore({ path })
    handles.push(reopened)
    expect(await readMeetingTask(reopened, account, created.task.id)).toMatchObject({
      source: { reference: source },
      task: { dueAt: new Date("2026-10-15T12:00:00Z") },
    })
    await expect(
      createTaskFromMeeting(
        reopened,
        { provider: "example", account: "missing-example" },
        { source, kind: "request", origin: "owner" },
      ),
    ).rejects.toMatchObject({ code: "not_found" })
    expect(await reopened.storedAccounts()).toHaveLength(1)
  })

  it("denies foreign task and source accounts before returning content or writing", async () => {
    const { store, source, accountId } = await fixture()
    const created = await createTaskFromMeeting(store, account, { source, kind: "request", origin: "owner" })
    await store.saveAccount({ provider: "example", account: "bob-sample" }, { name: "Bob Sample" })
    await expect(
      readMeetingTask(store, { provider: "example", account: "bob-sample" }, created.task.id),
    ).rejects.toMatchObject({ code: "not_found" })
    await expect(
      createTaskFromMeeting(store, account, {
        source: source.replace(`meeting:${accountId}/`, "meeting:999/"),
        kind: "promise",
        origin: "owner",
      }),
    ).rejects.toMatchObject({ code: "not_found" })
    expect(await store.tasks.list({ account: "example:alice-example" })).toHaveLength(1)
  })

  it("reports a deleted source as unavailable without retaining source text in the task", async () => {
    const { store, source } = await fixture()
    const created = await createTaskFromMeeting(store, account, { source, kind: "request", origin: "owner" })
    const unavailable: MeetingTaskStore = {
      storedAccount: (key) => store.storedAccount(key),
      tasks: store.tasks,
      meetings: {
        ...store.meetings,
        meetingMetadata: async () => {
          throw new CliError("not_found", "Deleted invented meeting")
        },
      },
    }
    expect(await readMeetingTask(unavailable, account, created.task.id)).toMatchObject({
      state: "unavailable",
      source: null,
      task: { source },
    })
    const broken = {
      ...unavailable,
      meetings: {
        ...store.meetings,
        meetingMetadata: async () => {
          throw new CliError("invalid_response", "invented source failure")
        },
      },
    }
    await expect(readMeetingTask(broken, account, created.task.id)).rejects.toMatchObject({ code: "invalid_response" })
  })

  it("validates source, kind, origin and due date before account lookup", async () => {
    const storedAccount = vi.fn()
    const port = { storedAccount } as unknown as MeetingTaskStore
    const valid = { source: "meeting:1/2/3/0", kind: "request" as const, origin: "owner" as const }
    for (const input of [
      { ...valid, source: "msg:example/alice/chat/1" },
      { ...valid, dueAt: new Date("invalid") },
      { ...valid, kind: "unknown" },
      { ...valid, origin: "unknown" },
    ])
      await expect(createTaskFromMeeting(port, account, input as typeof valid)).rejects.toMatchObject({
        code: "validation_error",
      })
    expect(storedAccount).not.toHaveBeenCalled()
  })

  it("snapshots the account and task request across asynchronous lookup", async () => {
    const { store, source } = await fixture()
    const selected = { ...account }
    const input = {
      source,
      kind: "promise" as const,
      origin: "owner" as const,
      dueAt: new Date("2026-10-15T12:00:00Z"),
    }
    const port: MeetingTaskStore = {
      meetings: store.meetings,
      tasks: store.tasks,
      storedAccount: async (key) => {
        const found = await store.storedAccount(key)
        selected.account = "bob-sample"
        input.dueAt.setFullYear(2030)
        Object.assign(input, { kind: "request", origin: "agent", source: "meeting:999/999" })
        return found
      },
    }
    const result = await createTaskFromMeeting(port, selected, input)
    expect(result.task).toMatchObject({
      account: "example:alice-example",
      source,
      kind: "promise",
      origin: "owner",
      dueAt: new Date("2026-10-15T12:00:00Z"),
    })
  })
})

it("rejects invalid account metadata before reading a meeting", async () => {
  const meeting = vi.fn()
  const base = {
    id: 1,
    provider: "example",
    account: "alice-example",
    name: "Alice Example",
    scope: "personal" as const,
  }
  const input = { source: "meeting:1/2/3/0", kind: "request" as const, origin: "owner" as const }
  for (const value of [
    { ...base, id: 0 },
    { ...base, account: "bob-sample" },
  ]) {
    const port = { storedAccount: async () => value, meetings: { meeting } } as unknown as MeetingTaskStore
    await expect(createTaskFromMeeting(port, account, input)).rejects.toMatchObject({
      code: value.id === 0 ? "invalid_response" : "not_found",
    })
  }
  const port = { storedAccount: async () => base, meetings: { meeting } } as unknown as MeetingTaskStore
  await expect(createTaskFromMeeting(port, { ...account, scope: "work" }, input)).rejects.toMatchObject({
    code: "not_found",
  })
  expect(meeting).not.toHaveBeenCalled()
})

it("rejects missing and non-meeting task views without reinterpreting their sources", async () => {
  const { store } = await fixture()
  await expect(readMeetingTask(store, account, "missing-example")).rejects.toMatchObject({ code: "not_found" })
  const task = await createTaskService({ store: store.tasks }).add({
    source: "msg:example/alice-example/chat/1",
    sourceKind: "message",
    account: "example:alice-example",
    group: "chat",
    kind: "request",
    origin: "owner",
  })
  await expect(readMeetingTask(store, account, task.task.id)).rejects.toMatchObject({ code: "validation_error" })
  await expect(
    createTaskFromMeeting(
      store,
      { provider: "", account: "alice-example" },
      { source: "meeting:1/2", kind: "request", origin: "owner" },
    ),
  ).rejects.toMatchObject({ code: "validation_error" })
})
