import { CliError } from "@wirecat/cli-core"
import type { Actor } from "./actors.js"
import { type Author, authorActor } from "./memories.js"
import type { StoreContext } from "./open.js"
import { thingOf } from "./things.js"

export const ACTION_TIERS = ["read", "draft", "write-private", "write-public", "destructive", "admin"] as const
export const ACTION_OUTCOMES = ["ok", "refused", "failed"] as const

/**
 * One tool call as the audit trail keeps it: who, which tool, at what tier, on what, how it ended. Never the
 * arguments or the answer: `error` is a short code, not a message that could quote them.
 */
export interface AgentActionInput {
  actor: Author
  tool: string
  tier: (typeof ACTION_TIERS)[number]
  /** A reference to what it acted on, when the caller knows one. */
  target?: string
  status: (typeof ACTION_OUTCOMES)[number]
  error?: string
  startedAt: number
  finishedAt: number
}

export interface AgentAction {
  id: string
  /** `name` is a bot's handle; `null` for a person. */
  actor: { type: Actor["type"]; id: string; name: string | null }
  tool: string
  tier: AgentActionInput["tier"]
  target: { type: string; id: string } | null
  status: AgentActionInput["status"]
  error: string | null
  startedAt: string
  finishedAt: string | null
}

export interface AgentActionsStore {
  record(input: AgentActionInput): Promise<AgentAction>
  /** Newest first; `agent` is a bot's name, such as `tg-mcp`. */
  list(options?: { tool?: string; agent?: string; limit?: number }): Promise<AgentAction[]>
}

const CODE = /^[a-z][a-z0-9_]{0,63}$/
const NAMED =
  "SELECT a.*, b.name AS actor_name FROM agent_actions a LEFT JOIN bots b ON a.actor_type = 'bot' AND b.id = a.actor_id"

export const agentActionsStoreOver = (context: StoreContext, afterRecord: () => void = () => {}): AgentActionsStore => {
  const { database, now } = context
  const actionOf = (row: Record<string, unknown>): AgentAction => ({
    id: String(row.id),
    actor: {
      type: row.actor_type as Actor["type"],
      id: String(row.actor_id),
      name: row.actor_name == null ? null : String(row.actor_name),
    },
    tool: String(row.tool),
    tier: row.tier as AgentAction["tier"],
    target: row.target_type == null ? null : { type: String(row.target_type), id: String(row.target_id) },
    status: row.status as AgentAction["status"],
    error: row.error == null ? null : String(row.error),
    startedAt: new Date(Number(row.started_at)).toISOString(),
    finishedAt: row.finished_at == null ? null : new Date(Number(row.finished_at)).toISOString(),
  })
  return {
    record: async (input) => {
      if (!ACTION_TIERS.includes(input.tier))
        throw new CliError("validation_error", `a tier is one of ${ACTION_TIERS.join(", ")}`)
      if (!ACTION_OUTCOMES.includes(input.status))
        throw new CliError("validation_error", `a status is one of ${ACTION_OUTCOMES.join(", ")}`)
      if (!/^[\w.:-]{1,100}$/.test(input.tool))
        throw new CliError("validation_error", "a tool's name is 1–100 word characters")
      const error = input.error === undefined ? null : CODE.test(input.error) ? input.error : "error"
      const target = input.target === undefined ? undefined : thingOf(database, input.target)
      const { actor } = authorActor(context, input.actor)
      const row = database
        .prepare(
          "INSERT INTO agent_actions (actor_type, actor_id, tool, tier, target_type, target_id, status, error, started_at, finished_at, created_at) " +
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id",
        )
        .get(
          actor.type,
          actor.id,
          input.tool,
          input.tier,
          target?.type ?? null,
          target?.id ?? null,
          input.status,
          error,
          input.startedAt,
          input.finishedAt,
          now(),
        )
      database.prepare("UPDATE bots SET last_seen_at = ? WHERE ? = 'bot' AND id = ?").run(now(), actor.type, actor.id)
      afterRecord()
      return actionOf(database.prepare(`${NAMED} WHERE a.id = ?`).get(Number(row?.id)) as Record<string, unknown>)
    },
    list: async ({ tool, agent, limit = 100 } = {}) =>
      database
        .prepare(
          `${NAMED} WHERE (? IS NULL OR a.tool = ?) AND (? IS NULL OR b.name = ?) ORDER BY a.started_at DESC, a.id DESC LIMIT ?`,
        )
        .all(tool ?? null, tool ?? null, agent ?? null, agent ?? null, Math.min(Math.max(limit, 1), 500))
        .map(actionOf),
  }
}
