import { CliError } from "@wirecat/cli-core"
import { tagOf } from "../../domain/tags.js"
import {
  type Automaton,
  compileAutomaton,
  foldRegex,
  type MatchBudget,
  wildcardPattern,
} from "../../search/lucene/automaton.js"
import type { ResolvedNode, ResolvedPredicate } from "../../search/lucene/resolved.js"
import { isStemmed } from "../../search/lucene/resolved.js"
import { exhausted, QUERY_LIMITS, queryError } from "../../search/lucene/types.js"
import type { Stemmer } from "../../search/stem.js"
import type { SqlValue } from "../driver.js"
import { normalize } from "../normalize.js"
import { linkKind } from "./link-kinds.js"
import { prefixOf } from "./lucene.js"
import { drainNoteIndex, type NoteIndexState, noteIndexState, noteIndexText } from "./note-index.js"
import { documentOf, type Note, noteOf } from "./notes.js"
import type { StoreContext } from "./open.js"
import { stemmerCache } from "./stems.js"
import { dot } from "./vectors.js"

export interface NoteQuery {
  root: ResolvedNode
  limit: number
  offset?: number
  folderIds?: string[]
  source?: Note["source"]
  /** Newest first instead of best first. */
  newest?: boolean
  /** The store's stemmer, set when a leaf is stemmed. */
  stemmer?: Stemmer
  signal?: AbortSignal
}

export interface NoteHit {
  ref: string
  note: Note
  /** bm25 of the words or stems; lower is better. `null` when ranked by time. */
  relevance: number | null
  /** Whether the note holds the exact forms, when the search was stemmed. */
  exact?: boolean
}

/** The fields a note has. A message-only field (`from:`, `chat:`, …) is refused rather than matching nothing. */
export const NOTE_FIELDS = ["text", "exact", "body", "tag", "date", "in"] as const

interface Fragment {
  sql: string
  params: SqlValue[]
  /** False when the SQL only narrows the candidates and a JS test decides. */
  exact: boolean
  fts?: string
  stems?: string
}

const quoted = (value: string) => `"${value.replaceAll('"', '""')}"`
const bound = (sql: string, ...params: SqlValue[]): Fragment => ({ sql, params, exact: true })
const combine = (parts: Fragment[], operator: "AND" | "OR"): Fragment => ({
  sql: parts.length ? `(${parts.map(({ sql }) => sql).join(` ${operator} `)})` : operator === "AND" ? "1" : "0",
  params: parts.flatMap(({ params }) => params),
  exact: parts.every(({ exact }) => exact),
})
/** Files in notes folders and the notes the owner wrote: the same fields, each in its own table and index. */
interface Corpus {
  type: "document" | "note"
  /** The rows as `n`, with the columns the query reads under one set of names. */
  view: string
  words: string
  stems: string
  /** The tagged rows; a document is also labelled through its folder or a subfolder of it. */
  tagged: (tag: string) => Fragment
}

const CORPORA: Corpus[] = [
  {
    type: "document",
    view: "(SELECT id, account_id AS folder_id, external_id AS path, title, coalesce(body, '') AS text, updated_at, deleted_at FROM documents)",
    words: "document_words",
    stems: "document_stems",
    tagged: (tag) =>
      bound(
        "(n.id IN (SELECT g.taggable_id FROM taggings g JOIN tags t ON t.id = g.tag_id WHERE t.name = ? AND g.taggable_type = 'document') " +
          "OR n.folder_id IN (SELECT g.taggable_id FROM taggings g JOIN tags t ON t.id = g.tag_id WHERE t.name = ? AND g.taggable_type = 'account') " +
          "OR EXISTS (SELECT 1 FROM links l JOIN tags t ON t.id = l.to_id WHERE l.from_type = 'account' AND l.from_id = n.folder_id " +
          `AND l.kind = ${linkKind("labelled")} AND l.to_type = 'tag' AND t.name = ? AND substr(n.path, 1, length(l.anchor) + 1) = l.anchor || '/'))`,
        tag,
        tag,
        tag,
      ),
  },
  {
    type: "note",
    view: "(SELECT id, NULL AS folder_id, NULL AS path, title, body AS text, updated_at, deleted_at FROM notes)",
    words: "note_words",
    stems: "note_stems",
    tagged: (tag) =>
      bound(
        "n.id IN (SELECT g.taggable_id FROM taggings g JOIN tags t ON t.id = g.tag_id WHERE t.name = ? AND g.taggable_type = 'note')",
        tag,
      ),
  },
]

interface CorpusRow {
  type: Corpus["type"]
  id: number
  updatedAt: number
  relevance: number | null
  exact?: boolean
}

/** Notes matching a parsed query, by the same language as messages: files and written notes, merged. */
export const searchNotes = (context: StoreContext, query: NoteQuery): { items: NoteHit[]; hasMore: boolean } => {
  const offset = query.offset ?? 0
  const chosen = CORPORA.filter(
    ({ type }) =>
      (query.source === undefined || (query.source === "file") === (type === "document")) &&
      (!query.folderIds?.length || type === "document"),
  )
  const rows = chosen.flatMap((corpus) => searchCorpus(context, query, corpus))
  const exactFirst = rows.some((row) => row.exact !== undefined)
  rows.sort((a, b) =>
    query.newest
      ? b.updatedAt - a.updatedAt || a.id - b.id
      : (exactFirst ? Number(b.exact === true) - Number(a.exact === true) : 0) ||
        Number(a.relevance === null) - Number(b.relevance === null) ||
        (a.relevance ?? 0) - (b.relevance ?? 0) ||
        b.updatedAt - a.updatedAt ||
        a.id - b.id,
  )
  const read = {
    document: context.database.prepare("SELECT * FROM documents WHERE id = ?"),
    note: context.database.prepare("SELECT * FROM notes WHERE id = ?"),
  }
  return {
    items: rows.slice(offset, offset + query.limit).map((row) => {
      const found = read[row.type].get(row.id) as Record<string, unknown>
      const note = row.type === "document" ? documentOf(found) : noteOf(found)
      return {
        ref: note.ref,
        note,
        relevance: row.relevance,
        ...(row.exact === undefined ? {} : { exact: row.exact }),
      }
    }),
    hasMore: rows.length > offset + query.limit,
  }
}

const searchCorpus = (context: StoreContext, query: NoteQuery, corpus: Corpus): CorpusRow[] => {
  const { database } = context
  const wordMatch = (match: string): Fragment => ({
    sql: `n.id IN (SELECT rowid FROM ${corpus.words} WHERE ${corpus.words} MATCH ?)`,
    params: [`normalized_text : (${match})`],
    exact: true,
    fts: match,
  })
  const started = context.now()
  const budget: MatchBudget = { work: 0 }
  let expansions = 0
  const check = () => {
    if (query.signal?.aborted)
      throw new CliError("validation_error", "search was aborted", { reason: "query_aborted", complete: false })
    if (context.now() - started > QUERY_LIMITS.milliseconds) exhausted("time")
  }
  const tests = new Map<ResolvedPredicate, (text: string) => boolean>()
  const fragments = new Map<ResolvedPredicate, Fragment>()
  const automaton = (pattern: string, node: ResolvedPredicate): Automaton => compileAutomaton(pattern, node.span)

  const leaf = (node: ResolvedPredicate): Fragment => {
    const { field, operator, value } = node
    if (!(NOTE_FIELDS as readonly string[]).includes(field))
      queryError("unsupported_field", node.span, `${field}: is not a note field — notes take ${NOTE_FIELDS.join(", ")}`)
    if ((field === "text" || field === "exact") && value === "") return bound("0")
    if (isStemmed(node)) {
      if (!query.stemmer) throw new Error("a stemmed leaf reached the notes search without the store's stemmer")
      const text = normalize(value)
      if (!/[\p{L}\p{N}]/u.test(text)) return bound("0")
      const stems = query.stemmer.phrases(value)
      return {
        sql: `n.id IN (SELECT rowid FROM ${corpus.words} WHERE ${corpus.words} MATCH ?)${stems ? ` OR n.id IN (SELECT rowid FROM ${corpus.stems} WHERE ${corpus.stems} MATCH ?)` : ""}`,
        params: [`normalized_text : (${quoted(text)})`, ...(stems ? [`stems : (${stems})`] : [])],
        exact: true,
        fts: quoted(text),
        ...(stems ? { stems } : {}),
      }
    }
    if (field === "text" || field === "exact") {
      if (operator === "term" || operator === "phrase") {
        const text = normalize(value)
        const stems = query.stemmer?.phrases(value)
        return /[\p{L}\p{N}]/u.test(text) ? { ...wordMatch(quoted(text)), ...(stems ? { stems } : {}) } : bound("0")
      }
      const pattern = operator === "wildcard" ? wildcardPattern(normalize(value)) : foldRegex(value, node.span)
      const matcher = automaton(pattern, node)
      const prefix = prefixOf(pattern)
      const terms = database
        .prepare(
          `SELECT term FROM ${corpus.words}_vocab WHERE col='normalized_text'${prefix ? " AND term>=? AND term<=?" : ""} ORDER BY term LIMIT ?`,
        )
        .all(...(prefix ? [prefix, `${prefix}\u{10ffff}`] : []), QUERY_LIMITS.expansions + 1)
      expansions += terms.length
      if (expansions > QUERY_LIMITS.expansions) exhausted("term expansions")
      const matches = terms.flatMap(({ term }) => {
        check()
        return matcher.test(String(term), budget) ? [quoted(String(term))] : []
      })
      return matches.length ? wordMatch(matches.join(" OR ")) : bound("0")
    }
    if (field === "body") {
      if (operator === "term" || operator === "phrase") return bound("n.text = ?", value)
      const matcher = automaton(operator === "wildcard" ? wildcardPattern(value) : value, node)
      tests.set(node, (text) => matcher.test(text, budget))
      return { sql: "1", params: [], exact: false }
    }
    if (field === "tag") {
      const tag = tagOf(value)
      if (tag === undefined) queryError("invalid_tag", node.span)
      // A label on a folder or subfolder labels every note under it, at any depth.
      return corpus.tagged(tag)
    }
    if (field === "date") {
      const range = node.resolution?.date
      if (!range) queryError("invalid_ast", node.span)
      return combine(
        [
          ...(range.lower === undefined
            ? []
            : [bound(`n.updated_at ${range.lowerInclusive ? ">=" : ">"} ?`, range.lower)]),
          ...(range.upper === undefined
            ? []
            : [bound(`n.updated_at ${range.upperInclusive ? "<=" : "<"} ?`, range.upper)]),
        ],
        "AND",
      )
    }
    return bound(["notes", "note"].includes(value.toLowerCase()) ? "1" : "0")
  }

  const compile = (node: ResolvedNode): Fragment => {
    if (node.kind === "predicate") {
      const fragment = leaf(node)
      const wrapped = { ...fragment, sql: `(${fragment.sql})` }
      fragments.set(node, wrapped)
      return wrapped
    }
    const parts = node.clauses.map(({ occur, node }) => ({ occur, part: compile(node) }))
    const must = parts.filter(({ occur }) => occur === "must").map(({ part }) => part)
    const should = parts.filter(({ occur }) => occur === "should").map(({ part }) => part)
    const not = parts
      .filter(({ occur }) => occur === "mustNot")
      .map(({ part }) =>
        part.exact ? { ...part, sql: `NOT coalesce(${part.sql},0)` } : { sql: "1", params: [], exact: false },
      )
    return combine([must.length ? combine(must, "AND") : combine(should, "OR"), ...not], "AND")
  }
  const required = (node: ResolvedNode, index: "fts" | "stems"): string | undefined => {
    if (node.kind === "predicate") return fragments.get(node)?.[index]
    const must = node.clauses.filter(({ occur }) => occur === "must")
    const parts = (must.length ? must : node.clauses.filter(({ occur }) => occur === "should")).map(({ node }) =>
      required(node, index),
    )
    if (must.length) {
      const known = parts.filter((part): part is string => part !== undefined)
      return known.length ? known.map((part) => `(${part})`).join(" AND ") : undefined
    }
    return parts.length && parts.every((part) => part !== undefined)
      ? parts.map((part) => `(${part})`).join(" OR ")
      : undefined
  }

  database.exec("BEGIN")
  try {
    check()
    const expression = compile(query.root)
    const stemmed = [...fragments.keys()].some(isStemmed)
    const scope = combine(
      [
        bound("n.deleted_at IS NULL"),
        ...(query.folderIds?.length
          ? [bound("n.folder_id IN (SELECT CAST(value AS INTEGER) FROM json_each(?))", JSON.stringify(query.folderIds))]
          : []),
      ],
      "AND",
    )
    const where = combine([scope, expression], "AND")
    const ranking = query.newest ? undefined : required(query.root, stemmed ? "stems" : "fts")
    const exactTier = stemmed ? required(query.root, "fts") : undefined
    const ctes: string[] = []
    const cteParams: SqlValue[] = []
    if (ranking) {
      const table = stemmed ? corpus.stems : corpus.words
      ctes.push(
        `f(id, rank) AS MATERIALIZED (SELECT rowid, bm25(${table}, 1.0, 0.0) FROM ${table} WHERE ${table} MATCH ?)`,
      )
      cteParams.push(`${stemmed ? "stems" : "normalized_text"} : (${ranking})`)
    }
    if (exactTier) {
      ctes.push(`x(id) AS MATERIALIZED (SELECT rowid FROM ${corpus.words} WHERE ${corpus.words} MATCH ?)`)
      cteParams.push(`normalized_text : (${exactTier})`)
    }
    const order = query.newest
      ? "n.updated_at DESC, n.id"
      : `${exactTier ? "exact DESC, " : ""}${ranking ? "f.rank IS NULL, f.rank, " : ""}n.updated_at DESC, n.id`
    const offset = query.offset ?? 0
    // With a JS test the SQL only names candidates: every leaf's SQL answer comes along, so the test sees it.
    const leaves = [...fragments.entries()].filter(([node]) => !tests.has(node))
    const projection = tests.size
      ? leaves.map(([, fragment], index) => `, coalesce(${fragment.sql}, 0) AS q${index}`).join("")
      : ""
    const window = tests.size ? QUERY_LIMITS.candidates + 1 : query.limit + offset + 1
    const rows = database
      .prepare(
        `${ctes.length ? `WITH ${ctes.join(", ")} ` : ""}SELECT n.*, ${ranking ? "f.rank" : "NULL"} AS relevance${exactTier ? ", n.id IN (SELECT id FROM x) AS exact" : ""}${projection}
           FROM ${corpus.view} n${ranking ? " LEFT JOIN f ON f.id = n.id" : ""} WHERE ${where.sql} ORDER BY ${order} LIMIT ?`,
      )
      .all(
        ...cteParams,
        ...leaves.flatMap(([, fragment]) => (tests.size ? fragment.params : [])),
        ...where.params,
        window,
      )
    if (tests.size && rows.length > QUERY_LIMITS.candidates) exhausted("candidates")
    const evaluate = (node: ResolvedNode, row: Record<string, unknown>, text: string): boolean => {
      if (node.kind === "predicate") {
        const test = tests.get(node)
        return test ? test(text) : Number(row[`q${leaves.findIndex(([leaf]) => leaf === node)}`]) === 1
      }
      const must = node.clauses.filter(({ occur }) => occur === "must")
      const should = node.clauses.filter(({ occur }) => occur === "should")
      const not = node.clauses.filter(({ occur }) => occur === "mustNot")
      return (
        (must.length
          ? must.every(({ node }) => evaluate(node, row, text))
          : should.length > 0 && should.some(({ node }) => evaluate(node, row, text))) &&
        not.every(({ node }) => !evaluate(node, row, text))
      )
    }
    const matched = tests.size
      ? rows.filter((row) => {
          check()
          const text = noteIndexText(row.title === null ? null : String(row.title), String(row.text))
          budget.work += text.length
          if (budget.work > QUERY_LIMITS.work) exhausted("detector work")
          return evaluate(query.root, row, text)
        })
      : rows
    return matched.map((row) => ({
      type: corpus.type,
      id: Number(row.id),
      updatedAt: Number(row.updated_at),
      relevance: row.relevance === null || row.relevance === undefined ? null : Number(row.relevance),
      ...(exactTier ? { exact: Number(row.exact) === 1 } : {}),
    }))
  } finally {
    database.exec("COMMIT")
  }
}

export interface NoteChunkToEmbed {
  hash: string
  text: string
}

export interface NearestNote {
  ref: string
  note: Note
  /** Cosine of the note's best chunk; higher is nearer. */
  score: number
  /** The stretch of the indexed text (title, then text) that chunk holds. */
  range: { start: number; end: number }
}

export interface NoteSearch {
  /** Indexes what was written since, then searches; a note written a moment ago is found. */
  search(query: NoteQuery): Promise<{ items: NoteHit[]; hasMore: boolean }>
  indexState(): Promise<NoteIndexState | undefined>
  /** Live notes' chunks with no vector of `model`, by hash from `after`, each with its text cut again. */
  chunksToEmbed(model: string, options: { after?: string; limit: number }): Promise<NoteChunkToEmbed[]>
  /** Notes nearest in meaning to `query`, each scored by its best chunk. Vectors are unit length. */
  nearest(
    model: string,
    query: Float32Array,
    options: { limit: number; folderIds?: string[]; source?: Note["source"] },
  ): Promise<NearestNote[]>
}

const SCAN_PAGE = 5_000

/** The live documents and notes of a chunk scan, narrowed by folder and source. */
const LIVE =
  "((k.chunkable_type = 'document' AND EXISTS (SELECT 1 FROM documents d WHERE d.id = k.chunkable_id AND d.deleted_at IS NULL " +
  "AND (? IS NULL OR d.account_id IN (SELECT CAST(value AS INTEGER) FROM json_each(?))))) " +
  "OR (k.chunkable_type = 'note' AND ? IS NULL AND EXISTS (SELECT 1 FROM notes n WHERE n.id = k.chunkable_id AND n.deleted_at IS NULL)))"

export const noteSearchOver = (context: StoreContext): NoteSearch => {
  const { database } = context
  const stemmerFor = stemmerCache()
  const drain = () => drainNoteIndex(database, stemmerFor)
  const read = (type: string, id: number): Note | undefined => {
    const row = database.prepare(`SELECT * FROM ${type === "document" ? "documents" : "notes"} WHERE id = ?`).get(id)
    return row ? (type === "document" ? documentOf(row) : noteOf(row)) : undefined
  }
  const live = (folderIds: string[] | undefined, source: Note["source"] | undefined) => {
    const folders = folderIds?.length ? JSON.stringify(folderIds) : null
    const types = source === undefined ? ["document", "note"] : source === "file" ? ["document"] : ["note"]
    return {
      sql: ` AND k.chunkable_type IN (${types.map(() => "?").join(", ")}) AND ${LIVE}`,
      params: [...types, folders, folders, folders] as SqlValue[],
    }
  }
  return {
    search: async (query) => {
      drain()
      return searchNotes(context, query)
    },
    indexState: async () => noteIndexState(database),
    chunksToEmbed: async (model, { after, limit }) => {
      drain()
      const scope = live(undefined, undefined)
      return database
        .prepare(
          `SELECT k.content_hash AS hash, min(k.chunkable_type || ':' || k.chunkable_id) AS owner, k.start_offset AS start, k.end_offset AS end
             FROM chunks k
            WHERE k.content_hash > ?${scope.sql}
              AND NOT EXISTS (SELECT 1 FROM embeddings v WHERE v.model = ? AND v.content_hash = k.content_hash)
            GROUP BY k.content_hash ORDER BY k.content_hash LIMIT ?`,
        )
        .all(after ?? "", ...scope.params, model, limit)
        .flatMap((row) => {
          const [type, id] = String(row.owner).split(":")
          const note = read(String(type), Number(id))
          if (!note) return []
          const text = noteIndexText(note.title, note.text)
          return [{ hash: String(row.hash), text: text.slice(Number(row.start), Number(row.end)) }]
        })
    },
    nearest: async (model, query, { limit, folderIds, source }) => {
      drain()
      const scope = live(folderIds, source)
      const page = database.prepare(
        `SELECT k.id, k.chunkable_type AS type, k.chunkable_id AS owner, k.start_offset AS start, k.end_offset AS end, v.vector
           FROM chunks k JOIN embeddings v ON v.model = ? AND v.content_hash = k.content_hash
          WHERE k.id > ?${scope.sql}
          ORDER BY k.id LIMIT ?`,
      )
      const best = new Map<string, { score: number; start: number; end: number }>()
      let after = 0
      for (;;) {
        const rows = page.all(model, after, ...scope.params, SCAN_PAGE)
        for (const row of rows) {
          const score = dot(query, row.vector as Uint8Array)
          const key = `${row.type}:${row.owner}`
          if (score > (best.get(key)?.score ?? Number.NEGATIVE_INFINITY))
            best.set(key, { score, start: Number(row.start), end: Number(row.end) })
        }
        const last = rows.at(-1)
        if (!last || rows.length < SCAN_PAGE) break
        after = Number(last.id)
      }
      return [...best.entries()]
        .sort(([, a], [, b]) => b.score - a.score)
        .slice(0, limit)
        .flatMap(([key, { score, start, end }]) => {
          const [type, id] = key.split(":")
          const note = read(String(type), Number(id))
          return note ? [{ ref: note.ref, note, score, range: { start, end } }] : []
        })
    },
  }
}
