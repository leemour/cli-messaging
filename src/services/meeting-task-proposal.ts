import { createHash } from "node:crypto"
import { CliError } from "@wirecat/cli-core"
import { TASK_KINDS, type TaskKind } from "@wirecat/cli-tasks"
import { formatMeetingReference } from "../domain/meeting-reference.js"
import { type MeetingReadStore, resolveMeetingReference } from "./meeting-reference.js"

export interface MeetingTaskProposal {
  id: string
  source: string
  sourceKind: "meeting"
  group: string
  accountId: number
  kind: TaskKind
  preview: string | null
  revision: "current" | "superseded" | null
  applied: false
  persistence: "proposal-only"
}
/** Constructs inspectable provenance; never adds tasks, messages, memories or decisions. */
export const proposeMeetingTask = async (
  store: MeetingReadStore,
  accountId: number,
  reference: string,
  kind: TaskKind,
): Promise<MeetingTaskProposal> => {
  if (!(TASK_KINDS as readonly string[]).includes(kind)) throw new CliError("validation_error", "unknown task kind")
  const resolved = await resolveMeetingReference(store, accountId, reference)
  return {
    id: createHash("sha256")
      .update(JSON.stringify({ source: resolved.reference, kind }))
      .digest("hex"),
    source: resolved.reference,
    sourceKind: "meeting",
    group: formatMeetingReference({ type: "meeting", accountId, meetingId: resolved.meeting.id }),
    accountId,
    kind,
    preview: resolved.cue?.text.slice(0, 200) ?? resolved.meeting.title?.slice(0, 200) ?? null,
    revision: resolved.revision,
    applied: false,
    persistence: "proposal-only",
  }
}
