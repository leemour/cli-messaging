import { CliError } from "@wirecat/cli-core"
import type { Actor } from "./actors.js"
import { atomic } from "./atomic.js"
import { linkKind } from "./link-kinds.js"
import { type Author, authorActor, evidenceOf, linkEvidence } from "./memories.js"
import { requiredThing } from "./notes.js"
import type { StoreContext } from "./open.js"

export const DECISION_STATUSES = ["proposed", "accepted", "superseded", "reversed"] as const

/** A choice that holds until replaced; its evidence is `links` of kind `evidence`. */
export interface Decision {
  id: string
  ref: string
  statement: string
  status: (typeof DECISION_STATUSES)[number]
  project: string | null
  decidedAt: string | null
  supersedes: string | null
  confirmedBy: { type: Actor["type"]; id: string } | null
  source: string
  evidence: string[]
  createdAt: string
  updatedAt: string
}

export interface DecisionInput {
  statement: string
  /** Who records it: the owner's is accepted at once, an agent's waits as proposed. */
  by: Author
  project?: string
  /** When it was made, as the evidence shows (ISO). */
  decidedAt?: string
  evidence?: string[]
  /** The decision this one replaces; it becomes `superseded` once this one is accepted. */
  supersedes?: string
  /** The memory an agent drew it from: a `created-from` link. */
  createdFrom?: string
}

export interface DecisionsStore {
  add(input: DecisionInput): Promise<Decision>
  get(reference: string): Promise<Decision>
  list(options?: { project?: string; status?: Decision["status"]; limit?: number }): Promise<Decision[]>
  /** The owner accepts a proposed decision; the one it supersedes stops holding. */
  accept(reference: string): Promise<Decision>
  /** The decision no longer holds and nothing replaced it. */
  reverse(reference: string): Promise<Decision>
}

type Row = Record<string, unknown>
const iso = (value: unknown) => new Date(Number(value)).toISOString()

export const decisionsStoreOver = (context: StoreContext): DecisionsStore => {
  const { database, now } = context
  const decisionOf = (row: Row): Decision => ({
    id: String(row.id),
    ref: `decision:${row.id}`,
    statement: String(row.statement),
    status: row.status as Decision["status"],
    project: row.project_id == null ? null : `project:${row.project_id}`,
    decidedAt: row.decided_at == null ? null : iso(row.decided_at),
    supersedes: row.supersedes_id == null ? null : `decision:${row.supersedes_id}`,
    confirmedBy:
      row.confirmed_by_type == null
        ? null
        : { type: row.confirmed_by_type as Actor["type"], id: String(row.confirmed_by_id) },
    source: String(row.source),
    evidence: evidenceOf(context, { type: "decision", id: Number(row.id) }),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  })
  const rowOf = (reference: string): Row => {
    const thing = requiredThing(database, reference.includes(":") ? reference : `decision:${reference}`, "the decision")
    if (thing.type !== "decision") throw new CliError("validation_error", `${reference} is not a decision`)
    return database.prepare("SELECT * FROM decisions WHERE id = ?").get(thing.id) as Row
  }
  const accept = (id: number) => {
    const row = database.prepare("SELECT * FROM decisions WHERE id = ?").get(id) as Row
    if (row.status !== "proposed" && row.status !== "accepted")
      throw new CliError("validation_error", `a ${String(row.status)} decision cannot be accepted`)
    const { actor } = authorActor(context, "owner")
    const at = now()
    database
      .prepare(
        "UPDATE decisions SET status = 'accepted', confirmed_by_type = ?, confirmed_by_id = ?, updated_at = ? WHERE id = ?",
      )
      .run(actor.type, actor.id, at, id)
    if (row.supersedes_id != null)
      database
        .prepare("UPDATE decisions SET status = 'superseded', updated_at = ? WHERE id = ? AND status = 'accepted'")
        .run(at, Number(row.supersedes_id))
  }

  return {
    add: async (input) => {
      const statement = input.statement?.trim() ?? ""
      if (!statement || statement.length > 2000)
        throw new CliError("validation_error", "a decision's statement takes 1–2000 characters")
      const decidedAt = input.decidedAt === undefined ? null : Date.parse(input.decidedAt)
      if (decidedAt !== null && !Number.isFinite(decidedAt))
        throw new CliError("validation_error", "decidedAt takes an ISO timestamp")
      const id = atomic(database, () => {
        const project = input.project === undefined ? undefined : requiredThing(database, input.project, "the project")
        if (project && project.type !== "project")
          throw new CliError("validation_error", `${input.project} is not a project`)
        const replaced = input.supersedes === undefined ? undefined : Number(rowOf(input.supersedes).id)
        const owner = input.by === "owner"
        const at = now()
        const made = Number(
          database
            .prepare(
              "INSERT INTO decisions (project_id, statement, status, decided_at, supersedes_id, source, created_at, updated_at) " +
                "VALUES (?, ?, 'proposed', ?, ?, ?, ?, ?) RETURNING id",
            )
            .get(project?.id ?? null, statement, decidedAt, replaced ?? null, owner ? "owner" : "agent", at, at)?.id,
        )
        linkEvidence(context, { type: "decision", id: made }, input.evidence ?? [], owner ? "owner" : "agent")
        if (input.createdFrom !== undefined) {
          const from = requiredThing(database, input.createdFrom, "the source")
          database
            .prepare(
              "INSERT INTO links (from_type, from_id, to_type, to_id, kind, source, confirmed, created_at, author, updated_at) " +
                `VALUES ('decision', ?, ?, ?, ${linkKind("created-from")}, 'suggested', 1, ?, 'agent', ?)`,
            )
            .run(made, from.type, from.id, at, at)
        }
        if (owner) accept(made)
        return made
      })
      return decisionOf(rowOf(`decision:${id}`))
    },
    get: async (reference) => decisionOf(rowOf(reference)),
    list: async (options = {}) => {
      const project =
        options.project === undefined ? undefined : requiredThing(database, options.project, "the project")
      return database
        .prepare(
          "SELECT * FROM decisions WHERE deleted_at IS NULL AND (? IS NULL OR project_id = ?) AND (? IS NULL OR status = ?) " +
            "ORDER BY coalesce(decided_at, created_at) DESC, id DESC LIMIT ?",
        )
        .all(
          project?.id ?? null,
          project?.id ?? null,
          options.status ?? null,
          options.status ?? null,
          Math.min(Math.max(options.limit ?? 100, 1), 500),
        )
        .map(decisionOf)
    },
    accept: async (reference) => {
      const id = Number(rowOf(reference).id)
      atomic(database, () => accept(id))
      return decisionOf(rowOf(reference))
    },
    reverse: async (reference) => {
      const row = rowOf(reference)
      if (row.status !== "accepted") throw new CliError("validation_error", "only an accepted decision can be reversed")
      database
        .prepare("UPDATE decisions SET status = 'reversed', updated_at = ? WHERE id = ?")
        .run(now(), Number(row.id))
      return decisionOf(rowOf(reference))
    },
  }
}
