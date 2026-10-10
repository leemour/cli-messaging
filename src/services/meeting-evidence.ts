import { createHash } from "node:crypto"
import { CliError } from "@wirecat/cli-core"
import type { Transcript, TranscriptRow } from "@wirecat/cli-meetings"
import { formatMeetingReference, parseMeetingReference } from "../domain/meeting-reference.js"
import { authorizedMeetingMetadata, type MeetingReadStore } from "./meeting-reference.js"

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
  limits: { cues: number; bytes: number; maxReadBytes: number; maxTranscriptPages: number }
  contentBytes: number
  coverage: {
    provided: number
    included: number
    omitted: number | null
    providedExact: boolean
    nextTranscriptId: number | null
    nextReference: string | null
    transcriptPages: number
    skippedUnavailable: number
    hasMore: boolean
    truncatedBy: "cues" | "bytes" | "transcripts" | null
    input: "bounded-meeting-pages"
    archiveCompleteness: "unknown"
  }
  items: MeetingEvidenceCue[]
}
export interface MeetingEvidenceOptions {
  cues?: number
  bytes?: number
  signal?: AbortSignal
  /** Bound stored TEXT bytes per SQL read page, separately from output JSON bytes. */
  maxReadBytes?: number
  maxTranscriptPages?: number
  /** Resume after an exact cue reference from the same authorized source. */
  after?: string
  /** Resume after a fully read current revision, including an empty one. */
  afterTranscriptId?: number
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
  const maxReadBytes = options.maxReadBytes ?? 4 * 1024 * 1024
  const maxTranscriptPages = options.maxTranscriptPages ?? 100
  if (
    !Number.isSafeInteger(maxReadBytes) ||
    maxReadBytes < 1 ||
    maxReadBytes > 64 * 1024 * 1024 ||
    !Number.isSafeInteger(maxTranscriptPages) ||
    maxTranscriptPages < 1 ||
    maxTranscriptPages > 1000
  )
    throw new CliError("validation_error", "Invalid meeting evidence input or transcript page budget")
  const readOptions = { maxReadBytes, ...(options.signal ? { signal: options.signal } : {}) }
  const { parsed, meeting } = await authorizedMeetingMetadata(store, accountId, reference, readOptions)
  checkMeetingCancelled(options.signal)
  const after = options.after === undefined ? undefined : parseMeetingReference(options.after)
  if (
    after &&
    (after.accountId !== accountId ||
      after.meetingId !== meeting.id ||
      after.transcriptId === undefined ||
      after.cuePosition === undefined ||
      parsed.cuePosition !== undefined ||
      (parsed.transcriptId !== undefined && after.transcriptId !== parsed.transcriptId))
  )
    throw new CliError("validation_error", "Evidence continuation must identify a cue of the same source")
  if (
    options.afterTranscriptId !== undefined &&
    (!Number.isSafeInteger(options.afterTranscriptId) ||
      options.afterTranscriptId < 1 ||
      after !== undefined ||
      parsed.transcriptId !== undefined)
  )
    throw new CliError("validation_error", "Invalid transcript continuation")
  const scope = { accountId, meetingId: meeting.id, ...readOptions }
  if (after?.transcriptId !== undefined) {
    const retained = await store.transcriptMetadata({
      ...scope,
      transcriptId: after.transcriptId,
      includeHistorical: true,
    })
    if (retained.meetingId !== meeting.id || retained.id !== continuationTranscriptId || retained.deletedAt !== null)
      throw new CliError("not_found", "The evidence continuation revision is unavailable")
  }
  let provided = 0
  let contentBytes = 2
  let truncatedBy: "cues" | "bytes" | "transcripts" | null = null
  const items: MeetingEvidenceCue[] = []
  let transcriptPages = 0
  let skippedUnavailable = 0
  let hasMore = false
  let nextReference: string | null = options.after ?? null
  let nextTranscriptId: number | null = options.afterTranscriptId ?? null
  let afterId = after?.transcriptId === undefined ? options.afterTranscriptId : after.transcriptId - 1
  if (afterId === 0) afterId = undefined
  let done = false
  while (!done) {
    checkMeetingCancelled(options.signal)
    if (transcriptPages >= maxTranscriptPages) {
      truncatedBy = "transcripts"
      hasMore = true
      break
    }
    transcriptPages++
    let transcript: Transcript
    let moreTranscripts = false
    if (parsed.transcriptId !== undefined) {
      transcript = await store.transcriptMetadata({
        ...scope,
        transcriptId: parsed.transcriptId,
        includeHistorical: true,
      })
      done = true
    } else {
      const page = await store.transcripts({ ...scope, limit: 1, ...(afterId === undefined ? {} : { afterId }) })
      const first = page.items[0]
      if (!first) {
        if (page.hasMore) throw new CliError("invalid_response", "Transcript page cannot advance")
        break
      }
      if (afterId !== undefined && first.id <= afterId)
        throw new CliError("invalid_response", "Transcript page cannot advance")
      transcript = first
      moreTranscripts = page.hasMore
      afterId = transcript.id
      done = !moreTranscripts
    }
    if (
      transcript.meetingId !== meeting.id ||
      transcript.deletedAt !== null ||
      (parsed.transcriptId === undefined && transcript.supersededAt !== null)
    )
      throw new CliError("invalid_response", "Transcript metadata belongs to another or unavailable source")
    let afterPosition = after?.transcriptId === transcript.id ? after.cuePosition : undefined
    if (parsed.cuePosition !== undefined) afterPosition = parsed.cuePosition === 0 ? undefined : parsed.cuePosition - 1
    for (;;) {
      checkMeetingCancelled(options.signal)
      const remaining = limits.cues - items.length
      let page: Awaited<ReturnType<MeetingReadStore["transcriptRows"]>>
      try {
        page = await store.transcriptRows({
          ...scope,
          transcriptId: transcript.id,
          includeHistorical: parsed.transcriptId !== undefined,
          limit: parsed.cuePosition !== undefined ? 1 : Math.min(1000, remaining + 1),
          ...(afterPosition === undefined ? {} : { afterPosition }),
        })
      } catch (error) {
        if (parsed.transcriptId === undefined && error instanceof CliError && error.code === "not_found") {
          skippedUnavailable++
          break
        }
        throw error
      }
      if (
        page.meeting.id !== meeting.id ||
        page.meeting.accountId !== accountId ||
        page.transcript.id !== transcript.id
      )
        throw new CliError("invalid_response", "Transcript read returned another source")
      if (parsed.cuePosition !== undefined && page.rows[0]?.position !== parsed.cuePosition)
        throw new CliError("not_found", "The transcript cue is unavailable")
      for (const row of page.rows) {
        checkMeetingCancelled(options.signal)
        if (afterPosition !== undefined && row.position <= afterPosition)
          throw new CliError("invalid_response", "Transcript cue page cannot advance")
        if (row.meetingTranscriptId !== transcript.id)
          throw new CliError("invalid_response", "A cue belongs to another revision")
        provided++
        if (items.length >= limits.cues) {
          truncatedBy = "cues"
          hasMore = true
          break
        }
        const item = cueEvidence(accountId, meeting.id, page.transcript, row)
        const bytes = Buffer.byteLength(JSON.stringify(item), "utf8") + (items.length ? 1 : 0)
        if (contentBytes + bytes > limits.bytes) {
          truncatedBy = "bytes"
          hasMore = true
          break
        }
        items.push(item)
        contentBytes += bytes
        nextReference = item.reference
        afterPosition = row.position
      }
      if (truncatedBy !== null || parsed.cuePosition !== undefined || !page.hasMore) break
      if (page.rows.length === 0 || page.nextPosition === undefined)
        throw new CliError("invalid_response", "Transcript page cannot advance")
      afterPosition = page.nextPosition
    }
    if (truncatedBy !== null) break
    nextTranscriptId = transcript.id
    if (moreTranscripts && items.length >= limits.cues) {
      hasMore = true
      truncatedBy = "cues"
      break
    }
  }
  checkMeetingCancelled(options.signal)
  const packet = {
    schemaVersion: 1 as const,
    kind: "meeting" as const,
    source: formatMeetingReference(parsed),
    limits: { ...limits, maxReadBytes, maxTranscriptPages },
    contentBytes,
    coverage: {
      provided,
      included: items.length,
      omitted: hasMore || skippedUnavailable > 0 ? null : provided - items.length,
      providedExact: !hasMore && skippedUnavailable === 0,
      hasMore,
      nextReference: hasMore ? nextReference : null,
      nextTranscriptId: hasMore ? nextTranscriptId : null,
      transcriptPages,
      skippedUnavailable,
      truncatedBy,
      input: "bounded-meeting-pages" as const,
      archiveCompleteness: "unknown" as const,
    },
    items,
  }
  return { ...packet, fingerprint: hash(packet) }
}
