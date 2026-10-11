import { CliError } from "@wirecat/cli-core"
import { normalizeTag } from "../domain/tags.js"
import { defaultThreads, type Embedder, isTextModelInstalled, textModelsDirectory } from "../embeddings/embed.js"
import { DEFAULT_TEXT_MODEL, meaningFloor, type TextModel, textModel } from "../embeddings/models.js"
import { dateRange, timezoneOf } from "../search/lucene/dates.js"
import { parseLucene } from "../search/lucene/parser.js"
import { validateFields } from "../search/lucene/registry.js"
import { hasStems, type ResolvedNode } from "../search/lucene/resolved.js"
import type { QueryNode } from "../search/lucene/types.js"
import { createStemmer, DEFAULT_STEMMERS } from "../search/stem.js"
import type { Link, NearestNote, Note, NoteHit } from "../store/index.js"
import type { MessageStore } from "../store/store.js"
import { vectorModelKey } from "./embeddings.js"

export interface NotesSearchRequest {
  text: string
  limit: number
  offset?: number
  /** Every word as written: no stems. */
  exact?: boolean
  newest?: boolean
  folderIds?: string[]
  source?: Note["source"]
  /** For `date:` — the zone a bare day is read in. */
  timezone?: string
  signal?: AbortSignal
}

/** A notes search in the query language messages use, for `search notes` and `search all` to call. */
export const searchNotesQuery = async (
  store: MessageStore,
  request: NotesSearchRequest,
): Promise<{ items: NoteHit[]; hasMore: boolean }> => {
  if (!request.text.trim()) throw new CliError("validation_error", "say what to find in the notes")
  const ast = validateFields(parseLucene(request.text, { defaultField: request.exact ? "exact" : "text" }))
  const timezone = timezoneOf(request.timezone)
  const resolve = (node: QueryNode): ResolvedNode => {
    if (node.kind === "boolean")
      return { ...node, clauses: node.clauses.map(({ occur, node }) => ({ occur, node: resolve(node) })) }
    if (node.field !== "date") return node
    return {
      ...node,
      resolution: {
        date: dateRange(
          node.value,
          node.operator === "range" ? (node.upper ?? "*") : node.value,
          node.operator === "range" ? node.lowerInclusive === true : true,
          node.operator === "range" ? node.upperInclusive === true : true,
          timezone,
          node.span,
        ),
      },
    }
  }
  const stemmers = hasStems(ast.root) ? await store.stemmers() : undefined
  if (stemmers === null)
    throw new CliError(
      "validation_error",
      "the store asks for stemmers this tool does not know — upgrade this tool, or search exact forms with --exact",
      { reason: "stemmer_unknown" },
    )
  return store.notes.search({
    root: resolve(ast.root),
    limit: request.limit,
    ...(request.offset === undefined ? {} : { offset: request.offset }),
    ...(request.newest ? { newest: true } : {}),
    ...(request.folderIds ? { folderIds: request.folderIds } : {}),
    ...(request.source ? { source: request.source } : {}),
    ...(request.signal ? { signal: request.signal } : {}),
    ...(hasStems(ast.root) ? { stemmer: createStemmer(stemmers ?? DEFAULT_STEMMERS) } : {}),
  })
}

export interface NotesEmbedOptions {
  /** A local text model by id; e5-small, as conversations use, when absent. */
  model?: string
  /** How many chunks this run embeds at most; the next run continues. */
  maxChunks?: number
  env?: NodeJS.ProcessEnv
  threads?: number
}

export interface NotesEmbedded {
  model: string
  embedded: number
  /** Chunks still without a vector, when `maxChunks` stopped the run. */
  left: boolean
}

/** Chunks one batch embeds: one short transaction writes each, as for conversations. */
const NOTE_BATCH = 8

const localModel = (choice: string | undefined, env: NodeJS.ProcessEnv | undefined, command: string) => {
  const model = textModel(choice ?? DEFAULT_TEXT_MODEL)
  const directory = textModelsDirectory(env)
  if (!isTextModelInstalled(model, directory))
    throw new CliError("not_found", `${model.id} is not downloaded — \`${command} models text download ${model.id}\``)
  return { model, directory, key: vectorModelKey(model) }
}

const withLocal = async <T>(
  model: TextModel,
  directory: string,
  threads: number | undefined,
  work: (embedder: Embedder) => Promise<T>,
): Promise<T> => {
  const { openPool } = await import("../embeddings/pool.js")
  const embedder = await openPool(model, directory, { workers: 1, threads: threads ?? defaultThreads() })
  try {
    return await work(embedder)
  } finally {
    await embedder.close()
  }
}

/**
 * Embeds the notes' chunks that have no vector of the model yet, with the same model, prefixes and key
 * as conversations, so a chunk whose text a conversation shares is embedded once. A missing model is
 * an error naming the download command; nothing is downloaded.
 */
const embedChunks = async (
  store: MessageStore,
  source: Pick<MessageStore["notes"], "chunksToEmbed">,
  {
    model: choice,
    maxChunks = Number.POSITIVE_INFINITY,
    env,
    threads,
    command = "tg",
  }: NotesEmbedOptions & {
    command?: string
  } = {},
): Promise<NotesEmbedded> => {
  const { model, directory, key } = localModel(choice, env, command)
  if ((await source.chunksToEmbed(key, { limit: 1 })).length === 0) return { model: model.id, embedded: 0, left: false }
  return withLocal(model, directory, threads, async (embedder) => {
    let embedded = 0
    let after: string | undefined
    while (embedded < maxChunks) {
      const batch = await source.chunksToEmbed(key, {
        limit: Math.min(NOTE_BATCH, maxChunks - embedded),
        ...(after === undefined ? {} : { after }),
      })
      if (batch.length === 0) break
      after = batch.at(-1)?.hash
      const vectors = await embedder.embed(
        batch.map(({ text }) => text),
        "passage",
      )
      await store.saveVectors(
        key,
        model.dims,
        batch.map(({ hash }, index) => ({ hash, vector: vectors[index] as Float32Array })),
      )
      embedded += batch.length
    }
    const left = (await source.chunksToEmbed(key, { limit: 1, ...(after === undefined ? {} : { after }) })).length > 0
    return { model: model.id, embedded, left }
  })
}

export const embedNotes = (store: MessageStore, options: NotesEmbedOptions & { command?: string } = {}) =>
  embedChunks(store, store.notes, options)

/** Embeds mail's chunks as notes' are embedded: same model and key, so search by meaning reads both. */
export const embedMail = (store: MessageStore, options: NotesEmbedOptions & { command?: string } = {}) =>
  embedChunks(store, store.mail, options)

/** Notes nearest in meaning to the query, best first; only notes already embedded can be found. */
export const nearestNotes = async (
  store: MessageStore,
  query: string,
  {
    model: choice,
    limit,
    folderIds,
    source,
    env,
    threads,
    command = "tg",
  }: Omit<NotesEmbedOptions, "maxChunks"> & {
    limit: number
    folderIds?: string[]
    source?: Note["source"]
    command?: string
  },
): Promise<NearestNote[]> => {
  if (!query.trim()) throw new CliError("validation_error", "say what to find in the notes")
  const { model, directory, key } = localModel(choice, env, command)
  const [vector] = await withLocal(model, directory, threads, (embedder) => embedder.embed([query], "query"))
  const floor = meaningFloor(key)
  const nearest = await store.notes.nearest(key, vector as Float32Array, {
    limit,
    ...(folderIds ? { folderIds } : {}),
    ...(source ? { source } : {}),
  })
  return nearest.filter(({ score }) => score > floor)
}

export interface FoundNote {
  ref: string
  source: Note["source"]
  folderId: string | null
  /** The note's path inside its folder; `null` for a note written in memo. */
  path: string | null
  title: string | null
  modifiedAt: string
  /** The first line holding a word of the query. */
  line: string
  links: Pick<Link, "to" | "targetText" | "kind" | "anchor">[]
  /** Which halves of the search found it. */
  foundBy: ("words" | "meaning")[]
}

export interface LinkedRecord {
  /** `person:…`, `note:…`, `entity:…`, or `null` while the name written in the notes matches nobody yet. */
  ref: string | null
  name: string | null
  /** How many of the notes found link it. */
  notes: number
}

export interface NotesFound {
  query: string
  tag?: string
  filter?: string
  /** Words and word stems always; meaning too when the model is there and the query is not exact. */
  by: "words" | "words and meaning"
  /** Why meaning was not searched, when it was not. */
  meaningSkipped?: string
  hits: FoundNote[]
  hasMore: boolean
  nextOffset?: number
  /** What the notes found link to, most linked first. */
  linked: LinkedRecord[]
}

export interface NotesQuery {
  limit?: number
  offset?: number
  tag?: string
  /** A query in the same language that every hit must also match; it does not change the meaning half. */
  filter?: string
  folderIds?: string[]
  source?: Note["source"]
  exact?: boolean
  timezone?: string
  env?: NodeJS.ProcessEnv
  /** The tool's command, named in the hint when the model is missing. */
  command?: string
}

const MAX_LINE = 200
const MAX_NOTES_OFFSET = 1000
/** How deep each half is read before the two are merged. */
const CANDIDATES = 50
/** What a filter may narrow the meaning half to; past this the filter is applied to words only. */
const FILTERED = 500
/** Reciprocal rank fusion's usual constant, as conversations use. */
export const RRF_K = 60

const firstLine = (text: string, query: string): string => {
  const words = query
    .toLowerCase()
    .split(/\s+/)
    .map((word) => word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ""))
    .filter((word) => word.length > 2 && !["and", "or", "not"].includes(word))
  const lines = text.split("\n")
  const found = lines.find((line) => words.some((word) => line.toLowerCase().includes(word)))
  return (found ?? lines.find((line) => line.trim() !== "") ?? "").trim().slice(0, MAX_LINE)
}

/**
 * `search notes`: words and stems, and meaning when the local model is there, merged by reciprocal rank;
 * each hit says which half found it, and the answer lists what the notes found link to.
 */
export const searchNotes = async (
  store: MessageStore,
  query: string,
  {
    limit = 20,
    offset = 0,
    tag,
    filter: expression,
    folderIds,
    source,
    exact = false,
    timezone,
    env,
    command = "tg",
  }: NotesQuery = {},
): Promise<NotesFound> => {
  const label = tag === undefined ? undefined : normalizeTag(tag)
  const filter =
    [expression ? `(${expression})` : "", label === undefined ? "" : `tag:${label}`].filter(Boolean).join(" AND ") ||
    undefined
  const text = [query.trim() ? `(${query})` : "", filter ?? ""].filter(Boolean).join(" AND ")
  const window = offset + limit
  const scope = {
    ...(folderIds === undefined ? {} : { folderIds }),
    ...(source === undefined ? {} : { source }),
    ...(timezone === undefined ? {} : { timezone }),
  }
  let meaningSkipped: string | undefined
  let meaning: { ref: string; note: Note }[] | undefined
  if (exact) meaningSkipped = "--exact searches words as written"
  else if (query.trim()) {
    try {
      const nearest = await nearestNotes(store, query, {
        limit: Math.max(window, CANDIDATES),
        command,
        ...(env === undefined ? {} : { env }),
        ...(folderIds === undefined ? {} : { folderIds }),
        ...(source === undefined ? {} : { source }),
      })
      if (filter === undefined) meaning = nearest
      else {
        const allowed = await searchNotesQuery(store, { text: filter, limit: FILTERED, ...scope })
        const refs = new Set(allowed.items.map(({ ref }) => ref))
        meaning = nearest.filter(({ ref }) => refs.has(ref))
      }
    } catch (error) {
      if (!(error instanceof CliError && error.code === "not_found")) throw error
      meaningSkipped = error.message
    }
  }
  const words = await searchNotesQuery(store, {
    text,
    limit: meaning === undefined ? limit : Math.max(window, CANDIDATES),
    offset: meaning === undefined ? offset : 0,
    exact,
    ...scope,
  })
  const ranked = new Map<string, { note: Note; score: number; foundBy: ("words" | "meaning")[] }>()
  const add = (list: { ref: string; note: Note }[], by: "words" | "meaning") =>
    list.forEach(({ ref, note }, rank) => {
      const held = ranked.get(ref) ?? { note, score: 0, foundBy: [] }
      held.score += 1 / (RRF_K + rank + 1)
      held.foundBy.push(by)
      ranked.set(ref, held)
    })
  add(words.items, "words")
  if (meaning !== undefined) add(meaning, "meaning")
  const ordered = [...ranked.entries()].sort(([, a], [, b]) => b.score - a.score)
  const page = meaning === undefined ? ordered : ordered.slice(offset, window)
  const hasMore = meaning === undefined ? words.hasMore : ordered.length > window || words.hasMore
  const hits: FoundNote[] = []
  const counts = new Map<string, LinkedRecord>()
  for (const [ref, { note, foundBy }] of page) {
    const links = (await store.notes.links({ from: ref })).map(({ to, targetText, kind, anchor }) => ({
      to,
      targetText,
      kind,
      anchor,
    }))
    hits.push({
      ref,
      source: note.source,
      folderId: note.folderId,
      path: note.path,
      title: note.title,
      modifiedAt: note.updatedAt,
      line: firstLine(note.text, query),
      links,
      foundBy,
    })
    for (const link of new Map(links.map((link) => [link.to ?? `?${link.targetText}`, link])).values()) {
      const key = link.to ?? `?${link.targetText}`
      const known = counts.get(key) ?? { ref: link.to, name: link.targetText, notes: 0 }
      known.notes++
      counts.set(key, known)
    }
  }
  const names = new Map<string, string>(
    [...(await store.knowledge.organizations()), ...(await store.knowledge.projects())].map(({ ref, name }) => [
      ref,
      name,
    ]),
  )
  for (const record of counts.values()) {
    if (record.ref && names.has(record.ref)) record.name = names.get(record.ref) ?? record.name
    if (record.ref?.startsWith("person:"))
      record.name = (await store.personByUid(record.ref.slice("person:".length)))?.name ?? record.name
    if (record.ref?.startsWith("note:") || record.ref?.startsWith("document:"))
      record.name = (await store.notes.note(record.ref).catch(() => undefined))?.title ?? record.name
  }
  return {
    query,
    ...(label === undefined ? {} : { tag: label }),
    ...(filter === undefined ? {} : { filter }),
    by: meaning === undefined ? "words" : "words and meaning",
    ...(meaningSkipped === undefined ? {} : { meaningSkipped }),
    hits,
    hasMore,
    ...(hasMore && window <= MAX_NOTES_OFFSET ? { nextOffset: window } : {}),
    linked: [...counts.values()].sort(
      (a, b) => b.notes - a.notes || (a.name ?? a.ref ?? "").localeCompare(b.name ?? b.ref ?? ""),
    ),
  }
}
