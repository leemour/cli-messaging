import { createHash } from "node:crypto"
import { CliError } from "@wirecat/cli-core"
import type { Transcript, TranscriptRow } from "@wirecat/cli-meetings"
import { formatMeetingReference } from "../domain/meeting-reference.js"
import { authorizedMeetingDetails, type MeetingReadStore } from "./meeting-reference.js"

export interface MeetingEvidenceCue {
  reference: string
  fingerprint: string
  transcriptId: number
  contentHash: string | null
  position: number
  startMs: number
  endMs: number
  speakerParticipantId: number | null
  speakerName: string | null
  text: string
  revision: "current" | "superseded"
}
export interface MeetingEvidencePacket {
  schemaVersion: 1
  kind: "meeting"
  source: string
  fingerprint: string
  limits: { cues: number; bytes: number }
  contentBytes: number
  coverage: {
    provided: number
    included: number
    omitted: number
    hasMore: boolean
    truncatedBy: "cues" | "bytes" | null
    input: "materialized-meeting"
    archiveCompleteness: "unknown"
  }
  items: MeetingEvidenceCue[]
}
export interface MeetingEvidenceOptions {
  cues?: number
  bytes?: number
  signal?: AbortSignal
}
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex")
export const checkMeetingCancelled = (signal?: AbortSignal): void => {
  if (signal?.aborted) throw new CliError("cancelled", "meeting evidence reading was cancelled")
}
export const meetingEvidenceLimits = ({ cues = 100, bytes = 64 * 1024 }: MeetingEvidenceOptions = {}) => {
  if (
    !Number.isSafeInteger(cues) ||
    cues < 1 ||
    cues > 1000 ||
    !Number.isSafeInteger(bytes) ||
    bytes < 2 ||
    bytes > 4 * 1024 * 1024
  )
    throw new CliError("validation_error", "meeting evidence takes 1–1000 cues and 2–4194304 UTF-8 bytes")
  return { cues, bytes }
}
const cueEvidence = (
  accountId: number,
  meetingId: number,
  transcript: Transcript,
  row: TranscriptRow,
): MeetingEvidenceCue => {
  const content = {
    reference: formatMeetingReference({
      type: "meeting",
      accountId,
      meetingId,
      transcriptId: transcript.id,
      cuePosition: row.position,
    }),
    transcriptId: transcript.id,
    contentHash: transcript.contentHash,
    position: row.position,
    startMs: row.startMs,
    endMs: row.endMs,
    speakerParticipantId: row.speakerParticipantId,
    speakerName: row.speakerName,
    text: row.text,
  }
  // Revision availability is read-time metadata, not part of immutable cue identity.
  return {
    ...content,
    fingerprint: hash(content),
    revision: transcript.supersededAt === null ? "current" : "superseded",
  }
}

/** Reads stored evidence only; explicit revision refs retain superseded content. */
export const readMeetingEvidence = async (
  store: MeetingReadStore,
  accountId: number,
  reference: string,
  options: MeetingEvidenceOptions = {},
): Promise<MeetingEvidencePacket> => {
  const limits = meetingEvidenceLimits(options)
  checkMeetingCancelled(options.signal)
  const { parsed, details } = await authorizedMeetingDetails(store, accountId, reference)
  checkMeetingCancelled(options.signal)
  const parts = details.transcripts.filter(
    ({ transcript }) =>
      transcript.meetingId === details.meeting.id &&
      transcript.deletedAt === null &&
      (parsed.transcriptId === undefined ? transcript.supersededAt === null : transcript.id === parsed.transcriptId),
  )
  if (parsed.transcriptId !== undefined && parts.length === 0)
    throw new CliError("not_found", "the transcript revision is unavailable")
  let provided = 0
  let contentBytes = 2
  let truncatedBy: "cues" | "bytes" | null = null
  const items: MeetingEvidenceCue[] = []
  for (const { transcript, rows } of parts) {
    for (const row of rows) {
      checkMeetingCancelled(options.signal)
      if (row.meetingTranscriptId !== transcript.id)
        throw new CliError("invalid_response", "a transcript cue belongs to another revision")
      if (parsed.cuePosition !== undefined && row.position !== parsed.cuePosition) continue
      provided++
      if (truncatedBy !== null) continue
      if (items.length >= limits.cues) {
        truncatedBy = "cues"
        continue
      }
      const item = cueEvidence(accountId, details.meeting.id, transcript, row)
      const bytes = Buffer.byteLength(JSON.stringify(item), "utf8") + (items.length ? 1 : 0)
      if (contentBytes + bytes > limits.bytes) {
        truncatedBy = "bytes"
        continue
      }
      items.push(item)
      contentBytes += bytes
    }
  }
  if (parsed.cuePosition !== undefined && provided === 0)
    throw new CliError("not_found", "the transcript cue is unavailable")
  const packet = {
    schemaVersion: 1 as const,
    kind: "meeting" as const,
    source: formatMeetingReference(parsed),
    limits,
    contentBytes,
    coverage: {
      provided,
      included: items.length,
      omitted: provided - items.length,
      hasMore: provided > items.length,
      truncatedBy,
      input: "materialized-meeting" as const,
      archiveCompleteness: "unknown" as const,
    },
    items,
  }
  return { ...packet, fingerprint: hash(packet) }
}
