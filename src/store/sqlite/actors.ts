import { CliError } from "@wirecat/cli-core"
import type { CacheDatabase } from "../driver.js"

/** Who made or owns something: the store's polymorphic actor pair. */
export interface Actor {
  type: "person" | "bot"
  id: number
}

/** How the task package names who acted; each maps to one stable actor row. */
export type Origin = "owner" | "agent" | "rule"

const BOT_KINDS = ["agent", "script", "integration"] as const

/** The owner's person row, which the initial migration seeds. */
export const ownerPerson = (database: CacheDatabase): Actor => {
  const found = database.prepare("SELECT id FROM persons WHERE owner = 1 ORDER BY id LIMIT 1").get()
  if (!found) throw new CliError("configuration_error", "the store has no owner person")
  return { type: "person", id: Number(found.id) }
}

/** A bot by its unique handle, registered on first use. */
export const botNamed = (
  database: CacheDatabase,
  name: string,
  now: number,
  kind: (typeof BOT_KINDS)[number] = "agent",
): Actor => {
  const handle = name.trim()
  if (!handle || handle.length > 100) throw new CliError("validation_error", "a bot's name takes 1–100 characters")
  if (!BOT_KINDS.includes(kind))
    throw new CliError("validation_error", `a bot's kind is one of ${BOT_KINDS.join(", ")}`)
  const found = database.prepare("SELECT id FROM bots WHERE name = ?").get(handle)
  if (found) return { type: "bot", id: Number(found.id) }
  const made = database
    .prepare("INSERT INTO bots (name, kind, created_at, updated_at) VALUES (?, ?, ?, ?) RETURNING id")
    .get(handle, kind, now, now)
  return { type: "bot", id: Number(made?.id) }
}

/**
 * The task package's origins as actors: the owner is the owner's person, a rule and an unnamed agent are
 * the seeded bots `rule` and `agent`.
 */
export const actorOfOrigin = (database: CacheDatabase, origin: Origin): Actor => {
  if (origin === "owner") return ownerPerson(database)
  const found = database.prepare("SELECT id FROM bots WHERE name = ?").get(origin)
  if (!found) throw new CliError("configuration_error", `the store has no bot ${origin}`)
  return { type: "bot", id: Number(found.id) }
}

export const originOfActor = (database: CacheDatabase, type: unknown, id: unknown): Origin | undefined => {
  if (type == null || id == null) return undefined
  if (type === "person") return "owner"
  return database.prepare("SELECT name FROM bots WHERE id = ?").get(Number(id))?.name === "rule" ? "rule" : "agent"
}
