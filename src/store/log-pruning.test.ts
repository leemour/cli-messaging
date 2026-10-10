import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { LOG_RETENTION } from "./sqlite/log-pruning.js"
import { openStore } from "./store.js"

const DAY = 86_400_000
const START = 1_000 * DAY
const account = { provider: "synthetic", account: "bot-1" }
const call = (startedAt: number) => ({
  actor: { bot: "test-mcp" },
  tool: "messages_list",
  tier: "read" as const,
  status: "ok" as const,
  startedAt,
  finishedAt: startedAt + 1,
})

describe("log pruning", () => {
  it("drops agent calls after 90 days and handled bot update payloads after 30, at most once a day", async () => {
    let now = START
    const path = join(mkdtempSync(join(tmpdir(), "pruning-")), "store.db")
    const store = await openStore({ path, now: () => now })
    try {
      await store.agentActions.record(call(now))
      store.botUpdates.save(account, { externalId: "handled", kind: "message", payload: { text: "Synthetic" } })
      store.botUpdates.handled(account, "handled")
      store.botUpdates.save(account, { externalId: "waiting", kind: "message", payload: { text: "Synthetic" } })

      now = START + LOG_RETENTION.botUpdatePayloadsMs + DAY
      await store.agentActions.record(call(now))
      const payloads = Object.fromEntries(store.botUpdates.recent(account).map((u) => [u.externalId, u.payload]))
      expect(payloads).toEqual({ handled: null, waiting: { text: "Synthetic" } })
      expect(await store.agentActions.list()).toHaveLength(2)

      now = START + LOG_RETENTION.agentActionsMs + DAY
      await store.agentActions.record(call(now))
      expect((await store.agentActions.list()).map((a) => Date.parse(a.startedAt))).not.toContain(START)

      await store.agentActions.record(call(START))
      now += DAY - 1
      await store.agentActions.record(call(now))
      expect((await store.agentActions.list()).map((a) => Date.parse(a.startedAt))).toContain(START)
    } finally {
      await store.close()
    }
  })

  it("prunes on open when the last run is more than a day old", async () => {
    let now = START
    const path = join(mkdtempSync(join(tmpdir(), "pruning-")), "store.db")
    const first = await openStore({ path, now: () => now })
    await first.agentActions.record(call(START))
    await first.close()

    now = START + LOG_RETENTION.agentActionsMs + DAY
    const second = await openStore({ path, now: () => now })
    try {
      expect(await second.agentActions.list()).toEqual([])
    } finally {
      await second.close()
    }
  })
})
