import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"
import type { Messenger } from "../../cli/messenger/context.js"
import { runsDirFor, startRun } from "../../cli/runs/run.js"
import type { Defaults } from "../tool.js"
import { runsTools } from "./runs.js"

it("exposes diagnostic search through MCP for the selected profile only", async () => {
  const app = { command: "chat", appName: "chat-cli", envPrefix: "APP", description: "synthetic", version: "1.0.0" }
  const env = { APP_STATE_DIR: mkdtempSync(join(tmpdir(), "mcp-runs-")) }
  for (const profile of ["work", "other"]) {
    const run = startRun({
      runsDir: runsDirFor(app, env),
      profile,
      command: "messages download",
      cliVersion: app.version,
    })
    await run.finish("failed", { errorCode: "rate_limited" })
  }
  const tool = runsTools({ app } as Messenger).runs_search
  if (!tool?.local) throw new Error("log search tool missing")
  const result = await tool.local({ error_code: "rate_limited" }, {
    env,
    settings: { profile: "work" },
  } as unknown as Defaults)
  expect(result).toMatchObject({ items: [{ profile: "work", errorCode: "rate_limited" }], hasMore: false })
  expect((result as { items: unknown[] }).items).toHaveLength(1)
})
