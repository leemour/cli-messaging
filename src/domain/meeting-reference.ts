import { CliError } from "@wirecat/cli-core"

/** Durable within this store: a cue belongs to one retained transcript revision. */
export interface MeetingReference {
  type: "meeting"
  accountId: number
  meetingId: number
  transcriptId?: number
  cuePosition?: number
}

const invalid = () =>
  new CliError(
    "validation_error",
    "expected meeting:<accountId>/<meetingId>[/<transcriptId>[/<cuePosition>]] with safe integer IDs",
  )
const integer = (value: number, minimum = 1): number => {
  if (!Number.isSafeInteger(value) || value < minimum) throw invalid()
  return value
}

export const formatMeetingReference = (reference: MeetingReference): string => {
  const parts = [integer(reference.accountId), integer(reference.meetingId)]
  if (reference.transcriptId !== undefined) parts.push(integer(reference.transcriptId))
  if (reference.cuePosition !== undefined) {
    if (reference.transcriptId === undefined) throw invalid()
    parts.push(integer(reference.cuePosition, 0))
  }
  return `meeting:${parts.join("/")}`
}

export const parseMeetingReference = (text: string): MeetingReference => {
  const value = text.trim()
  if (!value.startsWith("meeting:")) throw invalid()
  const parts = value.slice(8).split("/")
  if (parts.length < 2 || parts.length > 4 || parts.some((part) => !/^\d+$/.test(part))) throw invalid()
  const ids = parts.map(Number)
  const reference: MeetingReference = {
    type: "meeting",
    accountId: integer(ids[0] as number),
    meetingId: integer(ids[1] as number),
    ...(ids.length > 2 ? { transcriptId: integer(ids[2] as number) } : {}),
    ...(ids.length > 3 ? { cuePosition: integer(ids[3] as number, 0) } : {}),
  }
  return reference
}

export const canonicalMeetingReference = (text: string): string => formatMeetingReference(parseMeetingReference(text))
