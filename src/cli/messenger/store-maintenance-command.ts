import {
  chmodSync,
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statfsSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { dirname, resolve } from "node:path"
import { CliError } from "@wirecat/cli-core"
import { Command } from "commander"
import { holdersOf } from "../../background/processes.js"
import { RULES_VERSION } from "../../conversations/link.js"
import { isSealed, sealFile, unsealFile } from "../../sealed.js"
import type { CacheDatabase } from "../../store/driver.js"
import { MIGRATIONS, migrate } from "../../store/migrations.js"
import { openCache } from "../../store/open.js"
import { storePath } from "../../store/path.js"
import { deleteCopy, type RepairReport, repairStore } from "../../store/repair.js"
import { resetAttachmentWords } from "../../store/sqlite/attachment-texts.js"
import { pendingNormalization } from "../../store/sqlite/backfill.js"
import { involvementStoreOver } from "../../store/sqlite/involvements.js"
import { drainNoteIndex, noteIndexState, resetNoteIndex } from "../../store/sqlite/note-index.js"
import { fillSearchIndex, resetSearchIndex, searchIndexState } from "../../store/sqlite/search-index.js"
import { fillStems, resetStems, stemmerCache, stemsState } from "../../store/sqlite/stems.js"
import { openStore } from "../../store/store.js"
import { environmentOf, outputFor } from "../context.js"
import { answerOf } from "./ask.js"
import type { Messenger } from "./context.js"
import { ENCRYPT_OPTION, passwordOf } from "./password.js"
import { servingProfiles } from "./serve-command.js"

const SPEAKS = MIGRATIONS.at(-1)?.version ?? 0
const SEARCH_INDEXES = ["messages_fts", "chats_fts", "identities_fts"]
/** Contentless: it has no table to be compared with, only its own structure to check. */
const WORD_INDEX = "message_words"

/** An empty file is normal: `openStore` creates it before the first migration runs. */
const schemaOf = (database: CacheDatabase) => {
  const tracked = database.prepare("SELECT 1 FROM sqlite_master WHERE name = 'schema_migrations'").get()
  const row = tracked
    ? database.prepare("SELECT version, min_compatible FROM schema_migrations ORDER BY version DESC LIMIT 1").get()
    : undefined
  const version = Number(row?.version ?? 0)
  const minCompatible = Number(row?.min_compatible ?? 0)
  return { version, minCompatible, writable: version <= SPEAKS || minCompatible <= SPEAKS }
}

const count = (database: CacheDatabase, table: string) =>
  Number(database.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.n ?? 0)

/** Before version 6 the column does not exist, and a file behind this build is not migrated here. */
const pendingIfKnown = (database: CacheDatabase): number | null =>
  database.prepare("SELECT 1 FROM pragma_table_info('messages') WHERE name = 'normalized_text'").get()
    ? pendingNormalization(database)
    : null

const bytesOf = (path: string) => (existsSync(path) ? statSync(path).size : 0)

/** Opens the file as it is. Migrating here would change what the caller asked to look at. */
const reading = async <T>(path: string, read: (database: CacheDatabase) => T): Promise<T> => {
  const database = await openCache(path)
  try {
    return read(database)
  } finally {
    database.close()
  }
}

/** `doctor`'s short summary of the store. Must answer for a broken file, so an error is a field. */
export const storeSummary = async (env: NodeJS.ProcessEnv) => {
  const path = storePath(env)
  if (!existsSync(path)) return { path, exists: false }
  try {
    return await reading(path, (database) => {
      const { version, writable } = schemaOf(database)
      return {
        path,
        exists: true,
        schema: version,
        speaks: SPEAKS,
        writable,
        ...(version > 0 ? { chats: count(database, "chats"), messages: count(database, "messages") } : {}),
      }
    })
  } catch (error) {
    return { path, exists: true, error: messageOf(error) }
  }
}

export const storeMaintenanceCommands = (messenger: Messenger): Command[] => [
  infoCommand(),
  checkCommand(messenger),
  migrateCommand(messenger),
  reindexCommand(messenger),
  backupCommand(),
  restoreCommand(messenger),
  decryptCommand(),
  repairCommand(messenger),
  resetCommand(messenger),
  copiesCommand(),
]

/** Renaming tables under a running `serve` would pull them from under its statements. */
const refuseWhileServing = (command: Command, messenger: Messenger) => {
  const serving = servingProfiles(messenger.app, environmentOf(command).env ?? process.env)
  if (serving.length > 0) {
    throw new CliError(
      "validation_error",
      `${messenger.app.command} serve is running for ${serving.join(", ")} — \`${messenger.app.command} server stop\` first`,
    )
  }
}

const repairCommand = (messenger: Messenger): Command =>
  new Command("repair")
    .description(
      "bring every table to this build's shape, deleting nothing: a table of the wrong shape is kept as a copy beside a new one",
    )
    .option("--dry-run", "say what it would do, and change nothing")
    .action(async function (this: Command) {
      const { renderer, format } = outputFor(this)
      const { dryRun } = this.opts<{ dryRun?: boolean }>()
      const path = storePath(environmentOf(this).env ?? process.env)
      if (!existsSync(path)) {
        renderer.result({ path, exists: false })
        return
      }
      if (!dryRun) refuseWhileServing(this, messenger)
      const fresh = await openCache(":memory:")
      try {
        const report = await reading(path, (database) => repairStore(database, fresh, { dryRun: dryRun === true }))
        renderer.result({ path, ...report })
        if (format === "pretty") for (const note of notesOf(report, messenger.app.command)) renderer.note(note)
      } finally {
        fresh.close()
      }
    })

const notesOf = (report: RepairReport, command: string): string[] => {
  const will = report.dryRun ? "would be" : "was"
  const notes = report.repaired.map((one) => {
    if (one.action === "created") return `${one.table}: ${will} created`
    if (one.action === "columns-added") return `${one.table}: ${one.columnsAdded?.join(", ")} ${will} added`
    const left = (one.rowsInCopy ?? 0) - (one.rowsCopied ?? 0)
    return (
      `${one.table}: ${will} rebuilt; the old one is kept as ${one.copy}, ${one.rowsCopied} of ${one.rowsInCopy} rows copied` +
      (left > 0 ? ` — ${left} did not fit the new shape and are only in the copy` : "") +
      (one.onlyInCopy?.length ? `; columns only in the copy: ${one.onlyInCopy.join(", ")}` : "")
    )
  })
  if (report.repaired.length === 0) notes.push("every table already has this build's shape")
  for (const { table, what } of report.mismatches) notes.push(`${table}: ${what} — left for you to decide`)
  for (const { table, rows } of report.foreignKeyViolations)
    notes.push(`${table}: ${rows} rows point at a row that is not there`)
  if (report.copies.length > 0) {
    notes.push(
      `copies kept: ${report.copies.map((one) => `${one.name} (${one.rows} rows)`).join(", ")} — ` +
        `\`${command} store copies delete <name>\` deletes one once you have looked at it`,
    )
  }
  return notes
}

const copiesCommand = (): Command =>
  new Command("copies").description("the tables `store repair` kept as copies").addCommand(
    new Command("delete")
      .description("delete one copy `store repair` kept, named exactly; refuses any other table")
      .argument("<name>", "the copy's name, as `store repair` printed it")
      .action(async function (this: Command, name: string) {
        const { renderer } = outputFor(this)
        const path = storePath(environmentOf(this).env ?? process.env)
        if (!existsSync(path)) throw new CliError("not_found", `no store at ${path}`)
        const deleted = await reading(path, (database) => deleteCopy(database, name))
        renderer.result({ path, deleted })
      }),
  )

const infoCommand = (): Command =>
  new Command("info")
    .description("the store file: where it is, its size, its schema and how many rows it holds; changes nothing")
    .action(async function (this: Command) {
      const { renderer } = outputFor(this)
      const path = storePath(environmentOf(this).env ?? process.env)
      if (!existsSync(path)) {
        renderer.result({ path, exists: false })
        return
      }
      const read = reading(path, (database) => {
        const { version, minCompatible, writable } = schemaOf(database)
        const tables = ["accounts", "chats", "messages", "attachments", "identities"]
        return {
          path,
          exists: true,
          bytes: { file: bytesOf(path), wal: bytesOf(`${path}-wal`) },
          schema: { version, minCompatible, speaks: SPEAKS, writable },
          rows: version > 0 ? Object.fromEntries(tables.map((table) => [table, count(database, table)])) : {},
          pendingNormalization: pendingIfKnown(database),
          wordIndex: searchIndexState(database) ?? null,
          stemIndex: stemsState(database) ?? null,
        }
      })
      renderer.result(await read.catch((error) => ({ path, exists: true, opens: false, error: messageOf(error) })))
    })

/**
 * Reports and never repairs. The per-chat completeness is what tells "nothing was said" from "not
 * fetched" (NEED-399 A). Times are the chat's newest message by the messenger's list against the
 * newest message held, not `sync_ranges`: those are in message ids, which a chat list does not give.
 */
const checkCommand = (messenger: Messenger): Command =>
  new Command("check")
    .description("whether the store is healthy — integrity, search indexes, disk, and which chats are behind")
    .action(async function (this: Command) {
      const { renderer } = outputFor(this)
      const path = storePath(environmentOf(this).env ?? process.env)
      if (!existsSync(path)) {
        renderer.result({ path, exists: false, ok: true })
        return
      }
      let answer: Awaited<ReturnType<typeof inspect>>
      try {
        answer = await inspect(path)
      } catch (error) {
        renderer.result({ path, exists: true, ok: false, opens: false, error: messageOf(error) })
        return
      }
      renderer.result(answer)
      const { command } = messenger.app
      if (answer.schema.version < SPEAKS) {
        renderer.note(
          `the file is behind this build — a copy first, \`${command} store backup <file>\`, then \`${command} store migrate\``,
        )
      }
      if (answer.pendingNormalization) {
        renderer.note(`${answer.pendingNormalization} messages wait for normalization — \`${command} store migrate\``)
      }
      const words = answer.wordIndex
      if (words && words.filledThrough < words.watermark) {
        renderer.note(
          `the word index reaches message ${words.filledThrough} of ${words.watermark} — \`${command} store migrate\` finishes it`,
        )
      }
      const stems = answer.stemIndex
      if (stems?.cause === "stemmer_changed") {
        renderer.note(
          `the stems were built by ${stems.built}, the store asks for ${stems.wanted} — \`${command} store reindex\``,
        )
      } else if (stems && !stems.ready) {
        renderer.note(
          `the stems reach message ${stems.filledThrough} of ${stems.watermark}, ${stems.pending} queued — \`${command} store migrate\` finishes them`,
        )
      }
      const ours = answer.chatsBehind.filter((chat) => chat.provider === messenger.provider).length
      if (ours > 0)
        renderer.note(`${ours} chats hold less than their newest message — \`${command} store fetch <chat>\``)
      const older = answer.conversations.filter((chat) => chat.provider === messenger.provider && !chat.current).length
      if (older > 0) {
        renderer.note(
          `${older} chats' conversations were built by older rules — \`${command} conversations build --chat <chat>\``,
        )
      }
    })

const inspect = (path: string) =>
  reading(path, (database) => {
    const schema = schemaOf(database)
    const integrity = database
      .prepare("PRAGMA quick_check(20)")
      .all()
      .map((row) => String(row.quick_check))
    const foreignKeys = database.prepare("PRAGMA foreign_key_check").all().length
    const wordIndex = searchIndexState(database)
    const stems = stemsState(database)
    const searchIndexes = Object.fromEntries([
      ...(schema.version > 0 ? SEARCH_INDEXES.map((index) => [index, indexIntegrity(database, index)]) : []),
      ...(wordIndex ? [[WORD_INDEX, indexIntegrity(database, WORD_INDEX, 0)]] : []),
      ...(stems ? [["message_stems", indexIntegrity(database, "message_stems", 0)]] : []),
      ...(schema.version > 0 ? [["attachment_words", indexIntegrity(database, "attachment_words", 0)]] : []),
    ])
    const size = bytesOf(path) + bytesOf(`${path}-wal`)
    const { bavail, bsize } = statfsSync(dirname(path))
    const free = Number(bavail) * Number(bsize)
    const behind = schema.version > 0 ? chatsBehind(database) : []
    const checks = {
      schema: schema.version === SPEAKS,
      integrity: integrity.length === 1 && integrity[0] === "ok",
      foreignKeys: foreignKeys === 0,
      searchIndexes: Object.values(searchIndexes).every((state) => state === "ok"),
      // A backup or a VACUUM needs about as much again.
      disk: free >= size,
    }
    return {
      path,
      exists: true,
      opens: true,
      ok: Object.values(checks).every(Boolean),
      checks,
      schema: { ...schema, speaks: SPEAKS },
      integrity,
      foreignKeyViolations: foreignKeys,
      searchIndexes,
      disk: { free, needed: size },
      pendingNormalization: pendingIfKnown(database),
      wordIndex: wordIndex ?? null,
      stemIndex: stems ?? null,
      chatsBehind: behind,
      conversations: conversationsBuilt(database),
      vectors: vectorsHeld(database),
      notApplicable: { extensions: "SQLite needs none" },
    }
  })

/** `rank = 1` compares the index with its table; without it a stale external-content index passes. */
const indexIntegrity = (database: CacheDatabase, index: string, rank = 1): string => {
  try {
    database.prepare(`INSERT INTO ${index} (${index}, rank) VALUES ('integrity-check', ${rank})`).run()
    return "ok"
  } catch (error) {
    return messageOf(error)
  }
}

/**
 * Vectors per model, and how many no chunk of any build points at any more — a rebuild that changed a
 * conversation's text leaves its old vector behind until `conversations embed clear` (phase 5).
 */
const vectorsHeld = (database: CacheDatabase) => {
  const exists = database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'embeddings'").get()
  if (!exists) return null
  const models = Object.fromEntries(
    database
      .prepare("SELECT model, count(*) AS n FROM embeddings GROUP BY model ORDER BY model")
      .all()
      .map((row) => [String(row.model), Number(row.n)]),
  )
  const unused = database
    .prepare(
      `SELECT count(*) AS n FROM embeddings v
       WHERE NOT EXISTS (SELECT 1 FROM chunks k WHERE k.content_hash = v.content_hash)`,
    )
    .get()
  return { models, unused: Number(unused?.n ?? 0) }
}

/**
 * Per chat whose conversations were built: by which rules, whether those are this build's, and how many
 * of the agent's links went stale — their message changed after they were written (phase 3 plan C4).
 */
const conversationsBuilt = (database: CacheDatabase) => {
  const exists = database
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'conversation_state'")
    .get()
  if (!exists) return []
  return database
    .prepare(
      `SELECT a.provider, a.external_id AS account, c.external_id AS chat, c.title, s.built_at, s.algorithm_version,
         (SELECT count(*) FROM message_links l WHERE l.chat_id = c.id AND l.source = 'agent' AND l.stale_at IS NOT NULL)
           AS stale
       FROM conversation_state s JOIN chats c ON c.id = s.chat_id JOIN accounts a ON a.id = c.account_id
       ORDER BY s.built_at DESC`,
    )
    .all()
    .map((row) => ({
      provider: String(row.provider),
      account: String(row.account),
      chat: String(row.chat),
      title: row.title === null ? null : String(row.title),
      builtAt: row.built_at === null ? null : isoOf(row.built_at),
      rulesVersion: row.algorithm_version === null ? null : Number(row.algorithm_version),
      current: Number(row.algorithm_version) === RULES_VERSION,
      staleAgentLinks: Number(row.stale),
    }))
}

const chatsBehind = (database: CacheDatabase) =>
  database
    .prepare(
      `SELECT a.provider, a.external_id AS account, c.external_id AS chat, c.title, c.last_message_at AS newest,
         (SELECT max(m.sent_at) FROM messages m WHERE m.chat_id = c.id) AS held, c.updated_at AS refreshed
       FROM chats c JOIN accounts a ON a.id = c.account_id
       WHERE c.last_message_at IS NOT NULL
       ORDER BY c.last_message_at DESC`,
    )
    .all()
    .filter((row) => row.held === null || Number(row.held) < Number(row.newest))
    .map((row) => ({
      provider: String(row.provider),
      account: String(row.account),
      chat: String(row.chat),
      title: row.title === null ? null : String(row.title),
      newest: isoOf(row.newest),
      held: row.held === null ? null : isoOf(row.held),
      refreshed: isoOf(row.refreshed),
    }))

const migrateCommand = (messenger: Messenger): Command =>
  new Command("migrate")
    .description(
      "bring the store up to this build's schema, then normalize, index and stem the messages and notes stored before it",
    )
    .action(async function (this: Command) {
      const { renderer } = outputFor(this)
      const path = storePath(environmentOf(this).env ?? process.env)
      if (!existsSync(path)) {
        renderer.result({ path, exists: false })
        renderer.note(`no store yet — the first \`${messenger.app.command}\` command that reads a chat creates it`)
        return
      }
      const answer = await reading(path, (database) => {
        const from = schemaOf(database).version
        migrate(database, { command: messenger.app.command })
        const { normalized, indexed, terms } = buildWordIndex(database, (note) => renderer.note(note))
        const stemmed = buildStems(database, (note) => renderer.note(note))
        const notes = buildNoteIndex(database, (note) => renderer.note(note))
        return {
          path,
          exists: true,
          from,
          to: schemaOf(database).version,
          normalized,
          indexed,
          terms,
          ...stemmed,
          ...notes,
        }
      })
      renderer.result(answer)
    })

/** Normalizes, indexes and builds the typo vocabulary, saying how far each has gone. */
const buildWordIndex = (database: CacheDatabase, note: (text: string) => void) => {
  const state = searchIndexState(database)
  const pending = pendingNormalization(database)
  if (pending > 0) note(`normalizing ${pending} messages, in batches; stopping loses nothing`)
  if (state && state.filledThrough < state.watermark) note(`indexing words up to message ${state.watermark}`)
  return fillSearchIndex(database, {
    onBatch: (step, done) => note(step === "normalized" ? `${done} of ${pending} normalized` : `${done} ${step}`),
  })
}

/**
 * Stems what is left, after rebuilding stems made by other stemmer choices than the store's setting —
 * only here and in `store reindex`, never in a search's quick fill.
 */
const buildStems = (database: CacheDatabase, note: (text: string) => void, { force = false } = {}) => {
  const before = stemsState(database)
  if (!before) return { stemmed: 0 }
  if (resetStems(database, { force }) && before.built !== null) {
    note(`stems were built by ${before.built} — rebuilding them with ${before.wanted}`)
  }
  const state = stemsState(database)
  if (state && state.filledThrough < state.watermark) note(`stemming up to message ${state.watermark}`)
  const { stemmed, drained } = fillStems(database, { onBatch: (step, done) => note(`${done} ${step}`) })
  return { stemmed: stemmed + drained }
}

/** Indexes the notes written since — all of them after `store reindex` queued them again. */
const buildNoteIndex = (database: CacheDatabase, note: (text: string) => void, { reset = false } = {}) => {
  if (reset) resetNoteIndex(database)
  const pending = noteIndexState(database)?.pending ?? 0
  if (pending > 0) note(`indexing ${pending} notes`)
  return { notesIndexed: drainNoteIndex(database, stemmerCache()) }
}

const reindexCommand = (messenger: Messenger): Command =>
  new Command("reindex")
    .description(
      "rebuild the word index, its typo vocabulary, the stems, the files' word index, the notes' indexes and who took part in what, from what is stored; loses nothing",
    )
    .action(async function (this: Command) {
      const { renderer } = outputFor(this)
      const path = storePath(environmentOf(this).env ?? process.env)
      if (!existsSync(path)) {
        renderer.result({ path, exists: false })
        return
      }
      const answer = await reading(path, (database) => {
        const schema = schemaOf(database)
        if (!schema.writable) {
          throw new CliError(
            "configuration_error",
            `the message store was written by a newer version (schema ${schema.version}, needs at least ` +
              `${schema.minCompatible}; this one speaks ${SPEAKS}) — upgrade this tool`,
          )
        }
        if (schema.version < SPEAKS) {
          throw new CliError(
            "validation_error",
            `the store is behind this build — \`${messenger.app.command} store migrate\` first`,
          )
        }
        resetSearchIndex(database)
        const fileTexts = resetAttachmentWords(database)
        const words = buildWordIndex(database, (note) => renderer.note(note))
        return {
          path,
          exists: true,
          ...words,
          fileTexts,
          ...buildStems(database, (note) => renderer.note(note), { force: true }),
          ...buildNoteIndex(database, (note) => renderer.note(note), { reset: true }),
          involvements: involvementStoreOver({ database, now: Date.now }).rebuild(),
        }
      })
      renderer.result(answer)
    })

/** A consistent copy of a store that may be in use. Never overwrites a file. */
const vacuumInto = async (path: string, target: string) => {
  // VACUUM INTO fills an empty file and keeps its mode; a file it creates itself is readable by all.
  writeFileSync(target, "", { flag: "wx", mode: 0o600 })
  try {
    await reading(path, (database) => database.prepare("VACUUM INTO ?").run(target))
  } catch (error) {
    rmSync(target, { force: true })
    throw error
  }
}

const stampNow = () => new Date().toISOString().replace(/[:.]/g, "-")

const backupCommand = (): Command =>
  new Command("backup")
    .description("copy the store into a new file, while it is in use; never overwrites a file")
    .argument("<file>", "the new file")
    .option(...ENCRYPT_OPTION)
    .action(async function (this: Command, file: string) {
      const { renderer } = outputFor(this)
      const { encrypt } = this.opts<{ encrypt?: boolean }>()
      const path = storePath(environmentOf(this).env ?? process.env)
      const target = resolve(file)
      if (!existsSync(path)) throw new CliError("not_found", `no store at ${path} to back up`)
      if (existsSync(target))
        throw new CliError("validation_error", `${target} exists — a backup never overwrites a file`)
      const password = encrypt ? await passwordOf(this, { twice: true }) : undefined
      // SQLite copies only into a file. Sealed, that plain copy goes beside the store, which holds the
      // same text already — never beside the target, which may be a synced folder or a removable disk.
      const copyAt = password === undefined ? target : `${path}.backup-${process.pid}`
      await vacuumInto(path, copyAt)
      try {
        const copy = await reading(copyAt, (database) => ({
          schema: schemaOf(database),
          rows: { chats: count(database, "chats"), messages: count(database, "messages") },
        }))
        if (password !== undefined) await sealFile(copyAt, target, password)
        renderer.result({
          path: target,
          from: path,
          bytes: bytesOf(target),
          schema: copy.schema.version,
          rows: copy.rows,
          ...(password === undefined ? {} : { encrypted: true }),
        })
      } catch (error) {
        if (password === undefined) rmSync(target, { force: true })
        throw error
      } finally {
        if (password !== undefined) rmSync(copyAt, { force: true })
      }
    })

/** The only way back into a sealed file: the format is this tool's own. */
const decryptCommand = (): Command =>
  new Command("decrypt")
    .description("open a file written with --encrypt into a new file; asks for its password")
    .argument("<file>", "a file `store backup --encrypt` or `store export --encrypt` wrote")
    .requiredOption("--output <file>", "the new file, readable only by you")
    .action(async function (this: Command, file: string) {
      const { renderer } = outputFor(this)
      const { output } = this.opts<{ output: string }>()
      const from = resolve(file)
      const to = resolve(output)
      if (!existsSync(from)) throw new CliError("not_found", `no file at ${from}`)
      if (!isSealed(from)) throw new CliError("validation_error", `${from} was not written with --encrypt`)
      if (existsSync(to)) throw new CliError("validation_error", `${to} exists — never overwritten`)
      await unsealFile(from, to, await passwordOf(this, { twice: false }))
      renderer.result({ path: to, from, bytes: bytesOf(to) })
    })

/**
 * Puts a backup in place of the store, keeping the store it replaces beside it. Refuses while any
 * process has the file open — it would go on writing to the file set aside — or while this CLI's
 * `serve` runs: that opens the store on its first write, so until then it holds nothing to see.
 */
const restoreCommand = (messenger: Messenger): Command =>
  new Command("restore")
    .description("put a backup in place of the store; the store it replaces is kept beside it, never deleted")
    .argument("<file>", "a file `store backup` wrote; one written with --encrypt asks for its password")
    .action(async function (this: Command, file: string) {
      const path = storePath(environmentOf(this).env ?? process.env)
      const given = resolve(file)
      if (!existsSync(given)) throw new CliError("not_found", `no file at ${given}`)
      const serving = servingProfiles(messenger.app, environmentOf(this).env ?? process.env)
      if (serving.length > 0) {
        throw new CliError(
          "validation_error",
          `${messenger.app.command} serve is running for ${serving.join(", ")} — \`${messenger.app.command} server stop\` first`,
        )
      }
      if (!isSealed(given)) return restoreFrom(this, messenger, given, given)
      const opened = `${path}.unsealing-${process.pid}`
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
      try {
        await unsealFile(given, opened, await passwordOf(this, { twice: false }))
        await restoreFrom(this, messenger, opened, given)
      } finally {
        rmSync(opened, { force: true })
      }
    })

const restoreFrom = async (command: Command, messenger: Messenger, backup: string, given: string) => {
  const { renderer } = outputFor(command)
  const path = storePath(environmentOf(command).env ?? process.env)
  if (existsSync(path) && realpathSync(backup) === realpathSync(path)) {
    throw new CliError("validation_error", `${backup} is the store itself`)
  }
  const schema = await backupSchema(backup)

  const stamp = stampNow()
  const kept = existsSync(path) ? `${path}.before-restore-${stamp}` : null
  if (kept) await quiesce(path, messenger, "restore", (message) => renderer.warn(message))
  else mkdirSync(dirname(path), { recursive: true, mode: 0o700 })

  const incoming = `${path}.restoring-${stamp}`
  copyFileSync(backup, incoming, constants.COPYFILE_EXCL)
  chmodSync(incoming, 0o600)
  if (kept) {
    renameSync(path, kept)
    for (const suffix of ["-wal", "-shm"])
      if (existsSync(`${path}${suffix}`)) renameSync(`${path}${suffix}`, `${kept}${suffix}`)
  }
  renameSync(incoming, path)

  renderer.result({ path, restoredFrom: given, keptAt: kept, schema: schema.version })
  if (kept) renderer.note(`the store it replaced is kept at ${kept}`)
  // One that has not touched the store yet holds nothing open, and was not seen.
  renderer.note("restart every serve and mcp of either CLI that was running, so they read the restored store")
  if (schema.version < SPEAKS) {
    renderer.note(
      `the backup is behind this build; the next command migrates it — \`${messenger.app.command} store migrate\` now`,
    )
  }
}

const backupSchema = async (backup: string) => {
  let read: { integrity: string; schema: ReturnType<typeof schemaOf> }
  try {
    read = await reading(backup, (database) => ({
      integrity: String(database.prepare("PRAGMA quick_check(1)").get()?.quick_check),
      schema: schemaOf(database),
    }))
  } catch (error) {
    throw new CliError("validation_error", `${backup} is not a store this tool can read: ${messageOf(error)}`)
  }
  const { integrity, schema } = read
  if (schema.version === 0) throw new CliError("validation_error", `${backup} holds no message store`)
  if (integrity !== "ok") throw new CliError("validation_error", `${backup} is damaged: ${integrity}`)
  if (!schema.writable) {
    throw new CliError(
      "configuration_error",
      `the backup was written by a newer version (schema ${schema.version}, needs at least ` +
        `${schema.minCompatible}; this one speaks ${SPEAKS}) — upgrade this tool`,
    )
  }
  return schema
}

/**
 * No other process has the file open, no write is under way, and the write-ahead log is folded in,
 * so the file set aside is whole on its own. In WAL mode SQLite cannot say who has the file open —
 * `EXCLUSIVE` behaves as `IMMEDIATE` — so that is asked of the system.
 */
const quiesce = async (path: string, messenger: Messenger, then: string, warn: (message: string) => void) => {
  const { command } = messenger.app
  const files = [path, `${path}-wal`, `${path}-shm`]
    .filter((file) => existsSync(file))
    .map((file) => realpathSync(file))
  const holders = holdersOf(files)
  if (holders === undefined) {
    warn(`this system cannot say which processes have the store open — restart every running serve and mcp after this`)
  } else if (holders.length > 0) {
    throw new CliError(
      "validation_error",
      `the store is open in process ${holders.join(", ")} — stop it first (a serve: \`${command} server stop\`, ` +
        `or the other CLI's; an mcp: its client), then ${then}`,
    )
  }
  const database = await openCache(path)
  try {
    database.exec("PRAGMA busy_timeout = 1000")
    database.exec("PRAGMA wal_checkpoint(TRUNCATE)")
    try {
      database.exec("BEGIN IMMEDIATE")
    } catch {
      throw new CliError("validation_error", "a write to the store is under way — try again in a moment")
    }
    database.exec("ROLLBACK")
  } finally {
    database.close()
  }
}

/**
 * For a store this build cannot migrate: a backup beside it, then an empty store at this build's
 * schema. The backup is made before anything is deleted, and its path is said before the delete.
 */
const resetCommand = (messenger: Messenger): Command =>
  new Command("reset")
    .description(
      "back the store up beside itself, then delete it and start an empty one at this build's schema; asks first, or --yes",
    )
    .option("--no-backup", "delete the store without backing it up first")
    .action(async function (this: Command, { backup: keep }: { backup: boolean }) {
      const { renderer } = outputFor(this)
      const { command } = messenger.app
      const path = storePath(environmentOf(this).env ?? process.env)
      if (!existsSync(path)) {
        renderer.result({ path, exists: false, reset: false })
        renderer.note(
          `no store at ${path} — nothing to reset; the first \`${command}\` command that reads a chat creates it`,
        )
        return
      }
      refuseWhileServing(this, messenger)
      if (this.optsWithGlobals<{ yes?: boolean }>().yes !== true) {
        const what = `this deletes the store at ${path} and starts an empty one, ${keep ? "after a backup beside it" : "with no backup"}`
        const answer = await answerOf(this, `${what}. Go ahead? [y/N] `)
        if (answer === null) throw new CliError("confirmation_required", `${what} — add --yes to go ahead`)
        if (!/^\s*y(es)?\s*$/i.test(answer)) throw new CliError("cancelled", "cancelled — the store is unchanged")
      }
      await quiesce(path, messenger, "reset", (message) => renderer.warn(message))

      const backup = keep ? `${path}.backup-${stampNow()}` : null
      let backedUp = null
      if (backup) {
        try {
          await vacuumInto(path, backup)
        } catch (error) {
          throw new CliError(
            "validation_error",
            `could not back the store up, so it was not reset: ${messageOf(error)}`,
          )
        }
        backedUp = await reading(backup, (database) => {
          const schema = schemaOf(database).version
          return {
            schema,
            rows: schema > 0 ? { chats: count(database, "chats"), messages: count(database, "messages") } : {},
          }
        })
        renderer.note(`backed the store up to ${backup}`)
      }

      for (const suffix of ["", "-wal", "-shm"]) rmSync(`${path}${suffix}`, { force: true })
      await (await openStore({ path, command })).close()
      const schema = await reading(path, (database) => schemaOf(database).version)

      renderer.result({ path, exists: true, reset: true, backup, backedUp, schema })
      renderer.note(
        backup
          ? `the store is empty at schema ${schema}; \`${command} store restore ${backup}\` puts the old one back once a build can read it`
          : `the store is empty at schema ${schema}; there is no backup`,
      )
    })

const isoOf = (value: unknown) => new Date(Number(value)).toISOString()

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))
