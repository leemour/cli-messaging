import { readFileSync, writeFileSync } from "node:fs"

const model = JSON.parse(readFileSync(process.argv[2], "utf8"))
const HAND_WRITTEN = new Set(["search_terms", "search_term_trigrams", "schema_migrations"])

const camel = (s) => s.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase())

const DEFAULTS = {
  "persons.owner": 0,
  "aliases.display": 0,
  "chats.searchable": 1,
  "chats.message_count": 0,
  "email_threads.emails_count": 0,
  "documents.revision": 1,
  "notes.revision": 1,
  "reminders.revision": 1,
  "projects.tasks_count": 0,
  "links.confirmed": 1,
  "accounts.scope": "personal",
  "projects.scope": "personal",
  "organizations.scope": "personal",
  "tags.kind": "tag",
  "taggings.main": 0,
  "searches.runs": 0,
}
const CASCADE = new Set([
  "message_links.chat_id",
  "message_links.message_id",
  "message_links.parent_id",
  "conversations.chat_id",
  "conversations.first_message_id",
  "conversation_messages.conversation_id",
  "conversation_messages.message_id",
  "conversation_state.chat_id",
  "chunk_messages.chunk_id",
  "chunk_messages.first_message_id",
  "chunk_messages.last_message_id",
  "message_counter_observations.message_id",
])

// Today's index names, kept where the index is carried over.
const NAMES = {
  "chats:account_id,last_message_at DESC": "chats_by_recency",
  "messages:chat_id,sent_at DESC": "messages_by_time",
  "messages:chat_id,reply_to_external_id": "messages_by_reply",
  "messages:account_id,external_id": "messages_by_account",
  "messages:id": "messages_to_normalize",
  "identity_revisions:identity_id,created_at": "identity_revisions_by_identity",
  "member_stays:chat_id,identity_id": "member_stays_open",
  "message_links:message_id,ifnull(parent_id, 0),source,kind,ifnull(build, 0)": "message_links_unique",
  "message_links:chat_id,build": "message_links_by_build",
  "conversations:chat_id,build,first_at": "conversations_by_chat",
  "conversation_chunks:content_hash": "conversation_chunks_by_hash",
  "reminders:account_id,state,due_at": "reminders_due",
  "links:target_folded": "links_unresolved",
  "searches:command,params": "searches_history",
  "searches:last_run_at DESC": "searches_by_last_run",
  "emails:account_id,sent_at DESC": "emails_by_time",
  "meetings:account_id,started_at DESC": "meetings_by_time",
  "events:starts_at": "events_by_time",
  "tasks:project_id,status,due_at": "tasks_by_status",
  "taggings:taggable_type,taggable_id WHERE main = 1": "taggings_main_topic",
  "involvements:person_id,occurred_at DESC": "involvements_by_person",
  "involvements:identity_id,occurred_at DESC": "involvements_by_identity",
  "aliases:aliasable_type,aliasable_id,ifnull(account_id, 0) WHERE display = 1": "aliases_displayed",
  "aliases:aliasable_type,aliasable_id": "aliases_by_aliasable_type_aliasable_id",
}

const parseKey = (k) => {
  const m = k.match(/^([A-Z ]+?) \((.*)\)(?: WHERE (.*))?$/)
  const cols = [],
    parts = m[2]
  let depth = 0,
    cur = ""
  for (const ch of parts) {
    if (ch === "(") depth++
    if (ch === ")") depth--
    if (ch === "," && depth === 0) {
      cols.push(cur.trim())
      cur = ""
    } else cur += ch
  }
  cols.push(cur.trim())
  return { kind: m[1], cols, where: m[3] }
}
const colRef = (c) => {
  const desc = c.match(/^(\w+) DESC$/)
  if (desc) return `desc(table.${camel(desc[1])})`
  const fn = c.match(/^ifnull\((\w+), 0\)$/)
  if (fn) return `sql\`ifnull(\${table.${camel(fn[1])}}, 0)\``
  return `table.${camel(c)}`
}
const keyCode = (t, k) => {
  const { kind, cols, where } = parseKey(k)
  const refs = cols.map(colRef).join(", ")
  const plain = `${t}:${cols.join(",")}`
  const name =
    NAMES[where ? `${plain} WHERE ${where}` : plain] ??
    NAMES[plain] ??
    `${t}_by_${cols.join("_").replace(/\W+/g, "_").toLowerCase()}`
  const w = where ? `.where(sql\`${where}\`)` : ""
  if (kind === "PRIMARY KEY") return `primaryKey({ columns: [${refs}] })`
  if (kind === "UNIQUE")
    return where || cols.some((c) => c.includes("("))
      ? `uniqueIndex("${name}").on(${refs})${w}`
      : `unique().on(${refs})`
  return `index("${name}").on(${refs})${w}`
}

const out = []
const tableVar = new Map(model.filter((t) => !t.virtual).map((t) => [t.name, camel(t.name)]))
for (const t of model) {
  if (t.virtual || HAND_WRITTEN.has(t.name)) continue
  const cols = t.cols
  const keyed = new Set((t.keys ?? []).filter((k) => k.startsWith("PRIMARY KEY")).flatMap((k) => parseKey(k).cols))
  const lines = cols.map((c) => {
    let s = `${camel(c.name)}: ${c.type === "blob" ? `blob("${c.name}", { mode: "buffer" })` : `${c.type}("${c.name}")`}`
    if (c.pk) s += ".primaryKey()"
    else if (c.notnull || keyed.has(c.name)) s += ".notNull()"
    if (c.unique) s += ".unique()"
    const d = DEFAULTS[`${t.name}.${c.name}`]
    if (d !== undefined) s += `.default(${JSON.stringify(d)})`
    if (c.ref) {
      const [rt, rc] = c.ref.split(".")
      const self = rt === t.name ? "(): AnySQLiteColumn => " : "() => "
      const cascade = CASCADE.has(`${t.name}.${c.name}`) ? ', { onDelete: "cascade" }' : ""
      s += `.references(${self}${tableVar.get(rt)}.${camel(rc)}${cascade})`
    }
    return `    ${s},`
  })
  const constraints = [...(t.keys ?? []), ...t.fkIndexes].map((k) => keyCode(t.name, k))
  const body = `{\n${lines.join("\n")}\n  }`
  out.push(
    constraints.length
      ? `export const ${camel(t.name)} = sqliteTable(\n  "${t.name}",\n  ${body},\n  (table) => [\n${constraints.map((c) => `    ${c},`).join("\n")}\n  ],\n)\n`
      : `export const ${camel(t.name)} = sqliteTable("${t.name}", ${body.replace(/\n {4}/g, "\n  ").replace(/\n {2}\}$/, "\n}")})\n`,
  )
}

const header = `import {
  type AnySQLiteColumn,
  blob,
  desc,
  index,
  integer,
  primaryKey,
  real,
  sql,
  sqliteTable,
  text,
  unique,
  uniqueIndex,
} from "./drizzle/core.js"
`
writeFileSync(process.argv[3], `${header}\n${out.join("\n")}`)
console.log(out.length, "tables")
