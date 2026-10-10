import { CliError } from "@wirecat/cli-core"
import { formatLocator } from "../../domain/locator.js"
import type { Id } from "../../domain/models.js"
import type { TagType } from "../../domain/tags.js"
import type { CacheDatabase, SqlValue } from "../driver.js"
import type { AccountKey } from "../store.js"
import type { Actor } from "./actors.js"
import type { EntityType } from "./entity-types.js"
import type { StoreContext } from "./open.js"
import type { Thing } from "./things.js"
import { toIso } from "./values.js"

/** What a tag labels: a chat or a message of the account, or a person of its messenger. */
export type TagTarget =
  | { type: "chat"; chatId: Id }
  | { type: "contact"; personId: Id }
  | { type: "message"; chatId: Id; messageId: Id }

export interface StoredTag {
  tag: string
  type: TagType
  chatId?: Id
  chatTitle?: string | null
  personId?: Id
  name?: string | null
  messageId?: Id
  locator?: string
  sources?: ("manual" | "auto")[]
  createdAt: string
}

export interface TagFilter {
  source?: "manual" | "auto"
  tag?: string
  type?: TagType
}

export const TAG_KINDS = ["tag", "topic"] as const
export type TagKind = (typeof TAG_KINDS)[number]

/**
 * Where a tagging came from. `owner` is the owner's own (the old `manual`), `file` what a note file states,
 * `auto` what the keyword rules claimed for a chat, `agent` what an agent added.
 */
export type TaggingSource = "owner" | "file" | "auto" | "agent"

/** A messenger tag target's polymorphic type: a contact is an `identity` row. */
const TAGGABLE: Record<TagType, EntityType> = { chat: "chat", contact: "identity", message: "message" }
const TAG_TYPE: Record<string, TagType> = { chat: "chat", identity: "contact", message: "message" }

export const targetThing = ({ database }: StoreContext, key: AccountKey, target: TagTarget): Thing => {
  const found =
    target.type === "contact"
      ? database
          .prepare("SELECT id FROM identities WHERE provider=? AND external_id=?")
          .get(key.provider, target.personId)
      : target.type === "chat"
        ? database
            .prepare(
              "SELECT c.id FROM chats c JOIN accounts a ON a.id=c.account_id WHERE a.provider=? AND a.external_id=? AND c.external_id=?",
            )
            .get(key.provider, key.account, target.chatId)
        : database
            .prepare(
              "SELECT m.id FROM messages m JOIN chats c ON c.id=m.chat_id JOIN accounts a ON a.id=c.account_id " +
                "WHERE a.provider=? AND a.external_id=? AND c.external_id=? AND m.external_id=? AND m.deleted_at IS NULL",
            )
            .get(key.provider, key.account, target.chatId, target.messageId)
  if (found === undefined) {
    const what =
      target.type === "contact"
        ? `person ${target.personId}`
        : target.type === "chat"
          ? `chat ${target.chatId}`
          : `message ${target.messageId} in chat ${target.chatId}`
    throw new CliError("not_found", `the local store holds no ${what}`)
  }
  return { type: TAGGABLE[target.type], id: Number(found.id) }
}

export interface TagRow {
  id: number
  name: string
  kind: TagKind
}

export const tagNamed = (database: CacheDatabase, name: string): TagRow | undefined => {
  const row = database.prepare("SELECT id, name, kind FROM tags WHERE name = ?").get(name)
  return row ? { id: Number(row.id), name: String(row.name), kind: row.kind as TagKind } : undefined
}

/**
 * A new tag or topic. A name is one or the other, never both, so a clash names what holds it; only the
 * owner makes a topic — an agent's topic is a proposed action the owner approves.
 */
export const createTag = (
  { database, now }: StoreContext,
  name: string,
  kind: TagKind,
  by: "owner" | "agent",
): TagRow => {
  if (!TAG_KINDS.includes(kind))
    throw new CliError("validation_error", `a tag's kind is one of ${TAG_KINDS.join(", ")}`)
  if (kind === "topic" && by !== "owner")
    throw new CliError("permission_error", "only the owner creates a topic — propose it for the owner to approve", {
      reason: "owner_only_topic",
    })
  const held = tagNamed(database, name)
  if (held)
    throw new CliError(
      "validation_error",
      held.kind === kind ? `the ${kind} "${name}" exists` : `"${name}" is a ${held.kind}; one name is never both`,
      { reason: held.kind === kind ? "tag_exists" : "tag_name_clash" },
    )
  const at = now()
  database.prepare("INSERT INTO tags (name, kind, created_at, updated_at) VALUES (?, ?, ?, ?)").run(name, kind, at, at)
  return tagNamed(database, name) as TagRow
}

/** The tag of that name, made as a plain tag when no tag or topic holds the name yet. */
export const ensureTag = ({ database, now }: StoreContext, name: string): TagRow => {
  const at = now()
  database
    .prepare(
      "INSERT INTO tags (name, kind, created_at, updated_at) VALUES (?, 'tag', ?, ?) ON CONFLICT (name) DO NOTHING",
    )
    .run(name, at, at)
  return tagNamed(database, name) as TagRow
}

/** The tags it did not have before, in the order given; a tag the owner adds becomes the owner's. */
export const addTags = (
  context: StoreContext,
  thing: Thing,
  tags: string[],
  source: TaggingSource = "owner",
  author?: Actor,
): string[] => {
  const { database, now } = context
  const insert = database.prepare(
    "INSERT INTO taggings (tag_id, taggable_type, taggable_id, main, source, author_type, author_id, created_at, updated_at) " +
      "VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?) ON CONFLICT (tag_id, taggable_type, taggable_id) DO NOTHING",
  )
  const claim = database.prepare(
    "UPDATE taggings SET source = 'owner', updated_at = ? WHERE tag_id = ? AND taggable_type = ? AND taggable_id = ? AND source <> 'owner'",
  )
  const at = now()
  return tags.filter((name) => {
    const tag = ensureTag(context, name)
    const added =
      insert.run(tag.id, thing.type, thing.id, source, author?.type ?? null, author?.id ?? null, at, at).changes > 0
    if (!added && source === "owner") claim.run(at, tag.id, thing.type, thing.id)
    return added
  })
}

const sourceOf = (database: CacheDatabase, thing: Thing, tagId: number) =>
  database
    .prepare("SELECT source FROM taggings WHERE tag_id=? AND taggable_type=? AND taggable_id=?")
    .get(tagId, thing.type, thing.id)?.source as TaggingSource | undefined

/** The tags it had, in the order given. A chat's keyword claim stays apart from the owner's own tag. */
export const removeTags = (
  { database }: StoreContext,
  thing: Thing,
  tags: string[],
  source?: "manual" | "auto",
): string[] => {
  const remove = database.prepare("DELETE FROM taggings WHERE tag_id=? AND taggable_type=? AND taggable_id=?")
  return tags.filter((name) => {
    const tag = tagNamed(database, name)
    if (!tag) return false
    const held = sourceOf(database, thing, tag.id)
    const automatic =
      thing.type === "chat" &&
      database.prepare("SELECT 1 AS held FROM auto_tag_claims WHERE chat_id=? AND tag_id=?").get(thing.id, tag.id)
    if (source === "manual") {
      if (held !== "owner") return false
      if (automatic)
        database
          .prepare("UPDATE taggings SET source='auto' WHERE tag_id=? AND taggable_type=? AND taggable_id=?")
          .run(tag.id, thing.type, thing.id)
      else remove.run(tag.id, thing.type, thing.id)
      return true
    }
    if (thing.type === "chat")
      database.prepare("DELETE FROM auto_tag_claims WHERE chat_id=? AND tag_id=?").run(thing.id, tag.id)
    if (source === "auto") {
      if (!automatic) return false
      if (held !== "owner") remove.run(tag.id, thing.type, thing.id)
      return true
    }
    return remove.run(tag.id, thing.type, thing.id).changes > 0
  })
}

export interface Label {
  tag: string
  /** `file` when only a note's file states it; the owner's own label otherwise. */
  origin: "file" | "owner"
}

/** A thing's tags by name, with whether only a file states each. */
export const labelsOf = (database: CacheDatabase, thing: Thing): Label[] =>
  database
    .prepare(
      "SELECT t.name, g.source FROM taggings g JOIN tags t ON t.id = g.tag_id WHERE g.taggable_type=? AND g.taggable_id=? ORDER BY t.name",
    )
    .all(thing.type, thing.id)
    .map((row) => ({ tag: String(row.name), origin: row.source === "file" ? "file" : "owner" }))

/**
 * Marks one topic as the thing's main one, or clears it with `null`: the topic is tagged on it if it was
 * not, and any other main topic stops being main.
 */
export const setMainTopic = (context: StoreContext, thing: Thing, topic: string | null): void => {
  const { database, now } = context
  const at = now()
  database
    .prepare("UPDATE taggings SET main = 0, updated_at = ? WHERE taggable_type = ? AND taggable_id = ? AND main = 1")
    .run(at, thing.type, thing.id)
  if (topic === null) return
  const tag = tagNamed(database, topic)
  if (tag?.kind !== "topic")
    throw new CliError("validation_error", `"${topic}" is not a topic; only a topic can be a thing's main one`)
  addTags(context, thing, [topic])
  database
    .prepare("UPDATE taggings SET main = 1, updated_at = ? WHERE tag_id = ? AND taggable_type = ? AND taggable_id = ?")
    .run(at, tag.id, thing.type, thing.id)
}

export const tagsOf = ({ database }: StoreContext, key: AccountKey, filter: TagFilter): StoredTag[] => {
  const tagged = filter.tag === undefined ? "" : " AND t.name=?"
  const parts: { type: TagType; sql: string; params: SqlValue[] }[] = [
    {
      type: "chat",
      sql:
        "SELECT t.name AS tag, g.taggable_type AS type, g.created_at, c.external_id AS chat_id, c.title AS chat_title, " +
        "NULL AS person_id, NULL AS name, NULL AS message_id, g.source, g.taggable_id AS target_id, t.id AS tag_id " +
        "FROM taggings g JOIN tags t ON t.id=g.tag_id JOIN chats c ON c.id=g.taggable_id " +
        "JOIN accounts a ON a.id=c.account_id WHERE g.taggable_type='chat' AND a.provider=? AND a.external_id=?",
      params: [key.provider, key.account],
    },
    {
      type: "contact",
      sql:
        "SELECT t.name AS tag, g.taggable_type AS type, g.created_at, NULL AS chat_id, NULL AS chat_title, " +
        "i.external_id AS person_id, i.name AS name, NULL AS message_id, g.source, g.taggable_id AS target_id, t.id AS tag_id " +
        "FROM taggings g JOIN tags t ON t.id=g.tag_id JOIN identities i ON i.id=g.taggable_id " +
        "WHERE g.taggable_type='identity' AND i.provider=?",
      params: [key.provider],
    },
    {
      type: "message",
      sql:
        "SELECT t.name AS tag, g.taggable_type AS type, g.created_at, c.external_id AS chat_id, c.title AS chat_title, " +
        "NULL AS person_id, NULL AS name, m.external_id AS message_id, g.source, g.taggable_id AS target_id, t.id AS tag_id " +
        "FROM taggings g JOIN tags t ON t.id=g.tag_id JOIN messages m ON m.id=g.taggable_id JOIN chats c ON c.id=m.chat_id " +
        "JOIN accounts a ON a.id=c.account_id WHERE g.taggable_type='message' AND a.provider=? AND a.external_id=?",
      params: [key.provider, key.account],
    },
  ]
  const chosen = parts.filter(({ type }) => filter.type === undefined || filter.type === type)
  const rows = database
    .prepare(`${chosen.map(({ sql }) => sql + tagged).join(" UNION ALL ")} ORDER BY 1, 2, 3, 4, 6, 8`)
    .all(...chosen.flatMap(({ params }) => (filter.tag === undefined ? params : [...params, filter.tag])))
  const result = rows.map((row): StoredTag => {
    const type = TAG_TYPE[String(row.type)] as TagType
    const chatId = row.chat_id == null ? undefined : String(row.chat_id)
    const messageId = row.message_id == null ? undefined : String(row.message_id)
    const automatic =
      type === "chat" &&
      database
        .prepare("SELECT 1 AS held FROM auto_tag_claims WHERE chat_id=? AND tag_id=?")
        .get(Number(row.target_id), Number(row.tag_id))
    return {
      ...(automatic
        ? { sources: (row.source === "owner" ? ["manual", "auto"] : ["auto"]) as ("manual" | "auto")[] }
        : {}),
      tag: String(row.tag),
      type,
      ...(type === "contact"
        ? { personId: String(row.person_id), name: row.name == null ? null : String(row.name) }
        : { chatId, chatTitle: row.chat_title == null ? null : String(row.chat_title) }),
      ...(type === "message" && chatId !== undefined && messageId !== undefined
        ? { messageId, locator: formatLocator({ ...key, chat: chatId, message: messageId }) }
        : {}),
      createdAt: toIso(Number(row.created_at)) as string,
    }
  })
  return filter.source === undefined
    ? result
    : result.filter((entry) => (entry.sources ?? ["manual"]).includes(filter.source as "manual" | "auto"))
}
