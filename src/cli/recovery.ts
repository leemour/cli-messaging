export interface RecoveryAction {
  type: "wait" | "retry" | "configure" | "skip" | "check"
  message: string
  afterMs?: number
  setting?: string
}

export interface ActionableError {
  code: string
  message: string
  retryable: boolean
  actions: RecoveryAction[]
  retryAfterMs?: number
  [key: string]: unknown
}

export const withRecovery = (error: { code: string; message: string; [key: string]: unknown }): ActionableError => {
  const wait = Number(error.retryAfterMs)
  const rate = error.code === "rate_limited" || error.status === 429
  const actions: RecoveryAction[] = []
  if (rate) {
    actions.push({
      type: "wait",
      message: "Wait before retrying; do not immediately repeat requests.",
      ...(Number.isFinite(wait) && wait >= 0 ? { afterMs: wait } : {}),
    })
    actions.push({ type: "retry", message: "Resume the unfinished items after the provider's wait." })
  } else {
    const setting =
      typeof error.setting === "string"
        ? error.setting
        : error.message.match(/MESSAGING_[A-Z_]+|--(?:max-output-bytes|timeout|max-input-bytes)/)?.[0]
    if (setting)
      actions.push({ type: "configure", setting, message: `Check or increase ${setting}, then retry the failed item.` })
    else if (/already exists/i.test(error.message))
      actions.push({
        type: "check",
        message: "Choose another output folder/name or skip the existing file; it was not overwritten.",
      })
    else if (error.code === "ENOSPC")
      actions.push({ type: "check", message: "Free disk space or choose another output folder before resuming." })
    else if (error.code === "cancelled")
      actions.push({ type: "retry", message: "Resume unfinished read items when ready; completed work is retained." })
    else if (error.limitSource === "local" && /size limit|too.large|exceeds/i.test(error.message))
      actions.push({
        type: "check",
        message:
          "Split the document or use another reader; local decompression/text budgets remain separate from the configurable file-size budget.",
      })
    else if (error.status === 413 || /too.large|exceeds|size limit/i.test(error.message))
      actions.push({
        type: "check",
        message:
          "Use a smaller file, lower image resolution or split the input; provider limits cannot be raised in local settings.",
      })
    else if (error.code === "authentication_error")
      actions.push({
        type: "check",
        message: "Check the selected account/profile and reconnect or sign in before resuming.",
      })
    else if (error.code === "permission_error")
      actions.push({ type: "check", message: "Check the selected profile's permissions and access to this item." })
    else if (error.code === "timeout" || error.code === "network_error")
      actions.push({
        type: "check",
        message: "Check connectivity and timeout settings, then retry unfinished read operations.",
      })
    else if (error.code === "not_found")
      actions.push({
        type: "check",
        message: "Check the item ID or path; it may have been removed or may need downloading again.",
      })
    else if (error.code === "outcome_unknown")
      actions.push({
        type: "check",
        message: "Verify whether the operation completed before retrying; replay could duplicate a write.",
      })
    else actions.push({ type: "check", message: "Check the reported input or provider error before retrying." })
    actions.push({ type: "skip", message: "Skip this item and continue independent work." })
  }
  return {
    ...error,
    retryable: typeof error.retryable === "boolean" ? error.retryable : rate,
    actions: Array.isArray(error.actions) ? (error.actions as RecoveryAction[]) : actions,
  }
}
