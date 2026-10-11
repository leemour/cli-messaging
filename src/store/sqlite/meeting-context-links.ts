import { CliError } from "@wirecat/cli-core"
import type { MeetingContextStore, ParticipantPersonInput } from "@wirecat/cli-meetings"
import { checkMeetingCancelled, meetingWriteSnapshot } from "./meeting-operation.js"
import { meetingReadSnapshot, positiveReadInteger } from "./meeting-reads.js"
import type { StoreContext } from "./open.js"
import { linkIdentityToPerson } from "./person-links.js"

const missing = (): never => {
  throw new CliError("not_found", "Meeting, participant or selected target not found")
}
const conflict = (): never => {
  throw new CliError("configuration_error", "Meeting association changed after it was reviewed")
}
const scope = (input: { accountId: number; meetingId: number; signal?: AbortSignal }): void => {
  checkMeetingCancelled(input.signal)
  positiveReadInteger(input.accountId, "accountId")
  positiveReadInteger(input.meetingId, "meetingId")
}
const now = (value: number): void => {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new CliError("validation_error", "Association clock must be an epoch millisecond timestamp")
}
const person = (value: string): number => {
  if (typeof value !== "string" || !/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value)))
    throw new CliError("validation_error", "personUid must be a canonical person UID")
  return Number(value)
}
export function meetingContextLinksOver(context: StoreContext): MeetingContextStore {
  const { database } = context
  const participant = (input: ParticipantPersonInput): { identityId: number; personUid: string | null } => {
    const row = database
      .prepare(
        "SELECT p.identity_id,l.person_id FROM meeting_participants p JOIN meetings m ON m.id=p.meeting_id LEFT JOIN identity_links l ON l.identity_id=p.identity_id WHERE p.id=? AND p.meeting_id=? AND m.account_id=? AND m.deleted_at IS NULL",
      )
      .get(input.participantId, input.meetingId, input.accountId)
    if (!row) return missing()
    return { identityId: Number(row.identity_id), personUid: row.person_id == null ? null : String(row.person_id) }
  }
  return {
    async linkMeetingEvent(original) {
      const input = { ...original }
      scope(input)
      now(input.now)
      if (input.eventId !== null) positiveReadInteger(input.eventId, "eventId")
      if (input.expectedEventId !== undefined && input.expectedEventId !== null)
        positiveReadInteger(input.expectedEventId, "expectedEventId")
      return meetingWriteSnapshot(database, () => {
        checkMeetingCancelled(input.signal)
        const row = database
          .prepare("SELECT event_id FROM meetings WHERE id=? AND account_id=? AND deleted_at IS NULL")
          .get(input.meetingId, input.accountId)
        if (!row) return missing()
        const previousEventId = row.event_id == null ? null : Number(row.event_id)
        if (input.expectedEventId !== undefined && input.expectedEventId !== previousEventId) return conflict()
        if (
          input.eventId !== null &&
          !database.prepare("SELECT 1 FROM events WHERE id=? AND deleted_at IS NULL").get(input.eventId)
        )
          return missing()
        const changed = previousEventId !== input.eventId
        if (changed)
          database
            .prepare("UPDATE meetings SET event_id=?,updated_at=? WHERE id=? AND account_id=?")
            .run(input.eventId, input.now, input.meetingId, input.accountId)
        checkMeetingCancelled(input.signal)
        return { meetingId: input.meetingId, eventId: input.eventId, previousEventId, changed }
      })
    },
    async participantPerson(original) {
      const input = { ...original }
      scope(input)
      positiveReadInteger(input.participantId, "participantId")
      if (input.maxReadBytes !== undefined) positiveReadInteger(input.maxReadBytes, "maxReadBytes")
      return meetingReadSnapshot(database, () => {
        const found = participant(input)
        checkMeetingCancelled(input.signal)
        if (input.maxReadBytes !== undefined && Buffer.byteLength(found.personUid ?? "") > input.maxReadBytes)
          throw new CliError("validation_error", "Participant person read exceeds its byte budget")
        return { meetingId: input.meetingId, participantId: input.participantId, personUid: found.personUid }
      })
    },
    async linkParticipantPerson(original) {
      if (original.targetAccountIds !== undefined && !Array.isArray(original.targetAccountIds))
        throw new CliError("validation_error", "Target account selection must be an array")
      const input = {
        ...original,
        targetAccountIds: original.targetAccountIds ? [...original.targetAccountIds] : [original.accountId],
      }
      scope(input)
      positiveReadInteger(input.participantId, "participantId")
      now(input.now)
      const target = person(input.personUid)
      if (input.expectedPersonUid !== undefined && input.expectedPersonUid !== null) person(input.expectedPersonUid)
      if (input.author !== "owner" && input.author !== "agent")
        throw new CliError("validation_error", "Association author must be owner or agent")
      if (input.maxReadBytes !== undefined) positiveReadInteger(input.maxReadBytes, "maxReadBytes")
      if (
        !Array.isArray(input.targetAccountIds) ||
        input.targetAccountIds.length < 1 ||
        input.targetAccountIds.length > 1000
      )
        throw new CliError("validation_error", "Target account selection must contain 1 through 1000 accounts")
      for (const id of input.targetAccountIds) positiveReadInteger(id, "targetAccountId")
      return meetingWriteSnapshot(database, () => {
        checkMeetingCancelled(input.signal)
        const found = participant(input)
        if (input.expectedPersonUid !== undefined && input.expectedPersonUid !== found.personUid) return conflict()
        const selected = [...new Set(input.targetAccountIds)]
        for (const id of selected) if (!database.prepare("SELECT 1 FROM accounts WHERE id=?").get(id)) return missing()
        if (
          !database
            .prepare(
              "SELECT 1 FROM identity_links l JOIN account_identities a ON a.identity_id=l.identity_id WHERE l.person_id=? AND a.account_id IN (SELECT value FROM json_each(?)) LIMIT 1",
            )
            .get(target, JSON.stringify(selected))
        )
          return missing()
        const changed = found.personUid !== input.personUid
        if (changed)
          linkIdentityToPerson({ ...context, now: () => input.now }, found.identityId, target, {
            method: "manual",
            by: input.author,
          })
        database
          .prepare(
            "INSERT INTO account_identities(account_id,identity_id,created_at,updated_at) VALUES(?,?,?,?) ON CONFLICT(account_id,identity_id) DO NOTHING",
          )
          .run(input.accountId, found.identityId, input.now, input.now)
        checkMeetingCancelled(input.signal)
        return {
          meetingId: input.meetingId,
          participantId: input.participantId,
          personUid: input.personUid,
          previousPersonUid: found.personUid,
          changed,
        }
      })
    },
  }
}
