import { CliError } from "@wirecat/cli-core"
import { createTaskService, type Task } from "@wirecat/cli-tasks"
import type { MessageStore, ProposedAction } from "../store/store.js"
import { taskAccount } from "./task-rules.js"

export type ProposalTaskStore = Pick<MessageStore, "proposedActions" | "tasks">

/** The source a proposal's task keeps: found again on a retry, so one proposal never makes two tasks. */
export const proposalSource = (id: string): string => `proposed-action:${id}`

/**
 * Approving a proposal makes it the owner's task in the account that would act; nothing is carried out.
 * The task comes first, so an approval that failed half-way finds the same task when it is run again.
 */
export const approveAsTask = async (
  store: ProposalTaskStore,
  id: string,
): Promise<{ proposal: ProposedAction; task: Task }> => {
  const proposal = await store.proposedActions.get(id)
  if (proposal.status !== "proposed")
    throw new CliError("validation_error", `a ${proposal.status} action cannot be approved`, {
      reason: "proposal_state",
    })
  if (proposal.account === null)
    throw new CliError("validation_error", "a proposal names the account that would act; this one names none")
  const { task } = await createTaskService({ store: store.tasks }).add({
    source: proposalSource(proposal.id),
    sourceKind: "proposed_action",
    account: taskAccount(proposal.account),
    group: proposal.kind,
    kind: "request",
    origin: "agent",
  })
  return { proposal: await store.proposedActions.approve(proposal.id, { task: task.id }), task }
}
