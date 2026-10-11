import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createTaskService } from "@wirecat/cli-tasks"
import { afterEach, expect, it } from "vitest"
import { type MessageStore, openStore } from "../store/store.js"
import { storeOnlyDeps } from "./deps.js"
import { approveAsTask, proposalSource } from "./proposal-tasks.js"
import { taskAccount } from "./task-rules.js"
import { tasksService } from "./tasks.js"

const live: MessageStore[] = []
afterEach(async () => {
  for (const store of live.splice(0)) await store.close()
})
const account = { provider: "example", account: "alice-example" }
const app = { command: "chat", appName: "chat-cli", envPrefix: "CHAT", description: "A test", version: "1.0.0" }

const opened = async () => {
  const store = await openStore({ path: join(mkdtempSync(join(tmpdir(), "proposal-tasks-")), "store.db") })
  live.push(store)
  await store.saveAccount(account, { name: "Alice Example" })
  return store
}

it("approves a proposal as the account's task, records it, and lists it with the account's tasks", async () => {
  const store = await opened()
  const proposal = await store.proposedActions.propose({
    kind: "reply",
    by: { bot: "helper" },
    account,
    payload: { text: "Friday works" },
    reason: "Bob Sample asked twice",
  })

  const { proposal: approved, task } = await approveAsTask(store, proposal.id)

  expect(task).toMatchObject({ source: proposalSource(proposal.id), sourceKind: "proposed_action", kind: "request" })
  expect(approved).toMatchObject({ status: "approved", result: { task: task.id } })
  await expect(approveAsTask(store, proposal.id)).rejects.toMatchObject({ details: { reason: "proposal_state" } })
  const listed = await tasksService(storeOnlyDeps(store, account, { app, env: {} })).list({})
  expect(listed.map(({ id }) => id)).toEqual([task.id])
  expect(listed[0]).toMatchObject({ message: null })
})

it("finds the task an interrupted approval already made instead of making a second", async () => {
  const store = await opened()
  const proposal = await store.proposedActions.propose({ kind: "ban", by: { bot: "helper" }, account })
  const { task: earlier } = await createTaskService({ store: store.tasks }).add({
    source: proposalSource(proposal.id),
    sourceKind: "proposed_action",
    account: taskAccount(account),
    group: "ban",
    kind: "request",
    origin: "agent",
  })

  const { task } = await approveAsTask(store, proposal.id)

  expect(task.id).toBe(earlier.id)
  expect(await store.tasks.list({ account: taskAccount(account) })).toHaveLength(1)
})

it("refuses a proposal that names no account", async () => {
  const store = await opened()
  const proposal = await store.proposedActions.propose({ kind: "reply", by: { bot: "helper" } })
  await expect(approveAsTask(store, proposal.id)).rejects.toMatchObject({ code: "validation_error" })
  expect((await store.proposedActions.get(proposal.id)).status).toBe("proposed")
})
