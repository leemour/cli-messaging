import { CliError } from "@wirecat/cli-core"
import {
  createMeetingContext,
  type MeetingContextChange,
  type MeetingMutationOptions,
  snapshotMeetingScope,
  validateMeetingContextChange,
} from "@wirecat/cli-meetings"
import { formatMeetingReference, parseMeetingReference } from "../domain/meeting-reference.js"
import type { AccountKey, MessageStore } from "../store/store.js"
import { resolveMeetingReference } from "./meeting-reference.js"

export type MeetingContextServiceStore = Pick<
  MessageStore,
  "storedAccount" | "meetings" | "notes" | "knowledge" | "memories"
>

const checkCancelled = (signal?: AbortSignal): void => {
  if (!signal?.aborted) return
  if (signal.reason instanceof CliError) throw signal.reason
  const timeout = signal.reason instanceof Error && signal.reason.name === "TimeoutError"
  throw new CliError(timeout ? "timeout" : "cancelled", "meeting context was interrupted")
}

/** Reuses the owner's records; scoped meeting references are checked again by each native write. */
export const createMeetingContextService = async (
  store: MeetingContextServiceStore,
  input: AccountKey,
  options: { now?: () => number } = {},
) => {
  const now = options.now ?? Date.now
  const scope = snapshotMeetingScope(input)
  const key: AccountKey = Object.freeze({ ...scope, ...(input.scope === undefined ? {} : { scope: input.scope }) })
  const account = await store.storedAccount(key)
  if (
    account.provider !== key.provider ||
    account.account !== key.account ||
    (key.scope !== undefined && account.scope !== key.scope)
  )
    throw new CliError("not_found", "the meeting context account is unavailable")
  const accountId = account.id
  const root = (meetingId: number) => formatMeetingReference({ type: "meeting", accountId, meetingId })
  const check = async (meetingId: number, change: Readonly<MeetingContextChange>, signal?: AbortSignal) => {
    checkCancelled(signal)
    await resolveMeetingReference(store.meetings, accountId, root(meetingId), { signal })
    if (change.action === "memory.add") {
      for (const reference of [...change.evidence, ...(change.subject === undefined ? [] : [change.subject])]) {
        const parsed = parseMeetingReference(reference)
        if (parsed.accountId !== accountId || parsed.meetingId !== meetingId)
          throw new CliError("not_found", "memory evidence must belong to this meeting and account")
        await resolveMeetingReference(store.meetings, accountId, reference, { signal })
      }
    }
    checkCancelled(signal)
  }
  const context = createMeetingContext(scope, accountId, {
    actions: ["note.add", "tags.add", "tags.remove", "memory.add", "event.link", "person.link"],
    async apply(meetingId, change, operation) {
      await check(meetingId, change, operation.signal)
      const reference = root(meetingId)
      const target = { type: "meeting" as const, id: String(meetingId) }
      switch (change.action) {
        case "note.add":
          return store.notes.addNote({
            text: change.text,
            ...(change.title === undefined ? {} : { title: change.title }),
            about: [reference],
          })
        case "tags.add":
          return store.knowledge.addTags(key, target, [...change.tags])
        case "tags.remove":
          return store.knowledge.removeTags(key, target, [...change.tags])
        case "memory.add":
          return store.memories.add({
            body: change.body,
            kind: change.kind,
            scope: change.scope,
            evidence: change.evidence.map((value) => formatMeetingReference(parseMeetingReference(value))),
            subject:
              change.subject === undefined ? reference : formatMeetingReference(parseMeetingReference(change.subject)),
            status: "confirmed",
            author: "owner",
          })
        case "event.link":
          return store.meetings.linkMeetingEvent({
            accountId,
            meetingId,
            eventId: change.eventId,
            now: now(),
            ...(change.expectedEventId === undefined ? {} : { expectedEventId: change.expectedEventId }),
            ...(operation.signal ? { signal: operation.signal } : {}),
          })
        case "person.link":
          return store.meetings.linkParticipantPerson({
            accountId,
            meetingId,
            participantId: change.participantId,
            personUid: change.personUid,
            now: now(),
            author: "owner",
            ...(change.expectedPersonUid === undefined ? {} : { expectedPersonUid: change.expectedPersonUid }),
            ...(change.targetAccountIds === undefined ? {} : { targetAccountIds: change.targetAccountIds }),
            ...(operation.signal ? { signal: operation.signal } : {}),
          })
      }
    },
  })
  return {
    scope: context.scope,
    accountId,
    actions: context.actions,
    async change(meetingId: number, inputChange: MeetingContextChange, options: MeetingMutationOptions = {}) {
      const change = validateMeetingContextChange(inputChange)
      const mutation = { apply: options.apply, dryRun: options.dryRun, signal: options.signal }
      await check(meetingId, change, mutation.signal)
      return context.change(meetingId, change, mutation)
    },
  }
}

export type MeetingContextService = Awaited<ReturnType<typeof createMeetingContextService>>
