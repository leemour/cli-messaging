import { CliError } from "@wirecat/cli-core"
import { isCliFailure } from "../cli/failures.js"
import { type ActionableError, withRecovery } from "../cli/recovery.js"

export interface BatchFailure {
  id: string
  stage: string
  error: ActionableError
  attachment?: number
}
export const actionable = (error: unknown): ActionableError => {
  if (isCliFailure(error)) return withRecovery({ code: error.code, message: error.message, ...error.details })
  if (
    error &&
    typeof error === "object" &&
    "code" in error &&
    "message" in error &&
    typeof error.code === "string" &&
    typeof error.message === "string"
  )
    return withRecovery(error as { code: string; message: string; [key: string]: unknown })
  return withRecovery({
    code: "generic_failure",
    message: "the operation failed; inspect diagnostic logs and retry or skip unfinished read items",
  })
}

export const batchProgress = (env: NodeJS.ProcessEnv = process.env) => {
  const threshold = Number(env.MESSAGING_BATCH_MAX_ERROR_PERCENT ?? 50)
  if (!Number.isInteger(threshold) || threshold < 1 || threshold > 100)
    throw new CliError("validation_error", "MESSAGING_BATCH_MAX_ERROR_PERCENT must be a whole percentage from 1 to 100")
  let attempted = 0
  let succeeded = 0
  let stopReason: "rate_limited" | "authentication" | "error_rate" | "cancelled" | undefined
  const failures: BatchFailure[] = []
  return {
    ok: () => {
      attempted += 1
      succeeded += 1
    },
    fail: (id: string, stage: string, error: unknown, attachment?: number) => {
      attempted += 1
      const detail = actionable(error)
      failures.push({ id, stage, error: detail, ...(attachment === undefined ? {} : { attachment }) })
      if (detail.code === "rate_limited" || detail.status === 429) stopReason = "rate_limited"
      else if (detail.code === "authentication_error") stopReason = "authentication"
      else if (detail.code === "cancelled") stopReason = "cancelled"
      else if (!stopReason && attempted >= 10 && (failures.length * 100) / attempted > threshold)
        stopReason = "error_rate"
      return detail
    },
    absorb: (other: {
      attempted: number
      succeeded: number
      failures: BatchFailure[]
      stopReason?: typeof stopReason
    }) => {
      attempted += other.attempted
      succeeded += other.succeeded
      failures.push(...other.failures)
      if (other.stopReason === "rate_limited" || !stopReason) stopReason = other.stopReason
      if (!stopReason && attempted >= 10 && (failures.length * 100) / attempted > threshold) stopReason = "error_rate"
    },
    get stopped() {
      return stopReason !== undefined
    },
    get failed() {
      return failures.length
    },
    result: () => ({
      attempted,
      succeeded,
      failed: failures.length,
      errorRate: attempted === 0 ? 0 : failures.length / attempted,
      failures,
      ...(stopReason === undefined ? {} : { stopReason }),
      maxErrorPercent: threshold,
    }),
  }
}

export type BatchResult = ReturnType<ReturnType<typeof batchProgress>["result"]>

export const mergeBatches = (a?: BatchResult, b?: BatchResult): BatchResult | undefined => {
  if (!a) return b
  if (!b) return a
  const attempted = a.attempted + b.attempted
  const failed = a.failed + b.failed
  const stopReason =
    a.stopReason === "rate_limited" || b.stopReason === "rate_limited" ? "rate_limited" : (a.stopReason ?? b.stopReason)
  return {
    attempted,
    failed,
    succeeded: a.succeeded + b.succeeded,
    errorRate: attempted ? failed / attempted : 0,
    failures: [...a.failures, ...b.failures],
    maxErrorPercent: a.maxErrorPercent,
    ...(stopReason ? { stopReason } : {}),
  }
}
