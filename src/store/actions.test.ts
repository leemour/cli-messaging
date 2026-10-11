import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { openCache } from "./open.js"
import { type MessageStore, openStore } from "./store.js"

const live: MessageStore[] = []
afterEach(async () => {
  for (const store of live.splice(0)) await store.close()
})
const open = async () => {
  const path = join(mkdtempSync(join(tmpdir(), "actions-")), "store.db")
  const store = await openStore({ path })
  live.push(store)
  return { store, path }
}

describe("proposed actions", () => {
  it("go proposed → approved → executed, and a rejected one never runs", async () => {
    const { store } = await open()
    const note = await store.notes.addNote({ text: "Reply to Alice Example" })
    const reply = await store.proposedActions.propose({
      kind: "reply",
      by: { bot: "helper" },
      target: note.ref,
      payload: { text: "Thanks, Friday works" },
      reason: "she asked twice",
    })
    expect(reply).toMatchObject({ status: "proposed", payload: { text: "Thanks, Friday works" }, target: note.ref })
    expect((await store.proposedActions.pending()).map(({ id }) => id)).toEqual([reply.id])

    await expect(store.proposedActions.executed(reply.id)).rejects.toMatchObject({
      details: { reason: "proposal_state" },
    })
    expect(await store.proposedActions.approve(reply.id)).toMatchObject({
      status: "approved",
      decidedBy: { type: "person" },
      decidedAt: expect.any(String),
    })
    expect(await store.proposedActions.pending()).toEqual([])
    expect(await store.proposedActions.executed(reply.id, { messageId: "77" })).toMatchObject({
      status: "executed",
      result: { messageId: "77" },
      executedAt: expect.any(String),
    })
    expect(await store.proposedActions.judge(reply.id, "useful")).toMatchObject({ verdict: "useful" })

    const ban = await store.proposedActions.propose({ kind: "ban", by: { bot: "helper" } })
    await store.proposedActions.reject(ban.id)
    await expect(store.proposedActions.approve(ban.id)).rejects.toMatchObject({ code: "validation_error" })
    await expect(store.proposedActions.failed(ban.id, "nope")).rejects.toMatchObject({ code: "validation_error" })
  })
})

describe("the agent log", () => {
  it("keeps who called which tool, its tier and outcome — and only a code for an error", async () => {
    const { store, path } = await open()
    await store.agentActions.record({
      actor: { bot: "tg-mcp" },
      tool: "messages_send",
      tier: "write-public",
      status: "failed",
      error: "Could not send 'secret words' to chat",
      startedAt: 1,
      finishedAt: 2,
    })
    const [row] = await store.agentActions.list()
    expect(row).toMatchObject({ tool: "messages_send", tier: "write-public", status: "failed", error: "error" })
    const database = await openCache(path)
    const raw = JSON.stringify(database.prepare("SELECT * FROM agent_actions").all())
    database.close()
    expect(raw).not.toContain("secret words")
  })
})

describe("listing proposals and the agent log", () => {
  it("lists proposals newest first, by status, and names the agent behind each logged call", async () => {
    const { store } = await open()
    const first = await store.proposedActions.propose({ kind: "reply", by: { bot: "helper" } })
    const second = await store.proposedActions.propose({ kind: "ban", by: { bot: "helper" } })
    await store.proposedActions.reject(first.id)

    expect((await store.proposedActions.list()).map(({ id }) => id)).toEqual([second.id, first.id])
    expect((await store.proposedActions.list({ status: "rejected" })).map(({ id }) => id)).toEqual([first.id])
    await expect(store.proposedActions.list({ status: "lost" as never })).rejects.toMatchObject({
      code: "validation_error",
    })

    const call = { tier: "read" as const, status: "ok" as const, startedAt: 1, finishedAt: 2 }
    expect(await store.agentActions.record({ ...call, actor: { bot: "tg-mcp" }, tool: "messages_list" })).toMatchObject(
      {
        actor: { type: "bot", name: "tg-mcp" },
      },
    )
    await store.agentActions.record({ ...call, actor: { bot: "memo-mcp" }, tool: "memories_add" })
    expect((await store.agentActions.list({ agent: "memo-mcp" })).map(({ tool }) => tool)).toEqual(["memories_add"])
  })
})
