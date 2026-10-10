import { CliError } from "@wirecat/cli-core"
import type { Meeting, Transcript, TranscriptRow } from "@wirecat/cli-meetings"
import { formatMeetingReference, type MeetingReference, parseMeetingReference } from "../domain/meeting-reference.js"
import type { MeetingReadCapabilities } from "../store/sqlite/meeting-reads.js"

export type MeetingReadStore = MeetingReadCapabilities
export interface MeetingReferenceReadOptions {
  maxReadBytes?: number
  signal?: AbortSignal
}
export interface ResolvedMeetingReference {
  reference: string
  meeting: Meeting
  transcript: Transcript | null
  cue: TranscriptRow | null
  revision: "current" | "superseded" | null
  input: "bounded-meeting-pages"
}
const missing = () => new CliError("not_found", "the meeting evidence is unavailable for this account")
export const authorizedMeetingMetadata = async (
  store: MeetingReadStore,
  accountId: number,
  reference: string,
  options: MeetingReferenceReadOptions = {},
): Promise<{ parsed: MeetingReference; meeting: Meeting }> => {
  const parsed = parseMeetingReference(reference)
  if (!Number.isSafeInteger(accountId) || accountId < 1)
    throw new CliError("validation_error", "the authorized account ID must be a positive safe integer")
  if (parsed.accountId !== accountId) throw missing()
  if (
    typeof store.meetingMetadata !== "function" ||
    typeof store.transcriptMetadata !== "function" ||
    typeof store.transcripts !== "function" ||
    typeof store.transcriptRows !== "function"
  )
    throw new CliError("configuration_error", "Meeting evidence requires bounded meeting read capabilities")
  const meeting = await store.meetingMetadata({ accountId, meetingId: parsed.meetingId, ...options })
  if (meeting.id !== parsed.meetingId || meeting.accountId !== accountId || meeting.deletedAt !== null) throw missing()
  return { parsed, meeting }
}
export const resolveMeetingReference = async (
  store: MeetingReadStore,
  accountId: number,
  reference: string,
  options: MeetingReferenceReadOptions = {},
): Promise<ResolvedMeetingReference> => {
  const { parsed, meeting } = await authorizedMeetingMetadata(store, accountId, reference, options)
  const scope = { accountId, meetingId: parsed.meetingId, ...options }
  const transcript =
    parsed.transcriptId === undefined
      ? null
      : await store.transcriptMetadata({ ...scope, transcriptId: parsed.transcriptId, includeHistorical: true })
  if (
    transcript &&
    (transcript.id !== parsed.transcriptId || transcript.meetingId !== meeting.id || transcript.deletedAt !== null)
  )
    throw missing()
  let cue: TranscriptRow | null = null
  if (parsed.cuePosition !== undefined && transcript) {
    const page = await store.transcriptRows({
      ...scope,
      transcriptId: transcript.id,
      includeHistorical: true,
      limit: 1,
      ...(parsed.cuePosition === 0 ? {} : { afterPosition: parsed.cuePosition - 1 }),
    })
    cue = page.rows[0] ?? null
    if (
      !cue ||
      cue.position !== parsed.cuePosition ||
      cue.meetingTranscriptId !== transcript.id ||
      page.meeting.id !== meeting.id ||
      page.meeting.accountId !== accountId ||
      page.transcript.id !== transcript.id
    )
      throw missing()
  }
  return {
    reference: formatMeetingReference(parsed),
    meeting,
    transcript,
    cue,
    revision: transcript ? (transcript.supersededAt === null ? "current" : "superseded") : null,
    input: "bounded-meeting-pages",
  }
}
