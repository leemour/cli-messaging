import { CliError } from "@wirecat/cli-core"
import {
  analyzerIdentity,
  createStemmer,
  DEFAULT_STEMMERS,
  DEFAULT_STEMMERS_VERSION,
  parseStemmers,
  SNOWBALL_VERSION,
  type Stemmer,
  type Stemmers,
} from "../../search/stem.js"
import type { CacheDatabase } from "../driver.js"
import { inBatch, indexRow } from "./search-index.js"

const INDEX = "message_stems"
const SETTING = "searchStemmers"

/** Stems a store write leaves for the next fill: an older binary may have left thousands queued. */
export const DRAIN_ON_WRITE = 500

export interface StemsState {
  watermark: number
  filledThrough: number
  /** Messages written or edited since their stems were: queued by triggers, emptied by JS. */
  pending: number
  /** What built the stems; `null` until a fill claims the row. */
  built: string | null
  /** What this binary builds with the store's setting. */
  wanted: string
  /** Every live message is stemmed by `wanted`: stemmed search may run. */
  ready: boolean
  /**
   * Why it is not ready: still filling, built by other choices and waiting for `store reindex`, or the
   * store asks for choices only a newer tool knows.
   */
  cause?: "building" | "stemmer_changed" | "stemmer_unknown"
  builtAt: string | null
}

export interface StemsFill {
  stemmed: number
  drained: number
}

/**
 * The choices `config set searchStemmers.*` saved; `undefined` while the defaults apply, `null` when a
 * newer tool saved one this build does not know. Never throws: every open and write reads it.
 */
export const savedStemmers = (database: CacheDatabase): Stemmers | null | undefined => {
  const row = database.prepare("SELECT value FROM store_settings WHERE key = ?").get(SETTING)
  if (!row) return undefined
  try {
    return parseStemmers(JSON.parse(String(row.value)))
  } catch {
    return null
  }
}

/** The store-wide choices every fill, drain and readiness check uses; `null` stems nothing. */
const storeStemmers = (database: CacheDatabase): Stemmers | null => {
  const saved = savedStemmers(database)
  return saved === undefined ? DEFAULT_STEMMERS : saved
}

const UNKNOWN = "unknown to this build"

/**
 * `default` is saved beside the defaults' version; older builds read only `cyrillic` and `latin`, and take
 * any saved value as the owner's choice. A setting without `origin` is the owner's, or a default saved by
 * 0.198–0.199, which cannot be told apart.
 */
export const saveStoreStemmers = (
  database: CacheDatabase,
  stemmers: Stemmers,
  now: number,
  origin: "owner" | "default" = "owner",
): void => {
  const value = {
    ...parseStemmers(stemmers),
    ...(origin === "default" ? { origin, defaults: DEFAULT_STEMMERS_VERSION } : {}),
  }
  database
    .prepare("INSERT OR REPLACE INTO store_settings (key, value, at) VALUES (?, ?, ?)")
    .run(SETTING, JSON.stringify(value), now)
}

/** Who saved the setting: `undefined` when nothing is saved; a default also says which defaults it was. */
export const stemmersOrigin = (
  database: CacheDatabase,
): { origin: "owner" } | { origin: "default"; defaults: number } | undefined => {
  const row = database.prepare("SELECT value FROM store_settings WHERE key = ?").get(SETTING)
  if (!row) return undefined
  try {
    const value = JSON.parse(String(row.value)) as { origin?: unknown; defaults?: unknown }
    return value.origin === "default"
      ? { origin: "default", defaults: Number(value.defaults) || 0 }
      : { origin: "owner" }
  } catch {
    return { origin: "owner" }
  }
}

/** `undefined` on a file before version 15. */
export const stemsState = (database: CacheDatabase): StemsState | undefined => {
  const row = indexRow(database, INDEX)
  if (!row) return undefined
  const watermark = Number(row.watermark)
  const filledThrough = Number(row.filled_through)
  const pending = Number(database.prepare("SELECT count(*) AS n FROM message_stems_pending").get()?.n)
  const built = row.analyzer === null ? null : String(row.analyzer)
  const stemmers = storeStemmers(database)
  const wanted = stemmers ? analyzerIdentity(stemmers) : UNKNOWN
  // An unclaimed row with nothing to stem is complete: claiming it now would make a first `config set` need a reindex.
  const ready = stemmers !== null && (built === wanted || built === null) && filledThrough >= watermark && pending === 0
  const cause = !stemmers ? "stemmer_unknown" : built !== null && built !== wanted ? "stemmer_changed" : "building"
  return {
    watermark,
    filledThrough,
    pending,
    built,
    wanted,
    ready,
    ...(ready ? {} : { cause }),
    builtAt: row.built_at === null ? null : new Date(Number(row.built_at)).toISOString(),
  }
}

/**
 * Whether this binary may write stems, decided inside the write transaction: an unbuilt row is claimed
 * with its analyzer, a row built by other choices is left alone — so the index never mixes two stemmers.
 */
const claim = (database: CacheDatabase, identity: string): boolean => {
  const built = indexRow(database, INDEX)?.analyzer
  if (built === undefined) return false
  if (built === null) {
    if (savedStemmers(database) === undefined) saveStoreStemmers(database, DEFAULT_STEMMERS, Date.now(), "default")
    database.prepare("UPDATE search_index_state SET analyzer = ? WHERE name = ?").run(identity, INDEX)
    return true
  }
  return built === identity
}

const stemWriter = (database: CacheDatabase, stemmer: Stemmer) => {
  const read = database.prepare(
    `SELECT id AS pk, text, 'c' || chat_id || coalesce(' s' || sender_identity_id, '') AS scope
       FROM messages WHERE id > ? AND id <= ?`,
  )
  const one = database.prepare(
    "SELECT text, 'c' || chat_id || coalesce(' s' || sender_identity_id, '') AS scope FROM messages WHERE id = ?",
  )
  const write = database.prepare("INSERT OR REPLACE INTO message_stems (rowid, stems, scope) VALUES (?, ?, ?)")
  const remove = database.prepare("DELETE FROM message_stems WHERE rowid = ?")
  const dequeue = database.prepare("DELETE FROM message_stems_pending WHERE id = ?")
  const restem = (pk: number, row: Record<string, unknown> | undefined) => {
    const stems = row ? stemmer.indexText(String(row.text)) : ""
    if (stems === "") remove.run(pk)
    else write.run(pk, stems, String(row?.scope))
  }
  return {
    range: (from: number, to: number) => {
      const rows = read.all(from, to)
      for (const row of rows) restem(Number(row.pk), row)
      return rows.length
    },
    queued: (pks: number[]) => {
      for (const pk of pks) {
        restem(pk, one.get(pk))
        dequeue.run(pk)
      }
      return pks.length
    },
  }
}

const nextQueued = (database: CacheDatabase, limit: number): number[] =>
  database
    .prepare("SELECT id AS pk FROM message_stems_pending ORDER BY id LIMIT ?")
    .all(limit)
    .map((row) => Number(row.pk))

/**
 * Stems the messages a store write queued, inside that write's transaction. `stemmerFor` is the store's,
 * so one cache serves every write while the setting stays the same.
 */
export const drainStems = (
  database: CacheDatabase,
  stemmerFor: (stemmers: Stemmers) => Stemmer,
  limit = DRAIN_ON_WRITE,
): number => {
  const pks = nextQueued(database, limit)
  if (pks.length === 0) return 0
  const stemmers = storeStemmers(database)
  if (!stemmers) return 0
  const stemmer = stemmerFor(stemmers)
  return claim(database, stemmer.identity) ? stemWriter(database, stemmer).queued(pks) : 0
}

/** Keeps one stemmer while the setting stays the same, and starts a fresh cache when it changes. */
export const stemmerCache = (): ((stemmers: Stemmers) => Stemmer) => {
  let stemmer: Stemmer | undefined
  return (stemmers) => {
    if (stemmer?.identity !== analyzerIdentity(stemmers)) stemmer = createStemmer(stemmers)
    return stemmer
  }
}

/**
 * Brings the stems towards "ready" in short write transactions: the messages up to the watermark, then
 * the queue. One stemmer per run, so its cache serves every batch. Never rebuilds: a row built by other
 * choices is left for `store migrate` or `store reindex`.
 */
export const fillStems = (
  database: CacheDatabase,
  {
    batch = 5_000,
    until = () => false,
    onBatch,
    now = Date.now,
  }: { batch?: number; until?: () => boolean; onBatch?: (step: string, done: number) => void; now?: () => number } = {},
): StemsFill => {
  const filled: StemsFill = { stemmed: 0, drained: 0 }
  const before = stemsState(database)
  // Every search asks; when all is built, or the row waits for a rebuild, it must not take the write lock.
  const stemmers = storeStemmers(database)
  if (!before || before.ready || before.cause !== "building" || !stemmers) return filled
  const identity = analyzerIdentity(stemmers)
  const stemmer = createStemmer(stemmers)
  const writer = stemWriter(database, stemmer)
  const advance = database.prepare("UPDATE search_index_state SET filled_through = ? WHERE name = ?")
  for (;;) {
    const state = stemsState(database)
    if (!state || state.filledThrough >= state.watermark || until()) break
    const to = Math.min(state.filledThrough + batch, state.watermark)
    const done = inBatch(database, () => {
      if (!claim(database, identity)) return undefined
      const count = writer.range(state.filledThrough, to)
      advance.run(to, INDEX)
      return count
    })
    if (done === undefined) return filled
    filled.stemmed += done
    onBatch?.("stemmed", filled.stemmed)
  }
  for (;;) {
    if (until()) break
    const done = inBatch(database, () => {
      const pks = nextQueued(database, batch)
      return pks.length === 0 || !claim(database, identity) ? 0 : writer.queued(pks)
    })
    if (done === 0) break
    filled.drained += done
    onBatch?.("drained", filled.drained)
  }
  const state = stemsState(database)
  if (state && state.filledThrough >= state.watermark && state.builtAt === null && state.built === identity) {
    database.prepare("UPDATE search_index_state SET built_at = ? WHERE name = ?").run(now(), INDEX)
  }
  return filled
}

const snowballOf = (identity: string): number[] =>
  (/^snowball-(\d+)\.(\d+)\.(\d+)/.exec(identity)?.slice(1) ?? []).map(Number)

const newer = (a: number[], b: number[]): boolean => {
  for (let i = 0; i < 3; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0)
  return false
}

/**
 * Empties the stems and starts them again from the newest message, claimed by the store's setting —
 * for `store reindex`, and for `store migrate` when the stems were built by other choices. A row built
 * by a newer Snowball than this binary has is refused: rebuilding it would downgrade every newer tool.
 */
export const resetStems = (
  database: CacheDatabase,
  { force = false, now = Date.now }: { force?: boolean; now?: () => number } = {},
): boolean => {
  const state = stemsState(database)
  if (!state) return false
  if (!force && state.cause !== "stemmer_changed" && state.cause !== "stemmer_unknown") return false
  if (state.cause === "stemmer_unknown") {
    throw new CliError(
      "validation_error",
      "the store asks for stemmers this tool does not know — upgrade this tool, or choose again with config set searchStemmers.*",
      { reason: "stemmer_unknown" },
    )
  }
  if (state.built !== null && newer(snowballOf(state.built), snowballOf(`snowball-${SNOWBALL_VERSION}`))) {
    throw new CliError(
      "validation_error",
      `the stems were built by Snowball ${snowballOf(state.built).join(".")}, newer than this tool's ${SNOWBALL_VERSION} — upgrade this tool`,
      { reason: "stemmer_newer", built: state.built, wanted: state.wanted },
    )
  }
  inBatch(database, () => {
    // Saved, not defaulted: an older tool with another default then refuses as "unknown" instead of
    // rebuilding the stems back to its own choice on its next reindex.
    if (savedStemmers(database) === undefined) saveStoreStemmers(database, DEFAULT_STEMMERS, now(), "default")
    database.exec(`INSERT INTO ${INDEX} (${INDEX}) VALUES ('delete-all')`)
    database.exec("DELETE FROM message_stems_pending")
    database
      .prepare(
        `UPDATE search_index_state SET watermark = (SELECT coalesce(max(id), 0) FROM messages),
           filled_through = 0, built_at = NULL, analyzer = ? WHERE name = ?`,
      )
      .run(state.wanted, INDEX)
  })
  return true
}

/**
 * Stems an older tool built with its own default, while nobody chose stemmers, start again with this
 * build's default: nobody chose the old one, so it waits for no `store reindex`. Like a first fill
 * from then on. A saved default is replaced only by newer defaults, so two versions never rebuild each
 * other's. A row a newer Snowball built is left for an upgrade.
 */
export const followDefaultStemmers = (database: CacheDatabase, now: () => number = Date.now): boolean => {
  const saved = stemmersOrigin(database)
  if (saved?.origin === "owner") return false
  if (saved?.origin === "default") {
    if (saved.defaults >= DEFAULT_STEMMERS_VERSION || savedStemmers(database) === null) return false
    const built = stemsState(database)?.built
    if (built && newer(snowballOf(built), snowballOf(`snowball-${SNOWBALL_VERSION}`))) return false
    saveStoreStemmers(database, DEFAULT_STEMMERS, now(), "default")
  }
  const state = stemsState(database)
  if (state?.cause !== "stemmer_changed" || state.built === null) return false
  if (newer(snowballOf(state.built), snowballOf(`snowball-${SNOWBALL_VERSION}`))) return false
  return resetStems(database, { now })
}
