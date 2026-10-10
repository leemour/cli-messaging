import { setTimeout as sleep } from "node:timers/promises"
import { isCliFailure } from "../cli/failures.js"

/** Waits longer than this are not sat out: the run stops, and the next one resumes. */
const LONGEST_WAIT_MS = 5 * 60 * 1000

/** Sits out a provider's "wait N seconds" when it is short, a few times; a long one ends the run. */
export const patiently = async <T>(
  request: () => Promise<T>,
  note: (message: string) => void,
  stop: AbortSignal,
): Promise<T> => {
  for (let attempt = 1; ; attempt += 1) {
    stop.throwIfAborted()
    try {
      return await request()
    } catch (error) {
      const wait = isCliFailure(error) && error.code === "rate_limited" ? Number(error.details?.retryAfterMs) : NaN
      if (!Number.isFinite(wait) || wait < 0 || wait > LONGEST_WAIT_MS || attempt >= 3) throw error
      note(`asked to wait ${Math.ceil(wait / 1000)} s — waiting, then going on`)
      await sleep(wait, undefined, { signal: stop }).catch(() => {})
      if (stop.aborted) throw error
    }
  }
}
