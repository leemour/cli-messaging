import { CliError } from "@wirecat/cli-core"
import type { Stemmer, Stemmers } from "../../search/stem.js"
import { normalize } from "../normalize.js"
import { type Actor, botNamed, ownerPerson } from "./actors.js"
import { atomic } from "./atomic.js"
import { linkKind } from "./link-kinds.js"
import { CORPORA, corpusIndexState, drainCorpus, type NoteIndexState } from "./note-index.js"
import { requiredThing } from "./notes.js"
import type { StoreContext } from "./open.js"
import { stemmerCache } from "./stems.js"
import { referenceOfThing } from "./things.js"

export const MEMORY_KINDS = ["summary", "digest", "fact", "preference"] as const
export const MEMORY_STATUSES = ["proposed", "confirmed", "stale", "superseded"] as const
export const MEMORY_SCOPES = ["personal", "work"] as const

/** Who wrote it: the owner, or an agent by its bot handle and the model it ran on. */
export type Author = "owner" | { bot: string; model?: string }

export interface Memory {
  id: string
  ref: string
  kind: (typeof MEMORY_KINDS)[number]
  body: string
  /** What it is about, as a reference; `null` for a general fact. */
  subject: string | null
  author: { type: Actor["type"]; id: string }
  model: string | null
  confidence: number | null
  status: (typeof MEMORY_STATUSES)[number]
  scope: (typeof MEMORY_SCOPES)[number]
  supersedes: string | null
  /** The references it rests on: `links` of kind `evidence`. */
  evidence: string[]
  lastVerifiedAt: string | null
  createdAt: string
  updatedAt: string
}

export interface MemoryInput {
  kind: Memory["kind"]
  body: string
  /** Required, with no default: a memory read for the wrong purpose leaks, so its writer says which. */
  scope: Memory["scope"]
  /** At least one reference the memory rests on. */
  evidence: string[]
  author: Author
  subject?: string
  confidence?: number
  status?: "proposed" | "confirmed"
  /** The memory this one replaces; it becomes `superseded`. */
  supersedes?: string
}

export interface MemoriesStore {
  add(input: MemoryInput): Promise<Memory>
  get(reference: string): Promise<Memory>
  list(options?: {
    subject?: string
    kind?: Memory["kind"]
    status?: Memory["status"]
    scope?: Memory["scope"]
    limit?: number
  }): Promise<Memory[]>
  /** The owner stands behind it; its evidence was checked now. */
  confirm(reference: string): Promise<Memory>
  /** Its evidence no longer holds. */
  markStale(reference: string): Promise<Memory>
  /** Indexes what was written since, then finds memories holding every word or a longer one it starts, best first. */
  search(text: string, options?: { scope?: Memory["scope"]; limit?: number }): Promise<Memory[]>
  indexState(): Promise<NoteIndexState>
}

type Row = Record<string, unknown>
const iso = (value: unknown) => new Date(Number(value)).toISOString()

const oneOf = <T extends string>(value: unknown, allowed: readonly T[], what: string): T => {
  if (typeof value !== "string" || !allowed.includes(value as T))
    throw new CliError("validation_error", `${what} is one of ${allowed.join(", ")}`)
  return value as T
}

export const authorActor = (context: StoreContext, author: Author): { actor: Actor; model: string | null } => {
  if (author === "owner") return { actor: ownerPerson(context.database), model: null }
  return {
    actor: botNamed(context.database, author.bot, context.now(), "agent"),
    model: author.model === undefined ? null : author.model.trim().slice(0, 200) || null,
  }
}

/** Writes `evidence` links from a row to each reference, refusing one the store does not hold. */
export const linkEvidence = (
  context: StoreContext,
  from: { type: string; id: number },
  references: string[],
  author: "owner" | "agent",
) => {
  const at = context.now()
  const insert = context.database.prepare(
    "INSERT INTO links (from_type, from_id, to_type, to_id, kind, source, confirmed, created_at, author, updated_at) " +
      `VALUES (?, ?, ?, ?, ${linkKind("evidence")}, ?, 1, ?, ?, ?)`,
  )
  for (const reference of references) {
    const thing = requiredThing(context.database, reference, "the evidence")
    insert.run(from.type, from.id, thing.type, thing.id, author === "owner" ? "owner" : "suggested", at, author, at)
  }
}

export const evidenceOf = (context: StoreContext, from: { type: string; id: number }): string[] =>
  context.database
    .prepare(
      `SELECT to_type, to_id FROM links WHERE from_type = ? AND from_id = ? AND kind = ${linkKind("evidence")} AND to_id IS NOT NULL ORDER BY id`,
    )
    .all(from.type, from.id)
    .flatMap((row) => referenceOfThing(context.database, { type: String(row.to_type), id: Number(row.to_id) }) ?? [])

export const memoriesStoreOver = (context: StoreContext): MemoriesStore => {
  const { database, now } = context
  const stemmerFor: (stemmers: Stemmers) => Stemmer = stemmerCache()
  const memoryOf = (row: Row): Memory => ({
    id: String(row.id),
    ref: `memory:${row.id}`,
    kind: row.kind as Memory["kind"],
    body: String(row.body),
    subject:
      row.subject_type == null
        ? null
        : (referenceOfThing(database, { type: String(row.subject_type), id: Number(row.subject_id) }) ?? null),
    author: { type: row.author_type as Actor["type"], id: String(row.author_id) },
    model: row.model == null ? null : String(row.model),
    confidence: row.confidence == null ? null : Number(row.confidence),
    status: row.status as Memory["status"],
    scope: row.scope as Memory["scope"],
    supersedes: row.supersedes_id == null ? null : `memory:${row.supersedes_id}`,
    evidence: evidenceOf(context, { type: "memory", id: Number(row.id) }),
    lastVerifiedAt: row.last_verified_at == null ? null : iso(row.last_verified_at),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  })
  const rowOf = (reference: string): Row => {
    const thing = requiredThing(database, reference.includes(":") ? reference : `memory:${reference}`, "the memory")
    if (thing.type !== "memory") throw new CliError("validation_error", `${reference} is not a memory`)
    return database.prepare("SELECT * FROM memories WHERE id = ?").get(thing.id) as Row
  }
  const setStatus = (reference: string, status: Memory["status"], verified: boolean) => {
    const row = rowOf(reference)
    const at = now()
    database
      .prepare(`UPDATE memories SET status = ?, updated_at = ?${verified ? ", last_verified_at = ?" : ""} WHERE id = ?`)
      .run(...(verified ? [status, at, at, Number(row.id)] : [status, at, Number(row.id)]))
    return memoryOf(rowOf(reference))
  }

  return {
    add: async (input) => {
      const kind = oneOf(input.kind, MEMORY_KINDS, "a memory's kind")
      if (input.scope === undefined || input.scope === null)
        throw new CliError("validation_error", "a memory needs its scope — personal or work; there is no default", {
          reason: "memory_scope_required",
        })
      const scope = oneOf(input.scope, MEMORY_SCOPES, "a memory's scope")
      if (!Array.isArray(input.evidence) || input.evidence.length === 0)
        throw new CliError("validation_error", "a memory needs at least one piece of evidence it rests on", {
          reason: "memory_evidence_required",
        })
      const body = input.body?.trim() ?? ""
      if (!body || body.length > 20_000)
        throw new CliError("validation_error", "a memory's body takes 1–20000 characters")
      if (input.confidence !== undefined && !(input.confidence >= 0 && input.confidence <= 1))
        throw new CliError("validation_error", "confidence takes 0–1")
      const status = oneOf(input.status ?? "proposed", ["proposed", "confirmed"] as const, "a new memory's status")
      const id = atomic(database, () => {
        const { actor, model } = authorActor(context, input.author)
        const subject = input.subject === undefined ? undefined : requiredThing(database, input.subject, "the subject")
        const replaced = input.supersedes === undefined ? undefined : Number(rowOf(input.supersedes).id)
        const at = now()
        const made = Number(
          database
            .prepare(
              "INSERT INTO memories (kind, body, subject_type, subject_id, author_type, author_id, model, confidence, status, " +
                "last_verified_at, supersedes_id, scope, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id",
            )
            .get(
              kind,
              body,
              subject?.type ?? null,
              subject?.id ?? null,
              actor.type,
              actor.id,
              model,
              input.confidence ?? null,
              status,
              status === "confirmed" ? at : null,
              replaced ?? null,
              scope,
              at,
              at,
            )?.id,
        )
        linkEvidence(
          context,
          { type: "memory", id: made },
          input.evidence,
          input.author === "owner" ? "owner" : "agent",
        )
        if (replaced !== undefined)
          database.prepare("UPDATE memories SET status = 'superseded', updated_at = ? WHERE id = ?").run(at, replaced)
        return made
      })
      return memoryOf(rowOf(`memory:${id}`))
    },
    get: async (reference) => memoryOf(rowOf(reference)),
    list: async (options = {}) => {
      const subject = options.subject === undefined ? undefined : requiredThing(database, options.subject)
      return database
        .prepare(
          "SELECT * FROM memories WHERE (? IS NULL OR (subject_type = ? AND subject_id = ?)) AND (? IS NULL OR kind = ?) " +
            "AND (? IS NULL OR status = ?) AND (? IS NULL OR scope = ?) ORDER BY created_at DESC, id DESC LIMIT ?",
        )
        .all(
          subject?.type ?? null,
          subject?.type ?? null,
          subject?.id ?? null,
          options.kind ?? null,
          options.kind ?? null,
          options.status ?? null,
          options.status ?? null,
          options.scope ?? null,
          options.scope ?? null,
          Math.min(Math.max(options.limit ?? 100, 1), 500),
        )
        .map(memoryOf)
    },
    confirm: async (reference) => setStatus(reference, "confirmed", true),
    markStale: async (reference) => setStatus(reference, "stale", false),
    search: async (text, { scope, limit = 20 } = {}) => {
      drainCorpus(database, CORPORA.memory, stemmerFor)
      const words = normalize(text)
        .split(/\s+/)
        .filter((word) => /[\p{L}\p{N}]/u.test(word))
      if (words.length === 0) throw new CliError("validation_error", "say what to find in the memories")
      const match = `normalized_text : (${words.map((word) => `"${word.replaceAll('"', '""')}"*`).join(" AND ")})`
      return database
        .prepare(
          "SELECT m.* FROM memory_words w JOIN memories m ON m.id = w.rowid WHERE memory_words MATCH ? " +
            "AND (? IS NULL OR m.scope = ?) ORDER BY bm25(memory_words), m.id LIMIT ?",
        )
        .all(match, scope ?? null, scope ?? null, Math.min(Math.max(limit, 1), 200))
        .map(memoryOf)
    },
    indexState: async () => corpusIndexState(database, CORPORA.memory),
  }
}
