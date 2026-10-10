import { CliError } from "@wirecat/cli-core"
import { expect, it } from "vitest"
import { batchProgress } from "./batch.js"

it("allows an isolated failure and stops sustained errors after ten attempts", () => {
  const batch = batchProgress({})
  batch.fail("50", "download", new Error("private payload"))
  expect(batch.stopped).toBe(false)
  for (let i = 0; i < 4; i++) batch.ok()
  for (let i = 0; i < 5; i++) batch.fail(String(i), "download", new Error("private payload"))
  expect(batch.stopped).toBe(true)
  expect(batch.result()).toMatchObject({ attempted: 10, failed: 6, stopReason: "error_rate", errorRate: 0.6 })
  expect(JSON.stringify(batch.result())).not.toContain("private payload")
})
it("respects configurable error rate and stops account throttling immediately", () => {
  const batch = batchProgress({ MESSAGING_BATCH_MAX_ERROR_PERCENT: "100" })
  for (let i = 0; i < 20; i++) batch.fail(String(i), "download", new Error())
  expect(batch.stopped).toBe(false)
  batch.fail("21", "download", new CliError("rate_limited", "wait", { retryAfterMs: 600000 }))
  expect(batch.result()).toMatchObject({
    stopReason: "rate_limited",
    failures: expect.arrayContaining([
      expect.objectContaining({
        id: "21",
        error: expect.objectContaining({
          actions: expect.arrayContaining([{ type: "wait", message: expect.any(String), afterMs: 600000 }]),
        }),
      }),
    ]),
  })
  expect(() => batchProgress({ MESSAGING_BATCH_MAX_ERROR_PERCENT: "0" })).toThrow("MESSAGING_BATCH_MAX_ERROR_PERCENT")
})

it("propagates a child extraction stop before a parent batch starts more work", () => {
  const parent = batchProgress({})
  parent.ok()
  const child = batchProgress({})
  child.fail("50", "extract", new CliError("rate_limited", "wait", { retryAfterMs: 600000 }))
  parent.absorb(child.result())
  expect(parent.stopped).toBe(true)
  expect(parent.result()).toMatchObject({ attempted: 2, succeeded: 1, failed: 1, stopReason: "rate_limited" })
  parent.fail("51", "extract", new Error())
  expect(parent.result().stopReason).toBe("rate_limited")
})
