import { mkdtempSync, readdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CliError } from "@wirecat/cli-core"
import { expect, it, vi } from "vitest"
import { batchProgress } from "./batch.js"
import { safeName, saveFiles } from "./file-download.js"

it("keeps valid POSIX names and applies Windows constraints only on Windows", () => {
  for (const name of ["CON.txt", "nul", "COM1.pdf", "LPT9"]) {
    expect(safeName(name, "win32")).toBeUndefined()
    expect(safeName(name, "linux")).toBe(name)
  }
  expect(safeName("report:stream. ", "win32")).toBe("report_stream")
  expect(safeName("report:stream. ", "linux")).toBe("report:stream. ")
  expect(safeName("report.pdf", "win32")).toBe("report.pdf")
})

it("keeps successful downloads after a failed middle stream and records their original positions", async () => {
  const root = mkdtempSync(join(tmpdir(), "batch-download-"))
  const keepDownloaded = vi.fn(async (_chat: string, _message: string, _files: readonly { position?: number }[]) => 2)
  const files = [0, 1, 2].map((position) => ({
    kind: "file",
    position,
    name: `synthetic-${position}.txt`,
    bytes: async function* () {
      if (position === 1) throw new CliError("provider_error", "synthetic failure")
      yield Buffer.from("synthetic")
    },
  }))
  const result = await saveFiles({ keepDownloaded }, "7", "50", files, root, {
    warn: vi.fn(),
    batch: batchProgress({}),
  })
  expect(result.saved).toHaveLength(2)
  expect(result.batch).toMatchObject({
    attempted: 3,
    failed: 1,
    succeeded: 2,
    failures: [
      { id: "50", attachment: 2, stage: "download", error: { code: "provider_error", actions: expect.any(Array) } },
    ],
  })
  expect(keepDownloaded.mock.calls[0]?.[2]?.map((file: { position?: number }) => file.position)).toEqual([0, 2])
  expect(readdirSync(root).filter((name) => name.endsWith(".part"))).toEqual([])
})
it("stops a rate-limited download batch without requesting later files", async () => {
  const root = mkdtempSync(join(tmpdir(), "batch-rate-limit-"))
  const read = vi.fn()
  const files = [0, 1, 2].map((position) => ({
    kind: "file",
    position,
    bytes: async function* () {
      read(position)
      if (position === 1) throw new CliError("rate_limited", "wait", { retryAfterMs: 600000 })
      yield Buffer.from("synthetic")
    },
  }))
  const result = await saveFiles({ keepDownloaded: async () => 1 }, "7", "50", files, root, {
    warn: vi.fn(),
    batch: batchProgress({}),
  })
  expect(read.mock.calls.map(([index]) => index)).toEqual([0, 1])
  expect(result.batch).toMatchObject({ failed: 1, succeeded: 1, stopReason: "rate_limited" })
})

it("returns 99 saved files and the failed 50th ID/position instead of discarding a 100-file batch", async () => {
  const root = mkdtempSync(join(tmpdir(), "batch-hundred-"))
  const files = Array.from({ length: 100 }, (_, position) => ({
    kind: "file",
    position,
    name: `synthetic-${position}.txt`,
    bytes: async function* () {
      if (position === 49) throw new CliError("provider_error", "synthetic failure")
      yield Buffer.from("synthetic")
    },
  }))
  const result = await saveFiles({ keepDownloaded: async () => 99 }, "7", "100", files, root, {
    warn: vi.fn(),
    batch: batchProgress({}),
  })
  expect(result.saved).toHaveLength(99)
  expect(result.batch).toMatchObject({
    attempted: 100,
    succeeded: 99,
    failed: 1,
    failures: [{ id: "100", attachment: 50, stage: "download" }],
  })
  expect(result.batch.stopReason).toBeUndefined()
})
