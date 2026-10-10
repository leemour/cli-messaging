import { CliError } from "@wirecat/cli-core"
import {
  createTaskService,
  TASK_KINDS,
  TASK_ORIGINS,
  type Task,
  type TaskKind,
  type TaskOrigin,
} from "@wirecat/cli-tasks"
import { canonicalMeetingReference, formatMeetingReference } from "../domain/meeting-reference.js"
import type { AccountKey, MessageStore } from "../store/store.js"
import { resolveMeetingReference } from "./meeting-reference.js"
import { taskAccount } from "./task-rules.js"

export type MeetingTaskStore = Pick<MessageStore, "storedAccount" | "meetings" | "tasks">
export interface CreateMeetingTaskInput {
  source: string
  kind: TaskKind
  origin: TaskOrigin
  dueAt?: Date
}
export interface MeetingTaskSourceView {
  reference: string
  meetingId: number
  transcriptId: number | null
  cuePosition: number | null
  revision: "current" | "superseded" | null
  preview: string | null
}
export interface MeetingTaskView {
  task: Task
  source: MeetingTaskSourceView | null
  state: "available" | "unavailable"
}

const accountSnapshot = (key: AccountKey): AccountKey => {
  const { provider, account, scope } = key
  if (!provider.trim() || provider.includes(":") || !account.trim())
    throw new CliError("validation_error", "a meeting task requires a provider and account")
  return { provider, account, ...(scope ? { scope } : {}) }
}
const authorizedAccount = async (store: MeetingTaskStore, key: AccountKey): Promise<number> => {
  const account = await store.storedAccount(key)
  if (
    account.provider !== key.provider ||
    account.account !== key.account ||
    (key.scope !== undefined && account.scope !== key.scope)
  )
    throw new CliError("not_found", "the meeting task account is unavailable")
  if (!Number.isSafeInteger(account.id) || account.id < 1)
    throw new CliError("invalid_response", "the stored account has an invalid numeric ID")
  return account.id
}

/** Explicit local write only: never invoked by evidence reads or proposal generation. */
export const createTaskFromMeeting = async (
  store: MeetingTaskStore,
  account: AccountKey,
  input: CreateMeetingTaskInput,
): Promise<{ task: Task; created: boolean }> => {
  const key = accountSnapshot(account)
  const { source: rawSource, kind, origin, dueAt: rawDueAt } = input
  if (
    !(TASK_KINDS as readonly string[]).includes(kind) ||
    !(TASK_ORIGINS as readonly string[]).includes(origin) ||
    (rawDueAt !== undefined && (!(rawDueAt instanceof Date) || !Number.isFinite(rawDueAt.getTime())))
  )
    throw new CliError("validation_error", "a meeting task requires a valid kind, origin and optional due date")
  const source = canonicalMeetingReference(rawSource)
  const dueAt = rawDueAt === undefined ? undefined : new Date(rawDueAt.getTime())
  const accountId = await authorizedAccount(store, key)
  const resolved = await resolveMeetingReference(store.meetings, accountId, source)
  return createTaskService({ store: store.tasks }).add({
    source,
    sourceKind: "meeting",
    account: taskAccount(key),
    group: formatMeetingReference({ type: "meeting", accountId, meetingId: resolved.meeting.id }),
    kind,
    origin,
    ...(dueAt ? { dueAt } : {}),
  })
}

/** Resolves source text on demand; task records retain references, never transcript text. */
export const readMeetingTask = async (
  store: MeetingTaskStore,
  account: AccountKey,
  id: string,
): Promise<MeetingTaskView> => {
  const key = accountSnapshot(account)
  const task = await store.tasks.get(id)
  if (!task || task.account !== taskAccount(key))
    throw new CliError("not_found", "the task is unavailable for this account")
  if (task.sourceKind !== "meeting") throw new CliError("validation_error", "the task does not refer to a meeting")
  const accountId = await authorizedAccount(store, key)
  try {
    const resolved = await resolveMeetingReference(store.meetings, accountId, task.source)
    return {
      task,
      state: "available",
      source: {
        reference: resolved.reference,
        meetingId: resolved.meeting.id,
        transcriptId: resolved.transcript?.id ?? null,
        cuePosition: resolved.cue?.position ?? null,
        revision: resolved.revision,
        preview: resolved.cue?.text.slice(0, 200) ?? resolved.meeting.title?.slice(0, 200) ?? null,
      },
    }
  } catch (error) {
    if (error instanceof CliError && error.code === "not_found") return { task, source: null, state: "unavailable" }
    throw error
  }
}
