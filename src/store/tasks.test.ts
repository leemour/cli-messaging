import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createTaskService, type NewTask, type Task } from "@wirecat/cli-tasks"
import { describe, expect, it } from "vitest"
import { openCache } from "./open.js"
import { openStore } from "./store.js"

const fresh = () => join(mkdtempSync(join(tmpdir(), "tasks-")), "messages.db")
const openTasks = async (path: string) => {
  const store = await openStore({ path })
  return Object.assign(store.tasks, { close: () => store.close() })
}

const question: NewTask = {
  source: "msg:telegram:100:-1001:42",
  sourceKind: "message",
  account: "telegram:100",
  group: "-1001",
  kind: "question",
  origin: "rule",
}

const at = (iso: string) => new Date(iso)

describe("tasks in the store", () => {
  it("keeps a task across a reopen, closed state, reason and times included", async () => {
    const path = fresh()
    let ids = 0
    const first = await openTasks(path)
    const service = createTaskService({
      store: first,
      now: () => at("2026-10-05T10:00:00Z"),
      newId: () => `t${++ids}`,
    })
    const { task } = await service.add({ ...question, dueAt: at("2026-10-06T00:00:00Z") })
    await service.close(task.id, { as: "dismissed", by: "owner", reason: "no-reply-needed" })
    await first.close()

    const second = await openTasks(path)
    expect(await second.get("t1")).toEqual({
      ...question,
      id: "t1",
      state: "dismissed",
      reason: "no-reply-needed",
      createdAt: at("2026-10-05T10:00:00Z"),
      dueAt: at("2026-10-06T00:00:00Z"),
      closedAt: at("2026-10-05T10:00:00Z"),
      closedBy: "owner",
    } satisfies Task)
    await second.close()
  })

  it("holds the package's rules: one task per source from a rule, another kind by hand", async () => {
    const store = await openTasks(fresh())
    const service = createTaskService({ store })
    const first = await service.add(question)
    await service.close(first.task.id, { as: "dismissed", by: "owner", reason: "no-reply-needed" })

    expect((await service.add(question)).created).toBe(false)
    expect((await service.add({ ...question, kind: "mention" })).created).toBe(false)
    expect((await service.add({ ...question, kind: "promise", origin: "agent" })).created).toBe(true)
    expect((await service.add({ ...question, account: "max:7" })).created).toBe(true)
    expect(await store.findBySource(question.account, question.source)).toHaveLength(2)
    await store.close()
  })

  it("lists by state, group, kind and age", async () => {
    const store = await openTasks(fresh())
    let now = at("2026-10-05T10:00:00Z")
    const service = createTaskService({ store, now: () => now })
    const old = await service.add(question)
    now = at("2026-10-05T12:00:00Z")
    await service.add({ ...question, source: "msg:telegram:100:-1002:7", group: "-1002", kind: "mention" })
    await service.close(old.task.id, { as: "done", by: "owner" })

    const sources = async (filter: Parameters<typeof service.list>[0]) =>
      (await service.list(filter)).map((task) => task.source)
    expect(await sources({ state: "open" })).toEqual(["msg:telegram:100:-1002:7"])
    expect(await sources({ group: "-1001", account: "telegram:100" })).toEqual([question.source])
    expect(await sources({ kind: "mention" })).toEqual(["msg:telegram:100:-1002:7"])
    expect(await sources({ createdBefore: at("2026-10-05T11:00:00Z") })).toEqual([question.source])
    expect(await sources({})).toHaveLength(2)
    await store.close()
  })

  it("keeps the source's locator and never its text", async () => {
    const path = fresh()
    const store = await openTasks(path)
    await createTaskService({ store }).add(question)
    await store.close()
    const database = await openCache(path)
    const rows = database.prepare("SELECT * FROM tasks").all()
    database.close()

    expect(rows).toHaveLength(1)
    expect(JSON.stringify(rows)).toContain(question.source)
    expect(rows[0]).toMatchObject({
      type: "question",
      status: "open",
      source: "rule",
      key: expect.stringMatching(/^IN[0-9A-F]{8}-1$/),
      source_locator: question.source,
      source_kind: "message",
      source_group: "-1001",
      metadata: null,
    })
  })

  it("ties an inbox project to its account as soon as the messenger saves it, before another task", async () => {
    const path = fresh()
    const store = await openStore({ path })
    const tasks = createTaskService({ store: store.tasks })
    await tasks.add(question)
    const accountId = await store.saveAccount({ provider: "telegram", account: "100" }, { name: null })
    const database = await openCache(path)
    expect(database.prepare("SELECT account_id FROM projects").all()).toEqual([{ account_id: accountId }])

    await store.purge({ provider: "telegram", account: "100" })
    expect(database.prepare("SELECT account_id FROM projects").all()).toEqual([{ account_id: null }])
    database.close()
    await store.close()
  })

  it("records a question's answer and the owner's verdict", async () => {
    const path = fresh()
    const store = await openTasks(path)
    const { task } = await createTaskService({ store, newId: () => "q1" }).add(question)
    await store.answer(task.id, { resolution: "Friday works", by: "msg:telegram/100/-1001/43" })
    await store.judge(task.id, "useful")
    await expect(store.judge(task.id, "great" as "useful")).rejects.toMatchObject({ code: "validation_error" })
    await store.close()
    const database = await openCache(path)
    const row = database.prepare("SELECT id, resolution, verdict FROM tasks").get()
    const link = database.prepare("SELECT from_type, from_id, kind, target_text FROM links").get()
    database.close()

    expect(row).toMatchObject({ resolution: "Friday works", verdict: "useful" })
    expect(link).toEqual({
      from_type: "task",
      from_id: row?.id,
      kind: "answered-by",
      target_text: "msg:telegram/100/-1001/43",
    })
  })

  it("names an unknown value instead of passing it on", async () => {
    const path = fresh()
    const store = await openTasks(path)
    await store.insert({ ...question, id: "t1", state: "open", createdAt: at("2026-10-05T10:00:00Z") })
    const database = await openCache(path)
    database.exec("UPDATE tasks SET type = 'gossip'")
    database.close()

    await expect(store.get("t1")).rejects.toThrow('the store holds a task with an unknown kind "gossip"')
    await store.close()
  })

  it("refuses to update a task it does not have", async () => {
    const store = await openTasks(fresh())

    await expect(
      store.update({ ...question, id: "nope", state: "done", createdAt: at("2026-10-05T10:00:00Z") }),
    ).rejects.toMatchObject({ code: "not_found" })
    await store.close()
  })
})
