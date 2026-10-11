import { CHUNK_CHARS, chunkHash, splitText } from "../../conversations/chunks.js"
import { analyzerIdentity, DEFAULT_STEMMERS, type Stemmer, type Stemmers } from "../../search/stem.js"
import type { CacheDatabase } from "../driver.js"
import { normalize } from "../normalize.js"
import { inBatch, indexRow } from "./search-index.js"
import { savedStemmers } from "./stems.js"

export interface NoteIndexState {
  /** Rows written since they were indexed. */
  pending: number
  /** The stemmer choices the stems were built by; `null` until the first drain. */
  built: string | null
  wanted: string | null
  /** Every live row is in the words, stems and chunks: a search sees all of them. */
  ready: boolean
}

/**
 * A text corpus with its own words and stems index, filled from its queue: documents, notes and memories
 * share the recipe, each with its own tables.
 */
export interface Corpus {
  /** The singular table name: `indexable_type` in the queue, `chunkable_type` in chunks. */
  type: "document" | "note" | "memory" | "email"
  /** Its row in `search_index_state`. */
  index: string
  table: string
  /** Title and body as `title`/`body`, whether it is live, and its scope, for one row by `id`. */
  read: string
}

export const CORPORA = {
  document: {
    type: "document",
    index: "document_index",
    table: "documents",
    read:
      "SELECT d.title, coalesce(d.body, '') AS body, d.deleted_at IS NULL AS live, a.scope FROM documents d " +
      "JOIN accounts a ON a.id = d.account_id WHERE d.id = ?",
  },
  note: {
    type: "note",
    index: "note_index",
    table: "notes",
    read: "SELECT title, body, deleted_at IS NULL AS live, 'personal' AS scope FROM notes WHERE id = ?",
  },
  memory: {
    type: "memory",
    index: "memory_index",
    table: "memories",
    read: "SELECT NULL AS title, body, status <> 'superseded' AS live, scope FROM memories WHERE id = ?",
  },
  email: {
    type: "email",
    index: "email_index",
    table: "emails",
    read:
      "SELECT e.subject AS title, coalesce(e.body_text, '') AS body, e.deleted_at IS NULL AS live, a.scope FROM emails e " +
      "JOIN accounts a ON a.id = e.account_id WHERE e.id = ?",
  },
} as const satisfies Record<string, Corpus>

/** What a row is indexed as: its title, then its text. Chunk offsets point into this. */
export const noteIndexText = (title: string | null, text: string): string => (title ? `${title}\n\n${text}` : text)

export const corpusIndexState = (database: CacheDatabase, corpus: Corpus): NoteIndexState => {
  const row = indexRow(database, corpus.index) as Record<string, unknown>
  const pending = Number(
    database.prepare(`SELECT count(*) AS n FROM ${corpus.type}_index_pending WHERE indexable_type = ?`).get(corpus.type)
      ?.n,
  )
  const saved = savedStemmers(database)
  const wanted = saved === null ? null : analyzerIdentity(saved ?? DEFAULT_STEMMERS)
  const built = row.analyzer === null ? null : String(row.analyzer)
  return { pending, built, wanted, ready: pending === 0 && wanted !== null && (built === wanted || built === null) }
}

/** Documents and notes together: what a notes search reads. */
export const noteIndexState = (database: CacheDatabase): NoteIndexState => {
  const documents = corpusIndexState(database, CORPORA.document)
  const notes = corpusIndexState(database, CORPORA.note)
  return {
    pending: documents.pending + notes.pending,
    built: notes.built ?? documents.built,
    wanted: notes.wanted,
    ready: documents.ready && notes.ready,
  }
}

const writer = (database: CacheDatabase, corpus: Corpus, stemmer: Stemmer) => {
  const read = database.prepare(corpus.read)
  const oldHashes = database.prepare(
    "SELECT content_hash AS hash FROM chunks WHERE chunkable_type = ? AND chunkable_id = ?",
  )
  const statements = {
    dropWords: database.prepare(`DELETE FROM ${corpus.type}_words WHERE rowid = ?`),
    dropStems: database.prepare(`DELETE FROM ${corpus.type}_stems WHERE rowid = ?`),
    dropChunks: database.prepare("DELETE FROM chunks WHERE chunkable_type = ? AND chunkable_id = ?"),
    words: database.prepare(`INSERT INTO ${corpus.type}_words (rowid, normalized_text, scope) VALUES (?, ?, ?)`),
    stems: database.prepare(`INSERT INTO ${corpus.type}_stems (rowid, stems, scope) VALUES (?, ?, ?)`),
    chunk: database.prepare(
      "INSERT INTO chunks (chunkable_type, chunkable_id, position, start_offset, end_offset, content_hash, scope, created_at, updated_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ),
    purge: database.prepare(
      `DELETE FROM embeddings WHERE content_hash = ?
         AND NOT EXISTS (SELECT 1 FROM chunks WHERE content_hash = ?)`,
    ),
    dequeue: database.prepare(`DELETE FROM ${corpus.type}_index_pending WHERE indexable_type = ? AND id = ?`),
  }
  return (id: number) => {
    const row = read.get(id)
    const before = oldHashes.all(corpus.type, id).map((hash) => String(hash.hash))
    statements.dropWords.run(id)
    statements.dropStems.run(id)
    statements.dropChunks.run(corpus.type, id)
    const live = row !== undefined && Number(row.live) === 1
    const text = live ? noteIndexText(row.title == null ? null : String(row.title), String(row.body)) : ""
    const scope = live ? String(row.scope ?? "personal") : ""
    const words = normalize(text)
    if (words !== "") statements.words.run(id, words, scope)
    const stems = text ? stemmer.indexText(text) : ""
    if (stems !== "") statements.stems.run(id, stems, scope)
    const after = new Set<string>()
    if (text.trim()) {
      const at = Date.now()
      splitText(text, CHUNK_CHARS).forEach(({ start, end }, position) => {
        const hash = chunkHash(text.slice(start, end))
        after.add(hash)
        statements.chunk.run(corpus.type, id, position, start, end, hash, scope, at, at)
      })
    }
    for (const hash of before) if (!after.has(hash)) statements.purge.run(hash, hash)
    statements.dequeue.run(corpus.type, id)
  }
}

/**
 * Indexes one corpus's rows written since the last drain, in short write transactions. These corpora are
 * small, so a change of stemmer choices simply queues every row again instead of waiting for `store reindex`.
 */
export const drainCorpus = (
  database: CacheDatabase,
  corpus: Corpus,
  stemmerFor: (stemmers: Stemmers) => Stemmer,
  { batch = 200, until = () => false }: { batch?: number; until?: () => boolean } = {},
): number => {
  // The first schema seeded no row for mail; a data row, so no migration.
  database
    .prepare(
      "INSERT OR IGNORE INTO search_index_state (name, watermark, filled_through, terms_through, normalizer_version) VALUES (?, 0, 0, 0, 1)",
    )
    .run(corpus.index)
  const state = corpusIndexState(database, corpus)
  if (state.wanted === null) return 0
  const stemmer = stemmerFor(savedStemmers(database) ?? DEFAULT_STEMMERS)
  const queue = `${corpus.type}_index_pending`
  if (state.built !== stemmer.identity) {
    inBatch(database, () => {
      if (state.built !== null)
        database
          .prepare(`INSERT OR IGNORE INTO ${queue} (indexable_type, id) SELECT ?, id FROM ${corpus.table}`)
          .run(corpus.type)
      database.prepare("UPDATE search_index_state SET analyzer = ? WHERE name = ?").run(stemmer.identity, corpus.index)
    })
  }
  if (state.pending === 0 && state.built === stemmer.identity) return 0
  const next = database.prepare(`SELECT id FROM ${queue} WHERE indexable_type = ? ORDER BY id LIMIT ?`)
  const index = writer(database, corpus, stemmer)
  let done = 0
  for (;;) {
    if (until()) break
    const count = inBatch(database, () => {
      const ids = next.all(corpus.type, batch).map((row) => Number(row.id))
      for (const id of ids) index(id)
      return ids.length
    })
    if (count === 0) break
    done += count
  }
  return done
}

/** Documents, then notes: what a notes search reads. */
export const drainNoteIndex = (
  database: CacheDatabase,
  stemmerFor: (stemmers: Stemmers) => Stemmer,
  options: { batch?: number; until?: () => boolean } = {},
): number =>
  drainCorpus(database, CORPORA.document, stemmerFor, options) +
  drainCorpus(database, CORPORA.note, stemmerFor, options)

/** Queues every document, note and memory again — for `store reindex`. */
export const resetNoteIndex = (database: CacheDatabase): boolean => {
  inBatch(database, () => {
    for (const corpus of Object.values(CORPORA))
      database
        .prepare(
          `INSERT OR IGNORE INTO ${corpus.type}_index_pending (indexable_type, id) SELECT ?, id FROM ${corpus.table}`,
        )
        .run(corpus.type)
  })
  return true
}
