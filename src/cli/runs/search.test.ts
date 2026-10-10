import { appendFileSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"
import { startRun } from "./run.js"
import { searchRuns } from "./search.js"

it("searches error codes, partial IDs and safe events with profile isolation and pagination", async () => {
  const dir = mkdtempSync(join(tmpdir(), "run-search-"))
  const run = startRun({ runsDir: dir, profile: "work", command: "messages download", cliVersion: "1.0.0" })
  run.logger.info({
    event: "response",
    operation: "messages.download",
    errorCode: "rate_limited",
    ids: { message: "50" },
    message: "private synthetic payload",
    token: "synthetic forbidden token",
  })
  await run.finish("partial", {
    partial: { failed: 1, failures: [{ id: "50", stage: "download", errorCode: "rate_limited" }] },
  })
  appendFileSync(join(run.dir, "events.jsonl"), "{invalid JSON\n")
  const other = startRun({ runsDir: dir, profile: "other", command: "messages download", cliVersion: "1.0.0" })
  await other.finish("failed", { errorCode: "rate_limited" })
  const result = searchRuns(dir, { profile: "work", errorCode: "rate_limited", status: "partial" })
  expect(result.items).toHaveLength(1)
  expect(result.items[0]).toMatchObject({
    partial: { failures: [{ id: "50" }] },
    events: [{ operation: "messages.download", errorCode: "rate_limited" }],
  })
  expect(JSON.stringify(result)).not.toContain("private synthetic payload")
  expect(JSON.stringify(result)).not.toContain("synthetic forbidden token")
  expect(searchRuns(dir, { query: "50", profile: "work" }).items).toHaveLength(1)
  expect(searchRuns(dir, { errorCode: "rate_limited", limit: 1 }).hasMore).toBe(true)
  expect(searchRuns(dir, { errorCode: "rate_limited", limit: 1, page: 2 }).items).toHaveLength(1)
  expect(() => searchRuns(dir, { since: "not a date" })).toThrow("--since")
})
