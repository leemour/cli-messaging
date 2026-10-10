import { expect, it } from "vitest"
import { withRecovery } from "./recovery.js"

it("gives machine-readable wait and configuration actions without authorizing an uncertain write replay", () => {
  expect(withRecovery({ code: "rate_limited", message: "wait", retryAfterMs: 30000 })).toMatchObject({
    retryable: true,
    actions: [{ type: "wait", afterMs: 30000 }, { type: "retry" }],
  })
  expect(
    withRecovery({ code: "validation_error", message: "file exceeds budget; configure MESSAGING_ATTACHMENT_MAX_MIB" }),
  ).toMatchObject({ actions: [{ type: "configure", setting: "MESSAGING_ATTACHMENT_MAX_MIB" }, { type: "skip" }] })
  expect(withRecovery({ code: "outcome_unknown", message: "write outcome unknown" })).toMatchObject({
    retryable: false,
    actions: [{ type: "check", message: expect.stringContaining("duplicate") }, { type: "skip" }],
  })
  expect(
    withRecovery({ code: "provider_error", message: "file too large", status: 413 }).actions[0]?.message,
  ).toContain("provider limits")
})
