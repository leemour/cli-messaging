import { CliError } from "@wirecat/cli-core"
import type { AccountAction, SendKind } from "./journal.js"

/**
 * What a profile may be allowed to do (max-cli `CLI-37`, `NEED-251`). One name per thing the owner would
 * recognise, so `sessions` — which logs the owner out of their phone — never rides along with
 * adding a contact. There is no `*`: "everything" is not setting `allow` at all, and a wildcard
 * would switch on `delete` without anyone naming it.
 */
export const PERMISSIONS = [
  "send",
  "forward",
  "reaction",
  "edit",
  "pin",
  "read",
  "delete",
  "groups",
  "contacts",
  "profile",
  "folders",
  "sessions",
] as const

export type Permission = (typeof PERMISSIONS)[number]

const ACCOUNT: Record<AccountAction, Permission> = {
  "contact-add": "contacts",
  "contact-remove": "contacts",
  "contact-import": "contacts",
  "contact-rename": "contacts",
  "contact-block": "contacts",
  "contact-unblock": "contacts",
  profile: "profile",
  "folder-create": "folders",
  "folder-update": "folders",
  "folder-delete": "folders",
  "folder-order": "folders",
  "folder-join": "folders",
  "sessions-end": "sessions",
  "chat-mute": "profile",
  privacy: "profile",
}

export const permissionFor = (kind: SendKind, action?: string): Permission => {
  switch (kind) {
    case "message":
      return "send"
    case "chat":
      return "groups"
    case "account": {
      const permission = ACCOUNT[action as AccountAction]
      if (!permission) throw new Error(`an account change without a known action: ${action}`)
      return permission
    }
    default:
      return kind
  }
}

/** What a profile may do with one command path — the standard's "Permissions". */
export const LEVELS = ["deny", "readonly", "ask", "allow"] as const

export type Level = (typeof LEVELS)[number]

/** A command path, dotted: `messages`, `messages.delete`, `chats.members.remove`. */
export type PermissionKey = string

/** The deletions nobody gets back: the word that skips their question is `--allow-dangerous`, never `--yes`. */
const DANGEROUS = new Set(["messages.delete", "bot.messages.delete", "topics.delete", "chats.delete", "chats.clear"])

/** Deleting has its own word for "yes": the flag a person has to mean, not a habit (max-cli `NEED-238`). */
export const skipFlagFor = (key: string): "--allow-dangerous" | "--yes" =>
  DANGEROUS.has(key) ? "--allow-dangerous" : "--yes"

/** Only what cannot be undone asks; the tool is meant to work without questions (owner, NEED-460). */
export const DEFAULT_PERMISSIONS: Readonly<Record<PermissionKey, Level>> = {
  "messages.delete": "ask",
  "account.sessions.end": "ask",
  "bot.messages.delete": "ask",
  "topics.enable": "ask",
  "topics.delete": "ask",
  "chats.delete": "ask",
  "chats.clear": "ask",
  // NEED-568: a rule writes to people with nobody typing a command; it waits for the owner's own allow.
  "replies.send": "deny",
}

/** The resources at the top of the command tree, which `readOnly` and `allow` turn read-only as a whole. */
export const RESOURCES = [
  "messages",
  "reactions",
  "polls",
  "topics",
  "chats",
  "contacts",
  "account",
  "bot",
  "conversations",
  "tags",
  "search",
  "searches",
  "tasks",
  "replies",
  "attachments",
  "stats",
  "store",
  "metadata",
] as const

const OLD_WORDS: Record<Permission, PermissionKey[]> = {
  send: ["messages.send", "polls.create", "chats.start"],
  forward: ["messages.forward"],
  reaction: ["reactions", "polls.vote", "messages.press", "chats.app"],
  edit: ["messages.edit", "polls.close"],
  pin: ["messages.pin", "messages.unpin"],
  read: ["chats.mark-read"],
  delete: ["messages.delete", "chats.delete", "chats.clear"],
  groups: [
    "chats.create",
    "chats.update",
    "chats.join",
    "chats.leave",
    "chats.members",
    "chats.admins",
    "chats.link",
    "chats.requests",
    "chats.moderate",
    "topics.enable",
    "topics.create",
    "topics.edit",
    "topics.delete",
  ],
  contacts: ["contacts"],
  profile: ["account.update", "account.privacy.set", "chats.mute"],
  folders: ["chats.folders"],
  sessions: ["account.sessions.end"],
}

/** The command path an old `allow` word stood for, as one key — what an MCP tool's `permission` is checked against. */
export const keyOfWord = (word: Permission): PermissionKey => OLD_WORDS[word][0] as PermissionKey

/** `readOnly` and `allow` as levels, so a file written before `permissions` keeps meaning what it meant. */
/**
 * A bot's old words meant its own writes: `profile` was its command menu, and `read` was taking
 * updates, which every level but `deny` allows now.
 */
const botKeysOf = (word: Permission): PermissionKey[] => {
  if (word === "profile") return ["bot.commands"]
  if (word === "read") return []
  return OLD_WORDS[word].map((key) => `bot.${key}`)
}

/** `bot` translates a bot's `readOnly` and `allow`, which only ever covered the bot. */
export const fromOldSettings = (
  readOnly: boolean,
  allow: readonly Permission[] | undefined,
  { bot = false }: { bot?: boolean } = {},
): Record<PermissionKey, Level> => {
  if (!readOnly && allow === undefined) return {}
  const levels: Record<PermissionKey, Level> = bot
    ? { bot: "readonly" }
    : Object.fromEntries(RESOURCES.filter((resource) => resource !== "bot").map((resource) => [resource, "readonly"]))
  if (readOnly) return levels
  // A deletion needed its flag whatever `allow` said, so it keeps asking.
  for (const word of allow ?? []) {
    for (const key of bot ? botKeysOf(word) : OLD_WORDS[word]) levels[key] = DEFAULT_PERMISSIONS[key] ?? "allow"
  }
  return levels
}

/**
 * Layers come nearest first. A key a nearer layer sets hides that key and every key under it in the
 * farther layers, so a profile's `messages: readonly` is not undone by `messages.delete: allow` in
 * `defaults` — the nearest section wins, as it does for every other setting (NEED-573).
 */
export const layerPermissions = (layers: readonly [string, Readonly<Record<PermissionKey, Level>> | undefined][]) => {
  const levels: Record<PermissionKey, Level> = {}
  const sources: Record<PermissionKey, string> = {}
  for (const [from, layer] of layers) {
    const nearer = Object.keys(levels)
    for (const [key, level] of Object.entries(layer ?? {})) {
      if (nearer.some((named) => key === named || key.startsWith(`${named}.`))) continue
      levels[key] = level
      sources[key] = from
    }
  }
  return { levels, sources }
}

const ALLOWED = { level: "allow", key: null } as const

const ORDER: Record<Level, number> = { deny: 0, readonly: 1, ask: 2, allow: 3 }

const nearest = (levels: Readonly<Record<PermissionKey, Level>>, key: PermissionKey) => {
  for (let parts = key.split("."); parts.length > 0; parts = parts.slice(0, -1)) {
    const named = parts.join(".")
    const level = levels[named]
    if (level) return { level, key: named, depth: parts.length }
  }
  return undefined
}

/**
 * The most specific key the owner set wins. A built-in default (`DEFAULT_PERMISSIONS`) only ever
 * tightens: against a broader key of the owner's, the stricter of the two holds — so
 * `messages: readonly` still stops a deletion, and `messages: allow` does not drop its question.
 * A path nothing names is allowed.
 */
export const levelFor = (
  permissions: Readonly<Record<PermissionKey, Level>>,
  key: PermissionKey,
  defaults: Readonly<Record<PermissionKey, Level>> = DEFAULT_PERMISSIONS,
): { level: Level; key: PermissionKey | null } => {
  const own = nearest(permissions, key)
  const builtIn = nearest(defaults, key)
  if (!builtIn || (own && own.depth >= builtIn.depth)) return own ? { level: own.level, key: own.key } : ALLOWED
  if (!own || ORDER[builtIn.level] <= ORDER[own.level]) return { level: builtIn.level, key: builtIn.key }
  return { level: own.level, key: own.key }
}

const CHAT_KEYS: Partial<Record<string, PermissionKey>> = { settings: "chats.update" }

const ACCOUNT_KEYS: Record<AccountAction, PermissionKey> = {
  "contact-add": "contacts.add",
  "contact-remove": "contacts.remove",
  "contact-import": "contacts.import",
  "contact-rename": "contacts.rename",
  "contact-block": "contacts.block",
  "contact-unblock": "contacts.unblock",
  profile: "account.update",
  "folder-create": "chats.folders.create",
  "folder-update": "chats.folders.update",
  "folder-delete": "chats.folders.delete",
  "folder-order": "chats.folders.order",
  "folder-join": "chats.folders.join",
  "sessions-end": "account.sessions.end",
  "chat-mute": "chats.mute",
  privacy: "account.privacy.set",
}

const KIND_KEYS: Record<Exclude<SendKind, "chat" | "account">, PermissionKey> = {
  message: "messages.send",
  forward: "messages.forward",
  edit: "messages.edit",
  pin: "messages.pin",
  reaction: "reactions",
  read: "chats.mark-read",
  delete: "messages.delete",
}

/** The command path a guarded write belongs to, when the caller did not name it. */
export const keyForWrite = (kind: SendKind, action?: string): PermissionKey => {
  if (kind === "chat") return CHAT_KEYS[action ?? ""] ?? `chats.${action ?? "update"}`
  if (kind === "account") {
    const key = ACCOUNT_KEYS[action as AccountAction]
    if (!key) throw new Error(`an account change without a known action: ${action}`)
    return key
  }
  return KIND_KEYS[kind]
}

/** Write keys written out where a write is checked; `permission-keys.test.ts` keeps this list whole. */
const NAMED_WRITE_KEYS = [
  "store.gaps.repair",
  "messages.sync-first",
  "messages.server-search",
  "messages.press",
  "chats.start",
  "chats.app",
  "stats.messages.counters.refresh",
  "stats.messages.show.sync-first",
  "stats.messages.top.sync-first",
  "stats.contacts.top.sync-first",
  "account.sessions.list",
  "attachments.extract",
  "attachments.text.set",
  "bot.callbacks.answer",
  "bot.chats.action",
  "bot.chats.admins.add",
  "bot.chats.admins.remove",
  "bot.chats.leave",
  "bot.chats.members.remove",
  "bot.chats.moderate",
  "bot.messages.delete",
  "bot.messages.edit",
  "bot.messages.pin",
  "bot.messages.send",
  "bot.messages.unpin",
  "chats.admins.add",
  "chats.admins.remove",
  "chats.link.create",
  "chats.link.reset",
  "chats.link.revoke",
  "chats.link.update",
  "chats.members.add",
  "chats.members.remove",
  "chats.moderate",
  "conversations.embed",
  "conversations.links",
  "polls.close",
  "polls.create",
  "polls.vote",
  "searches.clear",
  "searches.create",
  "searches.delete",
  "contacts.alias.set",
  "contacts.alias.rm",
  "contacts.notes.add",
  "contacts.notes.edit",
  "contacts.notes.remove",
  "tags.auto",
  "metadata.refresh",
  "tags.add",
  "tags.remove",
  "tasks.add",
  "tasks.close",
  "topics.create",
  "topics.edit",
  "topics.enable",
]

/** Every key a write is checked against that a command path may not spell out. */
export const WRITE_KEYS: readonly PermissionKey[] = [
  ...new Set([
    ...NAMED_WRITE_KEYS,
    ...Object.keys(DEFAULT_PERMISSIONS),
    ...Object.values(KIND_KEYS),
    ...Object.values(ACCOUNT_KEYS),
    ...(Object.values(CHAT_KEYS) as PermissionKey[]),
    ...PERMISSIONS.flatMap((word) => [...OLD_WORDS[word], ...botKeysOf(word)]),
  ]),
]

/** Commands that look after the tool and its files and never show a message: no level stops them. */
const HOUSEKEEPING = new Set([
  "config",
  "session",
  "doctor",
  "commands",
  "complete",
  "upgrade",
  "skill",
  "models",
  "server",
  "runs",
  "sends",
  "recipients",
  "flood",
  "mcp",
  // Its commands read the rules or flip the pause switch; what a rule sends is checked as `replies.send`.
  "replies",
])

/** Under `bot`: its token, its names, its lists and its MCP server. */
const BOT_HOUSEKEEPING = new Set(["auth", "list", "sends", "recipients", "mcp"])

const STORE_MAINTENANCE = new Set(["info", "check", "migrate", "backup", "restore", "repair", "copies"])

/** Commands outside `messages` that print what people wrote, so `deny messages` reaches them too. */
const SHOW_MESSAGES = new Set(["inbox", "review", "watch", "serve", "store", "conversations"])

/** Before every search moved under `search` (2026-10-09): `config migrate` rewrites these. */
const OLD_SEARCH_KEY = /^(bot\.)?(messages|conversations|topics)\.search(?:\.|$)/

/** Statistics and searches moved; a profile still naming the old paths must be migrated before they run. */
export const assertStatsPermissionsCurrent = (
  path: readonly string[],
  permissions: Readonly<Record<string, Level>>,
): void => {
  if (path[0] === "bot") {
    assertStatsPermissionsCurrent(path.slice(1), permissions)
    return
  }
  if (path[0] === "search" && Object.keys(permissions).some((key) => OLD_SEARCH_KEY.test(key)))
    throw new CliError(
      "configuration_error",
      "search permission paths have moved — run config migrate before searching",
      { retryable: false },
    )
  if (path[0] !== "stats") return
  if (Object.keys(permissions).some((key) => /^(bot\.)?(messages|chats|tasks)\.stats(?:\.|$)/.test(key)))
    throw new CliError(
      "configuration_error",
      "statistics permission paths have moved — run config migrate before reading statistics",
      { retryable: false },
    )
}

export const readKeysForCommand = (path: readonly string[]): PermissionKey[] => {
  if (path[0] === "bot") return readKeysForCommand(path.slice(1)).map((key) => `bot.${key}`)
  const key = keyForCommand(path)
  if (!key) return []
  if (path[0] === "attachments" && (path[1] === "extract" || path[1] === "show")) return [key, "messages"]
  if (path[0] === "store" && path[1] === "gaps" && path[2] === "repair") return [key, "messages"]
  // A search shows what people wrote, so `deny messages` reaches every leaf that reads messages.
  if (path[0] === "search") {
    if (path[1] === "notes") return [key]
    if (path[1] === "topics") return [key, "topics"]
    if (path[1] === "conversations") return [key, "messages", "conversations"]
    return [key, "messages"]
  }
  if (path[0] !== "stats") return [key]
  const resource = path[1] === "charts" ? "chats" : path[1]
  return [
    ...new Set([
      key,
      "messages",
      ...(["chats", "contacts", "tasks"].includes(resource ?? "") ? [resource as string] : []),
    ]),
  ]
}

/**
 * The key a command path is checked against: `null` for housekeeping, which no level stops, and
 * `undefined` for a path this package does not know — a CLI's own command, which its CLI maps.
 */
export const keyForCommand = (path: readonly string[]): PermissionKey | null | undefined => {
  const [top, next] = path
  if (top === "bot") {
    if (next === undefined || BOT_HOUSEKEEPING.has(next)) return null
    const inner = keyForCommand(path.slice(1))
    return `bot.${inner ?? path.slice(1).join(".")}`
  }
  if (top === undefined || HOUSEKEEPING.has(top)) return null
  if (top === "store" && next !== undefined && STORE_MAINTENANCE.has(next)) return null
  // The agent's answers write only to the local store: their own key, so read-only messages can still link (phase 4 A10).
  if (top === "conversations" && next === "links") return "conversations.links"
  // Vectors are written to the local store only, and the text never leaves the machine (phase 5 E10).
  if (top === "conversations" && next === "embed") return "conversations.embed"
  // Which files a message has, and where they are saved, tells as much as a message does.
  if (top === "attachments" && next === "list") return "messages"
  if (top === "store" && (next === "gaps" || next === "jobs")) return path.join(".")
  if (SHOW_MESSAGES.has(top) || (top === "contacts" && (next === "context" || next === "timeline"))) return "messages"
  if ((RESOURCES as readonly string[]).includes(top)) return path.join(".")
  return undefined
}

/** Startup overrides are a nearer layer than the saved profile, and never write that profile. */
export const permissionOverrides = (entries: readonly string[] = []): Record<PermissionKey, Level> => {
  const levels: Record<PermissionKey, Level> = {}
  const path = new RegExp(`^(${RESOURCES.join("|")})(\\.[a-z][a-z-]*)*$`)
  for (const entry of entries) {
    const [key = "", level = "", extra] = entry.split("=")
    if (!path.test(key) || !(LEVELS as readonly string[]).includes(level) || extra !== undefined)
      throw new CliError(
        "validation_error",
        "--permission takes a command path and level, e.g. messages.send=allow (deny, readonly, ask, allow)",
      )
    levels[key] = level as Level
  }
  return levels
}

export const assertRetentionEvidenceRead = (permissions: Readonly<Record<string, Level>>): void => {
  for (const permission of ["stats.chats.retention", "chats"]) {
    if (levelFor(permissions, permission).level === "deny")
      throw new CliError("permission_error", `profile denies ${permission}`, { permission })
  }
}
