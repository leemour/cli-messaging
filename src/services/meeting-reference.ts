import { CliError } from "@wirecat/cli-core"
import type { Meeting, MeetingDetails, MeetingStore, Transcript, TranscriptRow } from "@wirecat/cli-meetings"
import { formatMeetingReference, type MeetingReference, parseMeetingReference } from "../domain/meeting-reference.js"

export type MeetingReadStore = Pick<MeetingStore, "meeting">
export interface ResolvedMeetingReference {
  reference: string
  meeting: Meeting
  transcript: Transcript | null
  cue: TranscriptRow | null
  revision: "current" | "superseded" | null
  /** The existing port loads all meeting parts before selecting this reference. */
  input: "materialized-meeting"
}

const missing = () => new CliError("not_found", "the meeting evidence is unavailable for this account")
export const authorizedMeetingDetails = async (
  store: MeetingReadStore,
  accountId: number,
  reference: string,
): Promise<{ parsed: MeetingReference; details: MeetingDetails }> => {
  const parsed = parseMeetingReference(reference)
  if (!Number.isSafeInteger(accountId) || accountId < 1)
    throw new CliError("validation_error", "the authorized account ID must be a positive safe integer")
  // Reject a foreign reference before the port can read any meeting rows.
  if (parsed.accountId !== accountId) throw missing()
  const details = await store.meeting(parsed.meetingId)
  if (
    !details ||
    details.meeting.id !== parsed.meetingId ||
    details.meeting.accountId !== accountId ||
    details.meeting.deletedAt !== null
  )
    throw missing()
  return { parsed, details }
}

export const resolveMeetingReference = async (
  store: MeetingReadStore,
  accountId: number,
  reference: string,
): Promise<ResolvedMeetingReference> => {
  const { parsed, details } = await authorizedMeetingDetails(store, accountId, reference)
  const part =
    parsed.transcriptId === undefined
      ? undefined
      : details.transcripts.find(
          ({ transcript }) =>
            transcript.id === parsed.transcriptId &&
            transcript.meetingId === details.meeting.id &&
            transcript.deletedAt === null,
        )
  if (parsed.transcriptId !== undefined && !part) throw missing()
  const cue =
    parsed.cuePosition === undefined
      ? null
      : (part?.rows.find(
          (row) => row.position === parsed.cuePosition && row.meetingTranscriptId === part.transcript.id,
        ) ?? null)
  if (parsed.cuePosition !== undefined && !cue) throw missing()
  return {
    reference: formatMeetingReference(parsed),
    meeting: details.meeting,
    transcript: part?.transcript ?? null,
    cue,
    revision: part ? (part.transcript.supersededAt === null ? "current" : "superseded") : null,
    input: "materialized-meeting",
  }
}
