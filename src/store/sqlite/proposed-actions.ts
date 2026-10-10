import { CliError } from "@wirecat/cli-core"
import type { AccountKey } from "../store.js"
import type { Actor } from "./actors.js"
import { atomic } from "./atomic.js"
import { type Author, authorActor } from "./memories.js"
import { requiredThing } from "./notes.js"
import type { StoreContext } from "./open.js"
import { referenceOfThing, storedThing } from "./things.js"

export const PROPOSAL_STATUSES = ["proposed", "approved", "rejected", "executed", "failed"] as const
export const PROPOSAL_VERDICTS = ["useful", "not_useful"] as const

/**
 * Something an agent wants done outside the store, waiting for a person. The store only keeps the
 * decision: a messenger adapter executes an approved action and reports back with `executed` or `failed`.
 * `payload` may hold a reply's text — the one place outgoing text waits — so it is shown to the approver
 * and never copied into the agent log.
 */
export interface ProposedAction {
  id: string
  kind: string
  account: AccountKey | null
  target: string | null
  payload: unknown
  reason: string | null
  status: (typeof PROPOSAL_STATUSES)[number]
  proposedBy: { type: Actor["type"]; id: string }
  decidedBy: { type: Actor["type"]; id: string } | null
  decidedAt: string | null
  executedAt: string | null
  result: unknown
  error: string | null
  verdict: (typeof PROPOSAL_VERDICTS)[number] | null
  createdAt: string
}

export interface ProposalInput {
  kind: string
  by: Author
  account?: AccountKey
  target?: string
  payload?: unknown
  reason?: string
}

export interface ProposedActionsStore {
  propose(input: ProposalInput): Promise<ProposedAction>
  get(id: string): Promise<ProposedAction>
  /** What waits for a decision, oldest first. */
  pending(options?: { limit?: number }): Promise<ProposedAction[]>
  approve(id: string): Promise<ProposedAction>
  reject(id: string): Promise<ProposedAction>
  /** An approved action the adapter carried out, with what the provider answered. */
  executed(id: string, result?: unknown): Promise<ProposedAction>
  failed(id: string, error: string): Promise<ProposedAction>
  judge(id: string, verdict: ProposedAction["verdict"]): Promise<ProposedAction>
}

type Row = Record<string, unknown>
const iso = (value: unknown) => (value == null ? null : new Date(Number(value)).toISOString())
const json = (value: unknown) => (value == null ? null : JSON.parse(String(value)))

export const proposedActionsStoreOver = (context: StoreContext): ProposedActionsStore => {
  const { database, now } = context
  const actionOf = (row: Row): ProposedAction => {
    const account =
      row.account_id == null
        ? undefined
        : database.prepare("SELECT provider, external_id FROM accounts WHERE id = ?").get(Number(row.account_id))
    return {
      id: String(row.id),
      kind: String(row.kind),
      account: account ? { provider: String(account.provider), account: String(account.external_id) } : null,
      target:
        row.target_type == null
          ? null
          : (referenceOfThing(database, storedThing(row.target_type, row.target_id)) ?? null),
      payload: json(row.payload),
      reason: row.reason == null ? null : String(row.reason),
      status: row.status as ProposedAction["status"],
      proposedBy: { type: row.proposed_by_type as Actor["type"], id: String(row.proposed_by_id) },
      decidedBy:
        row.decided_by_type == null
          ? null
          : { type: row.decided_by_type as Actor["type"], id: String(row.decided_by_id) },
      decidedAt: iso(row.decided_at),
      executedAt: iso(row.executed_at),
      result: json(row.result),
      error: row.error == null ? null : String(row.error),
      verdict: (row.verdict ?? null) as ProposedAction["verdict"],
      createdAt: iso(row.created_at) as string,
    }
  }
  const rowOf = (id: string): Row => {
    const row = /^\d+$/.test(id)
      ? database.prepare("SELECT * FROM proposed_actions WHERE id = ?").get(Number(id))
      : undefined
    if (!row) throw new CliError("not_found", `no proposed action ${id}`)
    return row
  }
  /** Moves an action from one of `from` to `to`, or says why it cannot. */
  const move = (
    id: string,
    from: ProposedAction["status"][],
    to: ProposedAction["status"],
    set = "",
    values: unknown[] = [],
  ) =>
    atomic(database, () => {
      const row = rowOf(id)
      if (!from.includes(row.status as ProposedAction["status"]))
        throw new CliError("validation_error", `a ${String(row.status)} action cannot become ${to}`, {
          reason: "proposal_state",
        })
      database
        .prepare(`UPDATE proposed_actions SET status = ?, updated_at = ?${set} WHERE id = ?`)
        .run(to, now(), ...(values as (string | number | null)[]), Number(id))
      return actionOf(rowOf(id))
    })
  const decide = (id: string, to: "approved" | "rejected") => {
    const { actor } = authorActor(context, "owner")
    return move(id, ["proposed"], to, ", decided_by_type = ?, decided_by_id = ?, decided_at = ?", [
      actor.type,
      actor.id,
      now(),
    ])
  }

  return {
    propose: async ({ kind, by, account, target, payload, reason }) => {
      if (!/^[a-z][a-z_]{0,39}$/.test(kind))
        throw new CliError("validation_error", "an action's kind is a lower-case word, e.g. reply, ban, create_task")
      if (reason !== undefined && reason.length > 2000)
        throw new CliError("validation_error", "a reason takes up to 2000 characters")
      const encoded = payload === undefined ? null : JSON.stringify(payload)
      if (encoded !== null && encoded.length > 100_000)
        throw new CliError("validation_error", "a payload takes up to 100000 characters")
      const id = atomic(database, () => {
        const accountId =
          account === undefined
            ? null
            : database
                .prepare("SELECT id FROM accounts WHERE provider = ? AND external_id = ?")
                .get(account.provider, account.account)?.id
        if (account !== undefined && accountId == null)
          throw new CliError("not_found", "the account is not in the local store")
        const thing = target === undefined ? undefined : requiredThing(database, target)
        const { actor } = authorActor(context, by)
        const at = now()
        return Number(
          database
            .prepare(
              "INSERT INTO proposed_actions (kind, account_id, target_type, target_id, payload, reason, status, proposed_by_type, " +
                "proposed_by_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'proposed', ?, ?, ?, ?) RETURNING id",
            )
            .get(
              kind,
              (accountId as number | null) ?? null,
              thing?.type ?? null,
              thing?.id ?? null,
              encoded,
              reason?.trim() || null,
              actor.type,
              actor.id,
              at,
              at,
            )?.id,
        )
      })
      return actionOf(rowOf(String(id)))
    },
    get: async (id) => actionOf(rowOf(id)),
    pending: async ({ limit = 100 } = {}) =>
      database
        .prepare("SELECT * FROM proposed_actions WHERE status = 'proposed' ORDER BY created_at, id LIMIT ?")
        .all(Math.min(Math.max(limit, 1), 500))
        .map(actionOf),
    approve: async (id) => decide(id, "approved"),
    reject: async (id) => decide(id, "rejected"),
    executed: async (id, result) =>
      move(id, ["approved"], "executed", ", executed_at = ?, result = ?", [
        now(),
        result === undefined ? null : JSON.stringify(result),
      ]),
    failed: async (id, error) =>
      move(id, ["approved"], "failed", ", executed_at = ?, error = ?", [
        now(),
        error.trim().slice(0, 2000) || "failed",
      ]),
    judge: async (id, verdict) => {
      if (verdict !== null && !PROPOSAL_VERDICTS.includes(verdict))
        throw new CliError("validation_error", `a verdict is one of ${PROPOSAL_VERDICTS.join(", ")}`)
      rowOf(id)
      database
        .prepare("UPDATE proposed_actions SET verdict = ?, updated_at = ? WHERE id = ?")
        .run(verdict, now(), Number(id))
      return actionOf(rowOf(id))
    },
  }
}
