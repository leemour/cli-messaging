import { CliError } from "@wirecat/cli-core"
import { canonicalReference, parseReference } from "../../domain/references.js"
import { normalizeTag } from "../../domain/tags.js"
import type { CacheDatabase, CacheStatement } from "../driver.js"
import { fold } from "../normalize.js"
import { ulid } from "../ulid.js"
import { ownerPerson } from "./actors.js"
import { atomic } from "./atomic.js"
import { LINK_KINDS, linkKind } from "./link-kinds.js"
import type { NoteSearch } from "./note-search.js"
import type { StoreContext } from "./open.js"
import { addTags, ensureTag, type Label, labelsOf } from "./tags.js"
import { referenceOfThing, storedThing, type Thing, thingOf } from "./things.js"

export const NOTE_FORMATS = ["obsidian", "markdown"] as const
export const LINK_ORIGINS = ["file", "owner", "suggested"] as const

/** A notes folder: an `accounts` row of provider `folder`. Where it is on disk is this computer's config. */
export interface NoteFolder {
  id: string
  name: string
  format: (typeof NOTE_FORMATS)[number]
  createdAt: string
}

/**
 * A file in a notes folder (a `documents` row, `source` file) or a note the owner wrote (a `notes` row,
 * `source` internal). Their ids overlap, so `ref` — `document:<id>` or `note:<id>` — is what names one.
 */
export interface Note {
  id: string
  ref: string
  source: "file" | "internal"
  folderId: string | null
  path: string | null
  title: string | null
  text: string
  frontMatter: unknown
  contentHash: string | null
  revision: number
  exportPath: string | null
  createdAt: string
  updatedAt: string
  deletedAt: string | null
}

export interface Link {
  id: string
  from: string
  /** `null` while the link names nobody the store knows, or more than one. */
  to: string | null
  kind: (typeof LINK_KINDS)[number]
  anchor: string | null
  origin: (typeof LINK_ORIGINS)[number]
  targetText: string | null
  role: string | null
  evidence: string | null
  provenance: string | null
  confirmed: boolean
  createdAt: string
}

export interface LinkInput {
  from: string
  to?: string
  targetText?: string
  kind: Link["kind"]
  anchor?: string
  origin?: Link["origin"]
  role?: string
  evidence?: string
  provenance?: string
  confirmed?: boolean
}

export interface FileNoteInput {
  folderId: string
  path: string
  title: string | null
  text: string
  frontMatter?: unknown
  contentHash?: string | null
}

export type NoteTag = Label

export interface NotesStore extends NoteSearch {
  addFolder(input: { name: string; format?: NoteFolder["format"] }): Promise<NoteFolder>
  folders(): Promise<NoteFolder[]>
  saveFileNote(input: FileNoteInput): Promise<{ note: Note; changed: boolean }>
  /** Moves a file note to a new path in its folder, keeping its id, links and tags; a gone note at `to` is dropped. */
  renameFileNote(folderId: string, from: string, to: string): Promise<Note>
  /** Marks the folder's notes at these paths deleted; answers how many were live. */
  deleteFileNotes(folderId: string, paths: string[]): Promise<number>
  /** A note about the things named, the first of them its subject; about nothing, a note to self. */
  addNote(input: { text: string; title?: string; about?: string[] }): Promise<Note>
  /** By reference (`note:12`, `document:5`); a bare id is a note's. */
  note(reference: string): Promise<Note>
  resolveNote(reference: string): Promise<Note | undefined>
  noteReferences(reference: string): Promise<string[]>
  notes(options?: {
    folderId?: string
    source?: Note["source"]
    about?: string
    search?: string
    limit?: number
    offset?: number
  }): Promise<{ items: Note[]; hasMore: boolean }>
  editNote(id: string, text: string, revision: number): Promise<Note>
  removeNote(id: string): Promise<{ id: string; removed: true }>
  addLink(input: LinkInput): Promise<Link>
  links(options?: { from?: string; to?: string; unresolved?: boolean }): Promise<Link[]>
  removeLink(id: string): Promise<{ id: string; removed: true }>
  /** The links a file states, replacing what its last import stated; links the owner added stay. */
  replaceFileLinks(documentId: string, links: Omit<LinkInput, "from" | "origin">[]): Promise<Link[]>
  /**
   * The tags a file states, replacing what its last import stated. A tag the owner added stays, even when
   * the file stops stating it; a file tag the owner also added becomes the owner's.
   */
  replaceFileTags(documentId: string, tags: string[]): Promise<NoteTag[]>
  noteTags(reference: string): Promise<NoteTag[]>
  /** Tries every unresolved link against the people known now; answers how many it resolved. */
  resolveLinks(): Promise<number>
}

type Row = Record<string, unknown>
const iso = (value: unknown) => new Date(Number(value)).toISOString()
const optionalIso = (value: unknown) => (value == null ? null : iso(value))

const textOf = (text: string, what: string, max = 100_000, allowEmpty = false) => {
  const value = text.trim()
  if ((!value && !allowEmpty) || value.length > max)
    throw new CliError("validation_error", `${what} takes ${allowEmpty ? 0 : 1}–${max} characters`)
  return value
}

const oneOf = <T extends string>(value: string, allowed: readonly T[], what: string): T => {
  if (!allowed.includes(value as T)) throw new CliError("validation_error", `${what} is one of ${allowed.join(", ")}`)
  return value as T
}

/** What a link's written target is matched by: case, accents and a leading `@` do not count. */
export const targetKey = (text: string): string => fold(text).trim().replace(/^@/, "")

export const documentOf = (row: Row): Note => ({
  id: String(row.id),
  ref: `document:${row.id}`,
  source: "file",
  folderId: String(row.account_id),
  path: String(row.external_id),
  title: row.title == null ? null : String(row.title),
  text: String(row.body ?? ""),
  frontMatter: row.front_matter == null ? null : JSON.parse(String(row.front_matter)),
  contentHash: row.content_hash == null ? null : String(row.content_hash),
  revision: Number(row.revision),
  exportPath: row.export_path == null ? null : String(row.export_path),
  createdAt: iso(row.created_at),
  updatedAt: iso(row.updated_at),
  deletedAt: optionalIso(row.deleted_at),
})

export const noteOf = (row: Row): Note => ({
  id: String(row.id),
  ref: `note:${row.id}`,
  source: "internal",
  folderId: null,
  path: null,
  title: row.title == null ? null : String(row.title),
  text: String(row.body),
  frontMatter: null,
  contentHash: null,
  revision: Number(row.revision),
  exportPath: null,
  createdAt: iso(row.created_at),
  updatedAt: iso(row.updated_at),
  deletedAt: optionalIso(row.deleted_at),
})

/** A document or note row by its typed reference, or `undefined`. */
export const noteRowOf = (database: CacheDatabase, reference: string): Note | undefined => {
  const thing = thingOf(database, reference.includes(":") ? reference : `note:${reference}`)
  if (thing?.type === "document")
    return documentOf(database.prepare("SELECT * FROM documents WHERE id = ?").get(thing.id) as Row)
  if (thing?.type === "note") return noteOf(database.prepare("SELECT * FROM notes WHERE id = ?").get(thing.id) as Row)
  return undefined
}

const thingRef = (database: CacheDatabase, type: unknown, id: unknown): string | null =>
  type == null || id == null ? null : (referenceOfThing(database, storedThing(type, id)) ?? null)

export const linkOf = (database: CacheDatabase, row: Row): Link => {
  const metadata = row.metadata == null ? {} : (JSON.parse(String(row.metadata)) as { provenance?: string })
  return {
    id: String(row.id),
    from: thingRef(database, row.from_type, row.from_id) as string,
    to: thingRef(database, row.to_type, row.to_id),
    kind: row.kind as Link["kind"],
    anchor: row.anchor == null ? null : String(row.anchor),
    origin: row.source as Link["origin"],
    targetText: row.target_text == null ? null : String(row.target_text),
    role: row.role == null ? null : String(row.role),
    evidence: row.evidence == null ? null : String(row.evidence),
    provenance: metadata.provenance ?? null,
    confirmed: Number(row.confirmed) === 1,
    createdAt: iso(row.created_at),
  }
}

/** The row a reference names, refused when the store holds none. */
export const requiredThing = (database: CacheDatabase, reference: string, what = "the target"): Thing => {
  const thing = thingOf(database, canonicalReference(reference))
  if (!thing) throw new CliError("not_found", `${what} ${reference} is not in the local store`)
  return thing
}

/** The people a written name points at: by name or username of any identity, or by an alias. */
const personsNamed = (database: CacheDatabase, key: string): Set<number> => {
  const found = new Set<number>()
  if (key.length >= 3) {
    const rows = database
      .prepare(
        "SELECT i.name, i.username, il.person_id FROM identities_fts f JOIN identities i ON i.id = f.rowid " +
          "JOIN identity_links il ON il.identity_id = i.id WHERE identities_fts MATCH ?",
      )
      .all(`"${key.replaceAll('"', '""')}"`)
    for (const row of rows) {
      const names = [row.name, row.username].filter((one) => one != null).map((one) => targetKey(String(one)))
      if (names.includes(key)) found.add(Number(row.person_id))
    }
  }
  const aliases = database
    .prepare(
      "SELECT coalesce(il.person_id, CASE WHEN a.aliasable_type = 'person' THEN a.aliasable_id END) AS person_id " +
        "FROM aliases a LEFT JOIN identity_links il ON a.aliasable_type = 'identity' AND il.identity_id = a.aliasable_id " +
        "WHERE a.name_folded = ? OR a.name = ?",
    )
    .all(key, key)
  for (const row of aliases) if (row.person_id != null) found.add(Number(row.person_id))
  return found
}

const resolveKey = (database: CacheDatabase, key: string): number => {
  const people = personsNamed(database, key)
  if (people.size !== 1) return 0
  return database
    .prepare("UPDATE links SET to_type = 'person', to_id = ? WHERE to_id IS NULL AND target_folded = ?")
    .run([...people][0] as number, key).changes
}

const unresolvedChecks = new WeakMap<CacheDatabase, CacheStatement>()

/**
 * Called in the write that creates or renames a person, or gives them an alias: one indexed lookup,
 * and only a name some note is waiting for costs more.
 */
export const resolvePersonLinks = (database: CacheDatabase, names: (string | null | undefined)[]): void => {
  const keys = [...new Set(names.filter((name): name is string => !!name?.trim()).map(targetKey))]
  if (keys.length === 0) return
  let check = unresolvedChecks.get(database)
  if (!check) {
    check = database.prepare("SELECT 1 FROM links WHERE to_id IS NULL AND target_folded = ? LIMIT 1")
    unresolvedChecks.set(database, check)
  }
  for (const key of keys) if (check.get(key)) resolveKey(database, key)
}

/** Writes one link; an identical resolved link is answered instead of doubled. */
export const insertLink = (context: StoreContext, input: LinkInput): Link => {
  const { database, now } = context
  const kind = oneOf(input.kind, LINK_KINDS, "a link's kind")
  const origin = oneOf(input.origin ?? "owner", LINK_ORIGINS, "a link's origin")
  const from = requiredThing(database, input.from, "a link's source")
  const to = input.to === undefined ? null : requiredThing(database, input.to, "a link's target")
  const targetText = input.targetText === undefined ? null : textOf(input.targetText, "a link's target", 500)
  if (to === null && targetText === null) throw new CliError("validation_error", "a link needs a target")
  if (to !== null) {
    const existing = database
      .prepare(
        "SELECT * FROM links WHERE from_type = ? AND from_id = ? AND to_type = ? AND to_id = ? AND kind = ? AND anchor IS ?",
      )
      .get(from.type, from.id, to.type, to.id, kind, input.anchor ?? null)
    if (existing) return linkOf(database, existing)
  }
  const at = now()
  const provenance = input.provenance === undefined ? undefined : textOf(input.provenance, "provenance", 2000)
  const row = database
    .prepare(
      "INSERT INTO links (from_type, from_id, to_type, to_id, kind, anchor, source, target_text, target_folded, role, evidence, " +
        "metadata, confirmed, created_at, author, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id",
    )
    .get(
      from.type,
      from.id,
      to?.type ?? null,
      to?.id ?? null,
      kind,
      input.anchor ?? null,
      origin,
      targetText,
      targetText === null ? null : targetKey(targetText),
      input.role === undefined ? null : textOf(input.role, "a role", 200),
      input.evidence === undefined ? null : textOf(input.evidence, "evidence", 2000),
      provenance === undefined ? null : JSON.stringify({ provenance }),
      input.confirmed === false ? 0 : 1,
      at,
      origin === "owner" ? "owner" : null,
      at,
    )
  if (to === null && targetText !== null) resolveKey(database, targetKey(targetText))
  return linkOf(database, database.prepare("SELECT * FROM links WHERE id = ?").get(Number(row?.id)) as Row)
}

/** A folder's `accounts` row; its format lives in `settings`. */
const folderOf = (row: Row): NoteFolder => {
  const settings = row.settings == null ? {} : (JSON.parse(String(row.settings)) as { format?: string })
  return {
    id: String(row.id),
    name: String(row.name),
    format: (settings.format ?? "obsidian") as NoteFolder["format"],
    createdAt: iso(row.created_at),
  }
}

const pathParts = (path: string) => {
  const slash = path.lastIndexOf("/")
  const fileName = slash < 0 ? path : path.slice(slash + 1)
  const dot = fileName.lastIndexOf(".")
  return {
    location: slash < 0 ? null : path.slice(0, slash),
    fileName,
    extension: dot <= 0 ? null : fileName.slice(dot + 1).toLowerCase(),
  }
}

export const notesStoreOver = (context: StoreContext): Omit<NotesStore, keyof NoteSearch> => {
  const { database, now } = context
  const inTransaction = <T>(body: () => T): T => atomic(database, body)
  const folderRow = (id: string) => {
    const row = /^\d+$/.test(id)
      ? database.prepare("SELECT * FROM accounts WHERE id = ? AND provider = 'folder'").get(Number(id))
      : undefined
    if (!row) throw new CliError("not_found", `no notes folder ${id} in the local store`)
    return row
  }
  const documentRow = (id: string) => {
    const row = /^\d+$/.test(id) ? database.prepare("SELECT * FROM documents WHERE id = ?").get(Number(id)) : undefined
    if (!row) throw new CliError("not_found", `no file note ${id} in the local store`)
    return row
  }
  const noteRow = (id: string) => {
    const row = /^\d+$/.test(id) ? database.prepare("SELECT * FROM notes WHERE id = ?").get(Number(id)) : undefined
    if (!row) throw new CliError("not_found", `no note ${id} in the local store`)
    return row
  }
  const anyNote = (reference: string) => {
    const found = noteRowOf(database, reference)
    if (!found) throw new CliError("not_found", `no note ${reference} in the local store`)
    return found
  }
  const bounded = (limit = 100, offset = 0) => {
    if (!Number.isInteger(limit) || limit < 1 || limit > 500 || !Number.isInteger(offset) || offset < 0)
      throw new CliError("validation_error", "limit takes 1–500 and offset 0 or more")
    return { limit, offset }
  }
  const documentTags = (id: number) => labelsOf(database, { type: "document", id })

  return {
    addFolder: async ({ name, format = "obsidian" }) => {
      const at = now()
      const row = database
        .prepare(
          "INSERT INTO accounts (provider, external_id, name, settings, created_at, updated_at) VALUES ('folder', ?, ?, ?, ?, ?) RETURNING id",
        )
        .get(
          ulid(at),
          textOf(name, "a folder's name", 200),
          JSON.stringify({ format: oneOf(format, NOTE_FORMATS, "a folder's format") }),
          at,
          at,
        )
      return folderOf(folderRow(String(row?.id)))
    },
    folders: async () =>
      database.prepare("SELECT * FROM accounts WHERE provider = 'folder' ORDER BY name, id").all().map(folderOf),
    saveFileNote: async (input) =>
      inTransaction(() => {
        const folder = Number(folderRow(input.folderId).id)
        const path = textOf(input.path, "a note's path", 4096)
        const text = textOf(input.text, "a note's text", 200_000, true)
        const frontMatter = input.frontMatter == null ? null : JSON.stringify(input.frontMatter)
        const at = now()
        const found = database
          .prepare("SELECT * FROM documents WHERE account_id = ? AND external_id = ?")
          .get(folder, path)
        if (!found) {
          const { location, fileName, extension } = pathParts(path)
          const row = database
            .prepare(
              "INSERT INTO documents (account_id, external_id, kind, title, location, file_name, extension, storage, content_hash, " +
                "front_matter, body, extraction, revision, created_at, updated_at) " +
                "VALUES (?, ?, 'file', ?, ?, ?, ?, 'local', ?, ?, ?, 'text', 1, ?, ?) RETURNING id",
            )
            .get(
              folder,
              path,
              input.title,
              location,
              fileName,
              extension,
              input.contentHash ?? null,
              frontMatter,
              text,
              at,
              at,
            )
          return { note: documentOf(documentRow(String(row?.id))), changed: true }
        }
        const same =
          (found.body ?? "") === text &&
          (found.title ?? null) === input.title &&
          (found.front_matter ?? null) === frontMatter &&
          (found.content_hash ?? null) === (input.contentHash ?? null) &&
          found.deleted_at == null
        if (same) return { note: documentOf(found), changed: false }
        if ((found.body ?? "") !== text)
          database
            .prepare("INSERT INTO document_revisions (document_id, body, revision, created_at) VALUES (?, ?, ?, ?)")
            .run(Number(found.id), String(found.body ?? ""), Number(found.revision), at)
        database
          .prepare(
            "UPDATE documents SET title = ?, body = ?, front_matter = ?, content_hash = ?, revision = revision + ?, updated_at = ?, " +
              "deleted_at = NULL WHERE id = ?",
          )
          .run(
            input.title,
            text,
            frontMatter,
            input.contentHash ?? null,
            (found.body ?? "") === text ? 0 : 1,
            at,
            Number(found.id),
          )
        return { note: documentOf(documentRow(String(found.id))), changed: true }
      }),
    renameFileNote: async (folderId, from, to) =>
      inTransaction(() => {
        const folder = Number(folderRow(folderId).id)
        const target = textOf(to, "a note's path", 4096)
        const found = database
          .prepare("SELECT id FROM documents WHERE account_id = ? AND external_id = ? AND deleted_at IS NULL")
          .get(folder, from)
        if (!found) throw new CliError("not_found", `no live note at ${from} in folder ${folderId}`)
        const taken = database
          .prepare("SELECT id, deleted_at FROM documents WHERE account_id = ? AND external_id = ?")
          .get(folder, target)
        if (taken && taken.deleted_at == null)
          throw new CliError("validation_error", `a live note is already at ${target} in folder ${folderId}`)
        if (taken) database.prepare("DELETE FROM documents WHERE id = ?").run(Number(taken.id))
        const { location, fileName, extension } = pathParts(target)
        database
          .prepare(
            "UPDATE documents SET external_id = ?, location = ?, file_name = ?, extension = ?, updated_at = ? WHERE id = ?",
          )
          .run(target, location, fileName, extension, now(), Number(found.id))
        return documentOf(documentRow(String(found.id)))
      }),
    deleteFileNotes: async (folderId, paths) =>
      inTransaction(() => {
        const folder = Number(folderRow(folderId).id)
        const mark = database.prepare(
          "UPDATE documents SET deleted_at = ?, body = '' WHERE account_id = ? AND external_id = ? AND deleted_at IS NULL",
        )
        return paths.reduce((sum, path) => sum + mark.run(now(), folder, path).changes, 0)
      }),
    addNote: async ({ text, title, about = [] }) =>
      inTransaction(() => {
        const at = now()
        const owner = ownerPerson(database)
        const [subject] = about.map((reference) => requiredThing(database, reference))
        const notable = subject ?? owner
        const row = database
          .prepare(
            "INSERT INTO notes (notable_type, notable_id, title, body, author_type, author_id, revision, created_at, updated_at) " +
              "VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?) RETURNING id",
          )
          .get(
            notable.type,
            notable.id,
            title === undefined ? null : textOf(title, "a title", 500),
            textOf(text, "a note"),
            owner.type,
            owner.id,
            at,
            at,
          )
        const id = Number(row?.id)
        for (const reference of about.slice(1))
          insertLink(context, { from: `note:${id}`, to: reference, kind: "about", origin: "owner" })
        return noteOf(noteRow(String(id)))
      }),
    note: async (reference) => anyNote(reference),
    resolveNote: async (reference) => {
      const parsed = parseReference(reference)
      return parsed.type === "note" || parsed.type === "document" ? noteRowOf(database, reference) : undefined
    },
    noteReferences: async (reference) => [anyNote(reference).ref],
    notes: async (options = {}) => {
      const { limit, offset } = bounded(options.limit, options.offset)
      if (options.source !== undefined) oneOf(options.source, ["file", "internal"] as const, "a note's source")
      const about = options.about === undefined ? undefined : thingOf(database, canonicalReference(options.about))
      if (options.about !== undefined && !about) return { items: [], hasMore: false }
      const folder = options.folderId === undefined ? null : Number(folderRow(options.folderId).id)
      const search = options.search ?? null
      const aboutType = about?.type ?? null
      const aboutId = about?.id ?? null
      const files =
        options.source === "internal"
          ? []
          : database
              .prepare(
                "SELECT d.* FROM documents d WHERE d.deleted_at IS NULL AND (? IS NULL OR d.account_id = ?) " +
                  `AND (? IS NULL OR EXISTS (SELECT 1 FROM links l WHERE l.from_type = 'document' AND l.from_id = d.id AND l.kind = ${linkKind("about")} AND l.to_type = ? AND l.to_id = ?)) ` +
                  "AND (? IS NULL OR instr(lower(coalesce(d.body, '')), lower(?)) > 0) ORDER BY d.created_at DESC, d.id DESC LIMIT ?",
              )
              .all(folder, folder, aboutType, aboutType, aboutId, search, search, limit + offset + 1)
              .map(documentOf)
      const written =
        options.source === "file" || folder !== null
          ? []
          : database
              .prepare(
                "SELECT n.* FROM notes n WHERE n.deleted_at IS NULL " +
                  `AND (? IS NULL OR (n.notable_type = ? AND n.notable_id = ?) OR EXISTS (SELECT 1 FROM links l WHERE l.from_type = 'note' AND l.from_id = n.id AND l.kind = ${linkKind("about")} AND l.to_type = ? AND l.to_id = ?)) ` +
                  "AND (? IS NULL OR instr(lower(n.body), lower(?)) > 0) ORDER BY n.created_at DESC, n.id DESC LIMIT ?",
              )
              .all(aboutType, aboutType, aboutId, aboutType, aboutId, search, search, limit + offset + 1)
              .map(noteOf)
      const all = [...files, ...written].sort(
        (a, b) => b.createdAt.localeCompare(a.createdAt) || b.ref.localeCompare(a.ref),
      )
      return { items: all.slice(offset, offset + limit), hasMore: all.length > offset + limit }
    },
    editNote: async (id, text, revision) =>
      inTransaction(() => {
        if (id.startsWith("document:"))
          throw new CliError("validation_error", "a file note is edited in its file; the next import reads it")
        const bare = id.replace(/^note:/, "")
        const found = noteRow(bare)
        const changed = database
          .prepare(
            "UPDATE notes SET body = ?, revision = revision + 1, updated_at = ? WHERE id = ? AND revision = ? AND deleted_at IS NULL",
          )
          .run(textOf(text, "a note"), now(), Number(bare), revision).changes
        if (!changed)
          throw new CliError("validation_error", "the note changed; read its current revision before editing")
        database
          .prepare("INSERT INTO note_revisions (note_id, body, revision, created_at) VALUES (?, ?, ?, ?)")
          .run(Number(bare), String(found.body), revision, now())
        return noteOf(noteRow(bare))
      }),
    removeNote: async (id) =>
      inTransaction(() => {
        if (id.startsWith("document:"))
          throw new CliError("validation_error", "a file note goes when its file does; the next import notices")
        const bare = id.replace(/^note:/, "")
        noteRow(bare)
        database.prepare("DELETE FROM notes WHERE id = ?").run(Number(bare))
        return { id, removed: true as const }
      }),
    addLink: async (input) => inTransaction(() => insertLink(context, input)),
    links: async (options = {}) => {
      const pair = (reference: string | undefined) => {
        if (reference === undefined) return { known: true, type: null, id: null }
        const thing = thingOf(database, canonicalReference(reference))
        return thing ? { known: true, type: thing.type, id: thing.id } : { known: false, type: null, id: null }
      }
      const from = pair(options.from)
      const to = pair(options.to)
      if (!from.known || !to.known) return []
      return database
        .prepare(
          "SELECT * FROM links WHERE (? IS NULL OR (from_type = ? AND from_id = ?)) AND (? IS NULL OR (to_type = ? AND to_id = ?)) " +
            "AND (? = 0 OR to_id IS NULL) ORDER BY created_at, id LIMIT 5000",
        )
        .all(from.type, from.type, from.id, to.type, to.type, to.id, options.unresolved ? 1 : 0)
        .map((row) => linkOf(database, row))
    },
    removeLink: async (id) =>
      inTransaction(() => {
        if (!/^\d+$/.test(id) || !database.prepare("DELETE FROM links WHERE id = ?").run(Number(id)).changes)
          throw new CliError("not_found", `no link ${id} in the local store`)
        return { id, removed: true as const }
      }),
    replaceFileLinks: async (documentId, links) =>
      inTransaction(() => {
        const id = Number(documentRow(documentId).id)
        database.prepare("DELETE FROM links WHERE from_type = 'document' AND from_id = ? AND source = 'file'").run(id)
        return links.map((link) => insertLink(context, { ...link, from: `document:${id}`, origin: "file" }))
      }),
    replaceFileTags: async (documentId, tags) =>
      inTransaction(() => {
        const id = Number(documentRow(documentId).id)
        const stated = [...new Set(tags.map(normalizeTag))]
        database
          .prepare(
            "DELETE FROM taggings WHERE taggable_type = 'document' AND taggable_id = ? AND source = 'file' " +
              "AND tag_id NOT IN (SELECT t.id FROM tags t JOIN json_each(?) j ON j.value = t.name)",
          )
          .run(id, JSON.stringify(stated))
        for (const tag of stated) ensureTag(context, tag)
        addTags(context, { type: "document", id }, stated, "file")
        return documentTags(id)
      }),
    noteTags: async (reference) => {
      const note = anyNote(reference)
      return labelsOf(database, { type: note.source === "file" ? "document" : "note", id: Number(note.id) })
    },
    resolveLinks: async () =>
      inTransaction(() =>
        database
          .prepare("SELECT DISTINCT target_folded FROM links WHERE to_id IS NULL AND target_folded IS NOT NULL")
          .all()
          .reduce((sum, row) => sum + resolveKey(database, String(row.target_folded)), 0),
      ),
  }
}
