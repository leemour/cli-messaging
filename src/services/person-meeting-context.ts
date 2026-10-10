import { CliError } from "@wirecat/cli-core"
import { formatMeetingReference } from "../domain/meeting-reference.js"
import type { MessageStore } from "../store/store.js"
import { checkMeetingCancelled, type MeetingEvidenceCue, readMeetingEvidence } from "./meeting-evidence.js"
import type { MeetingReadStore } from "./meeting-reference.js"

export interface PersonMeetingContextOptions {
  /** Authorized by the caller; never inferred from matching names or email addresses. */
  accountIds: readonly number[]
  meetings?: number
  cues?: number
  bytes?: number
  scanLimit?: number
  since?: number
  signal?: AbortSignal
}
export interface PersonMeetingContextItem {
  reference: string
  cues: MeetingEvidenceCue[]
  cueCoverage: { included: number; omitted: number; hasMore: boolean }
}
export interface PersonMeetingContext {
  person: { uid: string; name: string | null }
  items: PersonMeetingContextItem[]
  limits: { meetings: number; cues: number; bytes: number; scanLimit: number }
  contentBytes: number
  coverage: {
    involvementsScanned: number
    scanLimitReached: boolean
    pending: number
    truncatedBy: "meetings" | "bytes" | null
    skippedUnavailable: number
    complete: false
    input: "materialized-meeting"
  }
}
export type PersonMeetingReadStore = Pick<MessageStore, "personByUid" | "involvements"> & {
  meetings: MeetingReadStore
}

/** Identity-linked meeting context only; reads the derived index without rebuilding it. */
export const personMeetingContext = async (
  store: PersonMeetingReadStore,
  personReference: string,
  options: PersonMeetingContextOptions,
): Promise<PersonMeetingContext> => {
  const { meetings = 10, cues = 5, bytes = 64 * 1024, scanLimit = 1000, since, signal } = options
  const valid = (value: number, min: number, max: number) => Number.isSafeInteger(value) && value >= min && value <= max
  if (
    !valid(meetings, 1, 100) ||
    !valid(cues, 1, 1000) ||
    !valid(bytes, 2, 4 * 1024 * 1024) ||
    !valid(scanLimit, 1, 1000) ||
    !options.accountIds.length ||
    options.accountIds.some((id) => !valid(id, 1, Number.MAX_SAFE_INTEGER)) ||
    (since !== undefined && !Number.isSafeInteger(since))
  )
    throw new CliError(
      "validation_error",
      "person meeting context requires explicit account IDs and valid bounded limits",
    )
  if (
    !/^person:[1-9]\d*$/.test(personReference) ||
    !valid(Number(personReference.slice(7)), 1, Number.MAX_SAFE_INTEGER)
  )
    throw new CliError("validation_error", "expected person:<positive safe store ID>")
  checkMeetingCancelled(signal)
  const person = await store.personByUid(personReference.slice(7))
  checkMeetingCancelled(signal)
  if (!person) throw new CliError("not_found", "the person is unavailable")
  const pending = store.involvements.pending()
  const rows = store.involvements.forPerson(Number(person.uid), {
    limit: scanLimit,
    ...(since === undefined ? {} : { since }),
  })
  const allowed = new Set(options.accountIds)
  const selected = new Set<string>()
  let contentBytes = 2
  let truncatedBy: "meetings" | "bytes" | null = null
  const items: PersonMeetingContextItem[] = []
  let skippedUnavailable = 0
  for (const row of rows) {
    checkMeetingCancelled(signal)
    if (row.subjectType !== "meeting" || row.accountId === null || !allowed.has(row.accountId)) continue
    const reference = formatMeetingReference({ type: "meeting", accountId: row.accountId, meetingId: row.subjectId })
    if (selected.has(reference)) continue
    selected.add(reference)
    if (items.length >= meetings) {
      truncatedBy = "meetings"
      break
    }
    let evidence: Awaited<ReturnType<typeof readMeetingEvidence>>
    try {
      evidence = await readMeetingEvidence(store.meetings, row.accountId, reference, {
        cues,
        bytes,
        ...(signal ? { signal } : {}),
      })
    } catch (error) {
      if (error instanceof CliError && error.code === "not_found") {
        skippedUnavailable++
        continue
      }
      throw error
    }
    const item = {
      reference,
      cues: evidence.items,
      cueCoverage: {
        included: evidence.coverage.included,
        omitted: evidence.coverage.omitted,
        hasMore: evidence.coverage.hasMore,
      },
    }
    const itemBytes = Buffer.byteLength(JSON.stringify(item), "utf8") + (items.length ? 1 : 0)
    if (contentBytes + itemBytes > bytes) {
      truncatedBy = "bytes"
      break
    }
    items.push(item)
    contentBytes += itemBytes
  }
  checkMeetingCancelled(signal)
  return {
    person: { uid: person.uid, name: person.name },
    items,
    limits: { meetings, cues, bytes, scanLimit },
    contentBytes,
    coverage: {
      involvementsScanned: rows.length,
      scanLimitReached: rows.length >= scanLimit,
      pending,
      truncatedBy,
      skippedUnavailable,
      complete: false,
      input: "materialized-meeting",
    },
  }
}
