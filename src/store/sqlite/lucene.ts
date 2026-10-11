import { CliError } from "@wirecat/cli-core"
import type { Page } from "../../domain/models.js"
import { tagOf } from "../../domain/tags.js"
import {
  type Automaton,
  compileAutomaton,
  foldRegex,
  type MatchBudget,
  wildcardPattern,
} from "../../search/lucene/automaton.js"
import { PRESETS } from "../../search/lucene/presets.js"
import { parseBytes } from "../../search/lucene/registry.js"
import type { QueryExecution, ResolvedNode, ResolvedPredicate } from "../../search/lucene/resolved.js"
import { isStemmed } from "../../search/lucene/resolved.js"
import { exhausted, QUERY_LIMITS, queryError } from "../../search/lucene/types.js"
import { inSource } from "../../search/query.js"
import type { SqlValue } from "../driver.js"
import { normalize } from "../normalize.js"
import type { ScoredHit } from "../store.js"
import { emailHitsByPk } from "./emails.js"
import type { StoreContext } from "./open.js"
import { hitsByPk } from "./search.js"

interface Fragment {
  sql: string
  params: SqlValue[]
  exact: boolean
  fts?: string
  /** The leaf as a phrase of stems, for ranking a stemmed search by `message_stems`. */
  stems?: string
}
interface Leaf {
  node: ResolvedPredicate
  fragment: Fragment
  test?: (text: string, attachments: string[]) => boolean
}
/** The tables one kind of searchable item lives in; the compiler names its row `m` and its thread `c`. */
export interface Corpus {
  rows: string
  threads: string
  words: string
  stems: string
  vocab: string
  item: string
  thread: string
}

const MESSAGES: Corpus = {
  rows: "messages",
  threads: "chats",
  words: "message_words",
  stems: "message_stems",
  vocab: "message_words_vocab",
  item: "message",
  thread: "chat",
}

// The same column names as messages and chats, so every rule reads mail as it reads messages. The text is the
// subject, a blank line, then the body, so `subject:` reads the subject back from it.
const MAIL: Corpus = {
  rows: `(SELECT id, account_id, email_thread_id AS chat_id, external_id, deleted_at, from_identity_id AS sender_identity_id,
    outgoing, coalesce(sent_at, received_at) AS sent_at,
    coalesce(subject, '') || char(10, 10) || coalesce(body_text, '') AS text FROM emails)`,
  threads: "(SELECT id, account_id, external_id, subject AS title, 1 AS searchable FROM email_threads)",
  words: "email_words",
  stems: "email_stems",
  vocab: "email_words_vocab",
  item: "email",
  thread: "email_thread",
}

const quoted = (value: string) => `"${value.replaceAll('"', '""')}"`
const combine = (parts: Fragment[], operator: "AND" | "OR"): Fragment => ({
  sql: parts.length ? `(${parts.map(({ sql }) => sql).join(` ${operator} `)})` : operator === "AND" ? "1" : "0",
  params: parts.flatMap(({ params }) => params),
  exact: parts.every(({ exact }) => exact),
})
export const prefixOf = (pattern: string): string => {
  if (pattern.includes("|")) return ""
  let prefix = ""
  for (const c of pattern) {
    if (!/[\p{L}\p{N}_ -]/u.test(c)) {
      if (["?", "*", "{"].includes(c)) prefix = [...prefix].slice(0, -1).join("")
      break
    }
    prefix += c
  }
  return prefix
}

const wordMatch = (corpus: Corpus, match: string): Fragment => ({
  sql: `m.id IN (SELECT rowid FROM ${corpus.words} WHERE ${corpus.words} MATCH ?)`,
  params: [`normalized_text : (${match})`],
  exact: true,
  fts: match,
})
// The vocabulary is the whole store's, so a chat or date filter does not shorten it.
const tooManyWords = ({ field, operator, value, span }: ResolvedPredicate, alone: boolean): never => {
  const term = `${field}:${operator === "regex" ? `/${value}/` : value}`
  throw new CliError(
    "validation_error",
    `search: ${term}${alone ? " matches" : " and the patterns before it match"} more than ${QUERY_LIMITS.expansions} indexed words, the term expansions budget — use a longer prefix, or body:/…/ inside one chat`,
    { reason: "query_limit", budget: "term expansions", complete: false, term, limit: QUERY_LIMITS.expansions, span },
  )
}
export type QueryGrouping = "chat" | "sender" | "time"
export interface QueryGroup {
  provider?: string
  account?: string
  id: string | null
  name: string | null
  outgoing?: boolean
  count: number
}
const GROUPS: Record<QueryGrouping, { key: string; select: string }> = {
  chat: {
    key: "m.chat_id",
    select: "ac.provider AS provider, ac.external_id AS account, c.external_id AS id, c.title AS name",
  },
  sender: {
    key: "coalesce(m.sender_identity_id, -m.account_id)",
    select:
      "ac.provider AS provider, ac.external_id AS account, i.external_id AS id, i.name AS name, max(m.outgoing) AS outgoing",
  },
  // Quarter hours, so a calendar day or hour in any zone (+05:30, +05:45) is a whole number of buckets.
  time: { key: "m.sent_at / 900000", select: "CAST(min(m.sent_at / 900000) * 900000 AS TEXT) AS id, NULL AS name" },
}
export const matchQuery = (context: StoreContext, execution: QueryExecution): Promise<Page<ScoredHit>> =>
  runQuery(context, execution) as Promise<Page<ScoredHit>>
/** Every match counted once, grouped; the work and candidate budgets of a search still apply. */
export const countQuery = (
  context: StoreContext,
  execution: QueryExecution,
  by: QueryGrouping,
): Promise<QueryGroup[]> => runQuery(context, execution, by) as Promise<QueryGroup[]>
/** All matching message keys, without materializing message bodies or imposing a hit-page limit. */
export const queryMessagePks = (context: StoreContext, execution: QueryExecution): Promise<number[]> =>
  runQuery(context, execution, "pks") as Promise<number[]>
const compileQuery = (context: StoreContext, execution: QueryExecution, boundedAttachments = false) => {
  const { database } = context
  const corpus = execution.corpus === "mail" ? MAIL : MESSAGES
  const mail = corpus === MAIL
  if (mail && (execution.only || execution.conversationIds || execution.conversationSince !== undefined))
    throw new CliError("validation_error", "mail has no server search or conversations")
  const started = context.now()
  const budget: MatchBudget = { work: 0 }
  let states = 0,
    expansions = 0
  const patterns = new Map<string, Automaton>()
  const expanded = new Map<string, Fragment>()
  const check = () => {
    if (execution.signal?.aborted)
      throw new CliError("validation_error", "search was aborted", { reason: "query_aborted", complete: false })
    if (context.now() - started > QUERY_LIMITS.milliseconds) exhausted("time")
  }
  const patternOf = (pattern: string, node: ResolvedPredicate) => {
    check()
    const known = patterns.get(pattern)
    if (known) return known
    const automaton = compileAutomaton(pattern, node.span)
    states += automaton.states
    if (states > QUERY_LIMITS.states) exhausted("automaton states")
    patterns.set(pattern, automaton)
    return automaton
  }
  const fragments = new Map<ResolvedPredicate, Leaf>()
  const createLeaf = (node: ResolvedPredicate): Leaf => {
    const { field, operator, value, resolution } = node
    let fragment: Fragment
    let test: Leaf["test"]
    const bound = (sql: string, ...params: SqlValue[]): Fragment => ({ sql, params, exact: true })
    const stemsOf = (text: string) => execution.stemmer?.phrases(text)
    if ((field === "text" || field === "exact") && value === "") fragment = bound("0")
    else if (field === "body" && value === "") fragment = bound("m.text = ?", "")
    else if (isStemmed(node)) {
      if (!execution.stemmer && !execution.unstemmed)
        throw new Error("a stemmed leaf reached the compiler without the store's stemmer")
      const text = normalize(value)
      const stems = stemsOf(value)
      // Words OR stems: two spellings can fold one word to different stems, and every exact hit must stay.
      fragment = /[\p{L}\p{N}]/u.test(text)
        ? {
            sql: `m.id IN (SELECT rowid FROM ${corpus.words} WHERE ${corpus.words} MATCH ?)${stems ? ` OR m.id IN (SELECT rowid FROM ${corpus.stems} WHERE ${corpus.stems} MATCH ?)` : ""}`,
            params: [`normalized_text : (${quoted(text)})`, ...(stems ? [`stems : (${stems})`] : [])],
            exact: true,
            fts: quoted(text),
            ...(stems ? { stems } : {}),
          }
        : bound("0")
    } else if (field === "text" || field === "exact") {
      if (operator === "term" || operator === "phrase") {
        const text = normalize(value)
        const stems = stemsOf(value)
        fragment = /[\p{L}\p{N}]/u.test(text)
          ? { ...wordMatch(corpus, quoted(text)), ...(stems ? { stems } : {}) }
          : bound("0")
      } else {
        const pattern = operator === "wildcard" ? wildcardPattern(normalize(value)) : foldRegex(value, node.span)
        const automaton = patternOf(pattern, node)
        const cached = expanded.get(pattern)
        if (cached) return { node, fragment: cached }
        const prefix = prefixOf(pattern)
        const terms = database
          .prepare(
            `SELECT term FROM ${corpus.vocab} WHERE col='normalized_text'${prefix ? " AND term>=? AND term<=?" : ""} ORDER BY term LIMIT ?`,
          )
          .all(...(prefix ? [prefix, `${prefix}\u{10ffff}`] : []), QUERY_LIMITS.expansions + 1)
        expansions += terms.length
        if (expansions > QUERY_LIMITS.expansions) tooManyWords(node, terms.length > QUERY_LIMITS.expansions)
        const matches = terms.flatMap(({ term }) => {
          check()
          return automaton.test(String(term), budget) ? [quoted(String(term))] : []
        })
        fragment = matches.length ? wordMatch(corpus, matches.join(" OR ")) : bound("0")
        expanded.set(pattern, fragment)
      }
    } else if (field === "body") {
      if (operator === "term" || operator === "phrase") fragment = bound("m.text = ?", value)
      else {
        const automaton = patternOf(operator === "wildcard" ? wildcardPattern(value) : value, node)
        fragment = { sql: "1", params: [], exact: false }
        test = (text) => automaton.test(text, budget)
      }
    } else if (field === "preset") {
      fragment = { sql: "1", params: [], exact: false }
      test = (text, attachments) => {
        budget.work += text.length
        if (budget.work > QUERY_LIMITS.work) exhausted("detector work")
        return PRESETS[value.toLowerCase()]?.candidate(text, attachments) ?? false
      }
    } else if (field === "filename" || field === "mime") {
      const column = field === "filename" ? "name" : "mime"
      const wanted = normalize(value)
      const automaton =
        operator === "wildcard" || operator === "regex"
          ? patternOf(operator === "wildcard" ? wildcardPattern(wanted) : foldRegex(value, node.span), node)
          : undefined
      const fits = (known: string) => {
        const name = normalize(known)
        budget.work += name.length
        if (budget.work > QUERY_LIMITS.work) exhausted("detector work")
        if (automaton) return automaton.test(name, budget)
        return name === wanted || (column === "mime" && !wanted.includes("/") && name.startsWith(`${wanted}/`))
      }
      let scope = combine(
        execution.accounts.map(({ provider, account }) =>
          bound("ac.provider=? AND ac.external_id=?", provider, account),
        ),
        "OR",
      )
      if (boundedAttachments && execution.chat) {
        const chat = execution.chat
        scope = combine(
          [
            scope,
            bound(
              `ac.provider=? AND ac.external_id=? AND m.chat_id IN (SELECT id FROM ${corpus.threads} WHERE account_id=ac.id AND external_id=?)`,
              chat.account.provider,
              chat.account.account,
              chat.chatId,
            ),
          ],
          "AND",
        )
      }
      const page = database.prepare(
        `SELECT att.id AS id, att.attachable_id AS message, att.${column} AS value FROM attachments att JOIN ${corpus.rows} m ON m.id=att.attachable_id AND att.attachable_type='${corpus.item}' JOIN accounts ac ON ac.id=m.account_id WHERE att.id > ? AND att.${column} IS NOT NULL AND m.deleted_at IS NULL AND ${scope.sql} ORDER BY att.id LIMIT 5000`,
      )
      const messages = new Set<number>()
      for (let rows = page.all(0, ...scope.params); rows.length > 0; ) {
        check()
        for (const row of rows) {
          if (fits(String(row.value))) messages.add(Number(row.message))
          if (boundedAttachments && messages.size > QUERY_LIMITS.candidates) exhausted("attachment message keys")
        }
        rows = page.all(Number(rows.at(-1)?.id), ...scope.params)
      }
      fragment = bound("m.id IN (SELECT value FROM json_each(?))", JSON.stringify([...messages]))
    } else if (field === "size") {
      const conditions =
        operator === "range"
          ? [
              ...(value === "*"
                ? []
                : [bound(`att.size ${node.lowerInclusive ? ">=" : ">"} ?`, parseBytes(value, node.span))]),
              ...(node.upper === undefined || node.upper === "*"
                ? []
                : [bound(`att.size ${node.upperInclusive ? "<=" : "<"} ?`, parseBytes(node.upper, node.span))]),
            ]
          : [bound("att.size = ?", parseBytes(value, node.span))]
      const range = combine(conditions, "AND")
      fragment = bound(
        `EXISTS (SELECT 1 FROM attachments att WHERE att.attachable_type='${corpus.item}' AND att.attachable_id=m.id AND att.size IS NOT NULL AND ${range.sql})`,
        ...range.params,
      )
    } else if (field === "content") {
      const text = normalize(value)
      // Never `fts`: the ranking ANDs every required word into message_words, where a file's words are not.
      fragment = /[\p{L}\p{N}]/u.test(text)
        ? bound(
            `m.id IN (SELECT att.attachable_id FROM attachments att WHERE att.attachable_type='${corpus.item}' AND att.id IN (SELECT rowid FROM attachment_words WHERE attachment_words MATCH ?))`,
            quoted(text),
          )
        : bound("0")
    } else if (field === "date") {
      const range = resolution?.date
      if (!range) queryError("invalid_ast", node.span)
      const conditions: Fragment[] = []
      if (range.lower !== undefined)
        conditions.push(bound(`m.sent_at ${range.lowerInclusive ? ">=" : ">"} ?`, range.lower))
      if (range.upper !== undefined)
        conditions.push(bound(`m.sent_at ${range.upperInclusive ? "<=" : "<"} ?`, range.upper))
      fragment = combine(conditions, "AND")
    } else if (field === "chat") {
      const chat = resolution?.chat
      if (!chat) queryError("invalid_ast", node.span)
      fragment = bound(
        `m.chat_id IN (SELECT cc.id FROM ${corpus.threads} cc JOIN accounts aa ON aa.id=cc.account_id WHERE aa.provider=? AND aa.external_id=? AND cc.external_id=?)`,
        chat.account.provider,
        chat.account.account,
        chat.chatId,
      )
    } else if (field === "from") {
      const sender = resolution?.sender
      if (resolution?.outgoing) fragment = bound("m.outgoing = 1")
      else if (sender)
        fragment = bound(
          "m.sender_identity_id IN (SELECT ii.id FROM identities ii WHERE ii.provider=? AND ii.external_id=?)",
          sender.provider,
          sender.id,
        )
      else queryError("invalid_ast", node.span)
    } else if (field === "tag") {
      const tag = tagOf(value)
      if (tag === undefined) queryError("invalid_tag", node.span)
      fragment = bound(
        `m.id IN (SELECT tg.taggable_id FROM taggings tg JOIN tags t ON t.id=tg.tag_id WHERE t.name=? AND tg.taggable_type='${corpus.item}') OR ` +
          `m.chat_id IN (SELECT tg.taggable_id FROM taggings tg JOIN tags t ON t.id=tg.tag_id WHERE t.name=? AND tg.taggable_type='${corpus.thread}') OR ` +
          "m.sender_identity_id IN (SELECT tg.taggable_id FROM taggings tg JOIN tags t ON t.id=tg.tag_id WHERE t.name=? AND tg.taggable_type='identity')",
        tag,
        tag,
        tag,
      )
    } else if (mail && (field === "topic" || field === "kind")) {
      throw new CliError("validation_error", `search: ${field}: is a messenger field — mail has no ${field}`, {
        reason: "unsupported_field",
        span: node.span,
      })
    } else if (field === "topic") fragment = bound("m.thread_external_id = ?", value)
    else if (field === "kind") {
      const kind = value.toLowerCase()
      fragment = bound(
        "CASE WHEN json_extract(c.metadata,'$.peerKind') IN ('private','saved','bot','service','group','channel','unknown') THEN json_extract(c.metadata,'$.peerKind') WHEN c.kind='dialog' AND json_extract(c.metadata,'$.isBot')=1 THEN 'bot' WHEN c.kind='dialog' THEN 'private' ELSE c.kind END = ?",
        kind,
      )
    } else if (field === "has") {
      const kind = value.toLowerCase()
      fragment =
        kind === "link"
          ? bound(
              `(${mail ? "m.text LIKE '%' || ? || '%'" : "m.id IN (SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?)"} OR EXISTS (SELECT 1 FROM attachments att WHERE att.attachable_type='${corpus.item}' AND att.attachable_id=m.id AND att.kind IN ('share','webpage')))`,
              mail ? "://" : quoted("://"),
            )
          : kind === "attachment"
            ? bound(
                `EXISTS (SELECT 1 FROM attachments att WHERE att.attachable_type='${corpus.item}' AND att.attachable_id=m.id)`,
              )
            : bound(
                `EXISTS (SELECT 1 FROM attachments att WHERE att.attachable_type='${corpus.item}' AND att.attachable_id=m.id AND att.kind=?)`,
                kind,
              )
    } else if (field === "in") {
      const source = value.toLowerCase()
      const chosen = execution.accounts.filter(({ provider }) => inSource(source, provider))
      fragment = chosen.length
        ? combine(
            chosen.map(({ provider, account }) => bound("ac.provider=? AND ac.external_id=?", provider, account)),
            "OR",
          )
        : bound("0")
    } else if (field === "to" || field === "cc" || field === "bcc") {
      const who = resolution?.sender
      if (!who) queryError("invalid_ast", node.span)
      fragment = mail
        ? bound(
            "m.id IN (SELECT r.email_id FROM email_recipients r JOIN identities ii ON ii.id = r.identity_id WHERE r.role = ? AND ii.provider = ? AND ii.external_id = ?)",
            field,
            who.provider,
            who.id,
          )
        : bound("0")
    } else if (field === "mailbox") {
      fragment = mail
        ? bound(
            `m.id IN (SELECT em.email_id FROM email_mailboxes em JOIN mailboxes b ON b.id = em.mailbox_id
               WHERE b.account_id = m.account_id AND (lower(b.external_id) = lower(?) OR lower(b.name) = lower(?)))`,
            value,
            value,
          )
        : bound("0")
    } else if (field === "subject") {
      const wanted = normalize(value)
      const words = wanted.match(/[\p{L}\p{N}]+/gu) ?? []
      if (!mail || !words.length) fragment = bound("0")
      else {
        // The word index holds subject and body together: it narrows, the subject itself decides.
        fragment = { ...wordMatch(corpus, words.map(quoted).join(" AND ")), exact: false }
        test = (text) => {
          const subject = normalize(text.slice(0, Math.max(0, text.indexOf("\n\n"))))
          return operator === "phrase"
            ? subject.includes(wanted)
            : words.every((word) => new RegExp(`(^|[^\\p{L}\\p{N}])${word}`, "u").test(subject))
        }
      }
    } else queryError("unsupported_field", node.span)
    return { node, fragment: { ...fragment, sql: `(${fragment.sql})` }, ...(test ? { test } : {}) }
  }
  const compile = (node: ResolvedNode): Fragment => {
    if (node.kind === "predicate") {
      const leaf = createLeaf(node)
      fragments.set(node, leaf)
      return leaf.fragment
    }
    const clauses = node.clauses.map(({ occur, node }) => ({ occur, part: compile(node) }))
    const required = clauses.filter(({ occur }) => occur === "must")
    const optional = clauses.filter(({ occur }) => occur === "should")
    const prohibited = clauses.filter(({ occur }) => occur === "mustNot")
    const positive = required.length
      ? combine(
          required.map(({ part }) => part),
          "AND",
        )
      : combine(
          optional.map(({ part }) => part),
          "OR",
        )
    const negatives = prohibited.map(({ part }) =>
      part.exact ? { ...part, sql: `NOT coalesce(${part.sql},0)` } : { sql: "1", params: [], exact: false },
    )
    const result = combine([positive, ...negatives], "AND")
    return { ...result, exact: clauses.every(({ part }) => part.exact) }
  }
  check()
  if (execution.accounts.length === 0) queryError("invalid_scope", { start: 0, end: 0 })
  const expression = compile(execution.root)
  const scopeParts = execution.accounts.map(({ provider, account }) => ({
    sql: "ac.provider=? AND ac.external_id=?",
    params: [provider, account],
    exact: true,
  }))
  let scope = combine(scopeParts, "OR")
  if (execution.chat)
    scope = combine(
      [
        scope,
        {
          sql: "ac.provider=? AND ac.external_id=? AND c.external_id=?",
          params: [execution.chat.account.provider, execution.chat.account.account, execution.chat.chatId],
          exact: true,
        },
      ],
      "AND",
    )
  else scope = combine([scope, { sql: "c.searchable=1", params: [], exact: true }], "AND")
  if (execution.senders)
    scope = combine(
      [
        scope,
        combine(
          execution.senders.map(({ provider, id }) => ({
            sql: "i.provider=? AND i.external_id=?",
            params: [provider, id],
            exact: true,
          })),
          "OR",
        ),
      ],
      "AND",
    )
  let where = combine([{ sql: "m.deleted_at IS NULL", params: [], exact: true }, scope, expression], "AND")
  if (execution.conversationIds !== undefined || execution.conversationSince !== undefined) {
    const ids = execution.conversationIds
    where = combine(
      [
        where,
        {
          sql: `m.id IN (SELECT cm.message_id FROM conversation_messages cm JOIN conversations cv ON cv.id=cm.conversation_id JOIN conversation_state cs ON cs.chat_id=cv.chat_id AND cs.current_build=cv.build WHERE 1${ids === undefined ? "" : " AND cv.id IN (SELECT value FROM json_each(?))"}${execution.conversationSince === undefined ? "" : " AND cv.last_at>=?"})`,
          params: [
            ...(ids === undefined ? [] : [JSON.stringify(ids)]),
            ...(execution.conversationSince === undefined ? [] : [execution.conversationSince]),
          ],
          exact: true,
        },
      ],
      "AND",
    )
  }
  if (execution.only)
    where = combine(
      [
        where,
        {
          sql: `m.id IN (SELECT picked.id FROM json_each(?) j CROSS JOIN accounts allowed CROSS JOIN chats scoped CROSS JOIN messages picked
            WHERE (${execution.accounts.map(() => "(allowed.provider=? AND allowed.external_id=?)").join(" OR ") || "0"})
              AND allowed.provider=json_extract(j.value,'$.provider') AND allowed.external_id=json_extract(j.value,'$.account')
              AND scoped.account_id=allowed.id AND scoped.external_id=json_extract(j.value,'$.chatId')
              AND picked.chat_id=scoped.id AND picked.external_id=json_extract(j.value,'$.id'))`,
          params: [JSON.stringify(execution.only), ...execution.accounts.flatMap((key) => [key.provider, key.account])],
          exact: true,
        },
      ],
      "AND",
    )
  const rowsFrom = `FROM ${corpus.rows} m`
  const joinedFrom = `${rowsFrom} JOIN ${corpus.threads} c ON c.id=m.chat_id JOIN accounts ac ON ac.id=m.account_id LEFT JOIN identities i ON i.id=m.sender_identity_id`
  let baseFrom = joinedFrom
  const requiredText = (node: ResolvedNode, index: "fts" | "stems" = "fts"): string | undefined => {
    if (node.kind === "predicate") return fragments.get(node)?.fragment[index]
    const required = node.clauses.filter(({ occur }) => occur === "must")
    const optional = node.clauses.filter(({ occur }) => occur === "should")
    if (required.length) {
      const parts = required.flatMap(({ node }) => requiredText(node, index) ?? [])
      return parts.length ? parts.map((part) => `(${part})`).join(" AND ") : undefined
    }
    const parts = optional.map(({ node }) => requiredText(node, index))
    return parts.length && parts.every((part) => part !== undefined)
      ? parts.map((part) => `(${part})`).join(" OR ")
      : undefined
  }
  const stemmed = [...fragments.keys()].some(isStemmed)
  const rankMatch = stemmed ? undefined : requiredText(execution.root)
  if (execution.chat && !rankMatch && !stemmed) {
    baseFrom = `FROM ${corpus.threads} c JOIN accounts ac ON ac.id=c.account_id CROSS JOIN ${corpus.rows} m LEFT JOIN identities i ON i.id=m.sender_identity_id`
    where = combine([{ sql: "m.chat_id=c.id", params: [], exact: true }, where], "AND")
  }
  // A stemmed search starts from the messages its indexes name, read by key; without it SQLite walks every
  // message of the account and tests each against the index sets.
  const driverOf = (node: ResolvedNode): { sql: string; params: SqlValue[] } | undefined => {
    if (node.kind === "predicate") {
      const { fts, stems } = fragments.get(node)?.fragment ?? {}
      if (fts === undefined) return undefined
      const words = `SELECT rowid AS id FROM ${corpus.words} WHERE ${corpus.words} MATCH ?`
      return isStemmed(node) && stems
        ? {
            sql: `${words} UNION SELECT rowid FROM ${corpus.stems} WHERE ${corpus.stems} MATCH ?`,
            params: [`normalized_text : (${fts})`, `stems : (${stems})`],
          }
        : { sql: words, params: [`normalized_text : (${fts})`] }
    }
    const required = node.clauses.filter(({ occur }) => occur === "must")
    const optional = node.clauses.filter(({ occur }) => occur === "should")
    const parts = required.length
      ? required.flatMap(({ node }) => driverOf(node) ?? [])
      : optional.map(({ node }) => driverOf(node))
    if (!parts.length || parts.some((part) => part === undefined)) return undefined
    const sets = parts as { sql: string; params: SqlValue[] }[]
    return {
      sql: sets.map(({ sql }) => `SELECT id FROM (${sql})`).join(required.length ? " INTERSECT " : " UNION "),
      params: sets.flatMap(({ params }) => params),
    }
  }
  const driver = stemmed ? driverOf(execution.root) : undefined
  const filtered = where
  if (driver) where = combine([{ sql: "m.id=d.id", params: [], exact: true }, where], "AND")
  const from = rankMatch
    ? baseFrom.replace(rowsFrom, `FROM ${corpus.words} f CROSS JOIN ${corpus.rows} m`)
    : driver
      ? baseFrom.replace(rowsFrom, `FROM d CROSS JOIN ${corpus.rows} m`)
      : baseFrom
  if (rankMatch)
    where = combine(
      [
        {
          sql: `${corpus.words} MATCH ? AND f.rank MATCH 'bm25(1.0, 0.0)' AND m.id=f.rowid`,
          params: [`normalized_text : (${rankMatch})`],
          exact: true,
        },
        where,
      ],
      "AND",
    )
  // A stemmed search ranks by stems but must not filter by them, so its ranking is a set computed once and
  // joined LEFT; joined row by row, the same query took 420 ms instead of 5 at 100k (stemming gate).
  const ranking = stemmed ? requiredText(execution.root, "stems") : undefined
  const exactTier = stemmed ? requiredText(execution.root) : undefined
  const ranked: { sql: string[]; params: SqlValue[] } = driver
    ? { sql: [`d(id) AS MATERIALIZED (${driver.sql})`], params: [...driver.params] }
    : { sql: [], params: [] }
  if (ranking && !execution.newest) {
    ranked.sql.push(
      `f(id, rank) AS MATERIALIZED (SELECT rowid, bm25(${corpus.stems}, 1.0, 0.0) FROM ${corpus.stems} WHERE ${corpus.stems} MATCH ?)`,
    )
    ranked.params.push(`stems : (${ranking})`)
  }
  if (exactTier) {
    ranked.sql.push(`x(id) AS MATERIALIZED (SELECT rowid FROM ${corpus.words} WHERE ${corpus.words} MATCH ?)`)
    ranked.params.push(`normalized_text : (${exactTier})`)
  }
  const withRanking = ranked.sql.length ? `WITH ${ranked.sql.join(", ")} ` : ""
  const rankedFrom = ranking && !execution.newest ? `${from} LEFT JOIN f ON f.id=m.id` : from
  const exactColumn = exactTier ? ", m.id IN (SELECT id FROM x) AS exact" : ""
  const relevance = rankMatch ? "f.rank" : ranking && !execution.newest ? "f.rank" : "NULL"
  const tiers = execution.newest
    ? ""
    : rankMatch
      ? "f.rank,"
      : `${exactTier ? "exact DESC," : ""}${ranking ? "f.rank IS NULL, f.rank," : ""}`
  const order = `${tiers}m.sent_at DESC, ac.provider, ac.external_id, c.external_id, m.external_id DESC`
  const leaves = [...fragments.values()]
  const exact = leaves.filter(({ test }) => test === undefined)
  const projection = exact.map(({ fragment }, index) => `coalesce(${fragment.sql},0) AS q${index}`).join(",")
  const projectionParams = exact.flatMap(({ fragment }) => fragment.params)
  const evaluate = (node: ResolvedNode, row: Record<string, unknown>, text: string, attachments: string[]): boolean => {
    if (node.kind === "predicate") {
      const leaf = fragments.get(node) as Leaf
      return leaf.test ? leaf.test(text, attachments) : Number(row[`q${exact.indexOf(leaf)}`]) === 1
    }
    const must = node.clauses.filter(({ occur }) => occur === "must")
    const should = node.clauses.filter(({ occur }) => occur === "should")
    const not = node.clauses.filter(({ occur }) => occur === "mustNot")
    return (
      (must.length
        ? must.every(({ node }) => evaluate(node, row, text, attachments))
        : should.length > 0 && should.some(({ node }) => evaluate(node, row, text, attachments))) &&
      not.every(({ node }) => !evaluate(node, row, text, attachments))
    )
  }
  const grouped = (by: QueryGrouping, sql: string, params: SqlValue[], source: string, prefix = ""): QueryGroup[] => {
    const group = GROUPS[by]
    return database
      .prepare(`${prefix}SELECT ${group.select}, count(*) AS count ${source} WHERE ${sql} GROUP BY ${group.key}`)
      .all(...params)
      .map((row) => ({
        ...(row.provider == null ? {} : { provider: String(row.provider), account: String(row.account) }),
        id: row.id == null ? null : String(row.id),
        name: row.name == null ? null : String(row.name),
        ...(row.outgoing == null ? {} : { outgoing: Number(row.outgoing) === 1 }),
        count: Number(row.count),
      }))
  }
  const hits = (pks: number[]) => (mail ? emailHitsByPk(database, pks) : hitsByPk(context, pks))
  return {
    corpus,
    rowsFrom,
    hits,
    database,
    check,
    grouped,
    where,
    from,
    withRanking,
    ranked,
    leaves,
    stemmed,
    exactTier,
    driver,
    baseFrom,
    filtered,
    ranking,
    relevance,
    rankedFrom,
    exactColumn,
    order,
    projection,
    projectionParams,
    joinedFrom,
    evaluate,
  }
}

interface QuerySelection {
  sql: string
  params: SqlValue[]
}

/** The matcher and its consumer run synchronously in one read snapshot; exact keys stay in SQL. */
export const withQuerySelection = <T>(
  context: StoreContext,
  execution: QueryExecution,
  consume: (selection: QuerySelection, check: () => void) => T,
): T => {
  const { database } = context
  database.exec("BEGIN")
  try {
    const query = compileQuery(context, execution, true)
    const { check, leaves, where, from, withRanking, ranked } = query
    check()
    let selection: QuerySelection
    if (leaves.every(({ test }) => !test)) {
      selection = {
        sql: `${withRanking}SELECT DISTINCT m.id AS id ${from} WHERE ${where.sql}`,
        params: [...ranked.params, ...where.params],
      }
    } else {
      const candidates = database
        .prepare(
          `${withRanking}SELECT m.id AS id, length(cast(m.text AS BLOB)) AS bytes ${from} WHERE ${where.sql} ORDER BY m.id LIMIT ?`,
        )
        .all(...ranked.params, ...where.params, QUERY_LIMITS.candidates + 1)
      check()
      if (candidates.length > QUERY_LIMITS.candidates) exhausted("candidate rows")
      if (candidates.reduce((sum, row) => sum + Number(row.bytes), 0) > QUERY_LIMITS.bodyBytes) exhausted("body bytes")
      const matched: number[] = []
      for (let offset = 0; offset < candidates.length; offset += 500) {
        check()
        const pks = candidates.slice(offset, offset + 500).map(({ id }) => Number(id))
        const rows = database
          .prepare(
            `SELECT m.id AS id, m.text AS body${query.projection ? `,${query.projection}` : ""},(SELECT json_group_array(att.kind) FROM attachments att WHERE att.attachable_type='${query.corpus.item}' AND att.attachable_id=m.id) AS attachment_kinds ${query.joinedFrom} WHERE m.id IN (${pks.map(() => "?").join(",")})`,
          )
          .all(...query.projectionParams, ...pks)
        for (const row of rows) {
          check()
          const attachments: unknown = JSON.parse(String(row.attachment_kinds))
          if (
            query.evaluate(
              execution.root,
              row,
              String(row.body),
              Array.isArray(attachments) ? attachments.map(String) : [],
            )
          )
            matched.push(Number(row.id))
        }
      }
      selection = { sql: "SELECT value AS id FROM json_each(?)", params: [JSON.stringify(matched)] }
    }
    const result = consume(selection, check)
    if (
      result !== null &&
      (typeof result === "object" || typeof result === "function") &&
      "then" in result &&
      typeof result.then === "function"
    )
      throw new Error("query selection consumers must run synchronously")
    check()
    database.exec("COMMIT")
    return result
  } catch (error) {
    database.exec("ROLLBACK")
    throw error
  }
}

const runQuery = async (
  context: StoreContext,
  execution: QueryExecution,
  by?: QueryGrouping | "pks",
): Promise<Page<ScoredHit> | QueryGroup[] | number[]> => {
  const {
    corpus,
    rowsFrom,
    hits,
    database,
    check,
    grouped,
    where,
    from,
    withRanking,
    ranked,
    leaves,
    stemmed,
    exactTier,
    driver,
    baseFrom,
    filtered,
    ranking,
    relevance,
    rankedFrom,
    exactColumn,
    order,
    projection,
    projectionParams,
    joinedFrom,
    evaluate,
  } = compileQuery(context, execution)
  if (by === "pks" && leaves.every(({ test }) => !test)) {
    const rows = database
      .prepare(`${withRanking}SELECT m.id AS id ${from} WHERE ${where.sql}`)
      .all(...ranked.params, ...where.params)
    await new Promise<void>((resolve) => setImmediate(resolve))
    check()
    return rows.map(({ id }) => Number(id))
  }
  if (by && by !== "pks" && leaves.every(({ test }) => !test))
    return grouped(by, where.sql, [...ranked.params, ...where.params], from, withRanking)
  // Exact forms come first, so a page they fill needs neither the stems nor their bm25: for a word in a few
  // percent of messages that was most of the cost (PERF-9). The exact tier is ranked as exact search ranks it.
  if (stemmed && exactTier && driver && !execution.newest && leaves.every(({ test }) => !test)) {
    const exactRows = database
      .prepare(
        `SELECT m.id AS id, w.rank AS relevance ${baseFrom.replace(rowsFrom, `FROM ${corpus.words} w CROSS JOIN ${corpus.rows} m`)} WHERE ${corpus.words} MATCH ? AND w.rank MATCH 'bm25(1.0, 0.0)' AND m.id=w.rowid AND ${filtered.sql} ORDER BY w.rank, m.sent_at DESC, ac.provider, ac.external_id, c.external_id, m.external_id DESC LIMIT ?`,
      )
      .all(`normalized_text : (${exactTier})`, ...filtered.params, execution.limit + 1)
    await new Promise<void>((resolve) => setImmediate(resolve))
    check()
    const room = execution.limit + 1 - exactRows.length
    const otherRows =
      room > 0
        ? database
            .prepare(
              `${withRanking}SELECT m.id AS id, ${relevance} AS relevance ${rankedFrom} WHERE ${where.sql} AND m.id NOT IN (SELECT id FROM x) ORDER BY ${ranking ? "f.rank IS NULL, f.rank," : ""}m.sent_at DESC, ac.provider, ac.external_id, c.external_id, m.external_id DESC LIMIT ?`,
            )
            .all(...ranked.params, ...where.params, room)
        : []
    await new Promise<void>((resolve) => setImmediate(resolve))
    check()
    const rows = [
      ...exactRows.map(({ id, relevance }) => ({ id, relevance, exact: true })),
      ...otherRows.map(({ id, relevance }) => ({ id, relevance, exact: false })),
    ]
    return {
      items: hits(rows.slice(0, execution.limit).map(({ id }) => Number(id))).map((hit, index) => ({
        ...hit,
        score: rows[index]?.relevance == null ? null : -Number(rows[index]?.relevance),
        exact: rows[index]?.exact === true,
      })),
      hasMore: rows.length > execution.limit,
    }
  }
  if (leaves.every(({ test }) => !test)) {
    const rows = database
      .prepare(
        `${withRanking}SELECT m.id AS id, ${relevance} AS relevance${exactColumn} ${rankedFrom} WHERE ${where.sql} ORDER BY ${order} LIMIT ?`,
      )
      .all(...ranked.params, ...where.params, execution.limit + 1)
    await new Promise<void>((resolve) => setImmediate(resolve))
    check()
    return {
      items: hits(rows.slice(0, execution.limit).map(({ id }) => Number(id))).map((hit, index) => ({
        ...hit,
        score: rows[index]?.relevance == null ? null : -Number(rows[index]?.relevance),
        ...(exactColumn ? { exact: Number(rows[index]?.exact) === 1 } : {}),
      })),
      hasMore: rows.length > execution.limit,
    }
  }
  const candidates = database
    .prepare(
      `${withRanking}SELECT m.id AS id, ${relevance} AS relevance${exactColumn}, length(cast(m.text AS BLOB)) AS bytes ${rankedFrom} WHERE ${where.sql} ORDER BY ${order} LIMIT ?`,
    )
    .all(...ranked.params, ...where.params, QUERY_LIMITS.candidates + 1)
  await new Promise<void>((resolve) => setImmediate(resolve))
  check()
  if (candidates.length > QUERY_LIMITS.candidates) exhausted("candidate rows")
  if (candidates.reduce((sum, row) => sum + Number(row.bytes), 0) > QUERY_LIMITS.bodyBytes) exhausted("body bytes")
  const found: number[] = []
  const scores = new Map(
    candidates.map((row) => [Number(row.id), row.relevance == null ? null : -Number(row.relevance)]),
  )
  const exactness = new Map(candidates.map((row) => [Number(row.id), Number(row.exact) === 1]))
  for (let offset = 0; offset < candidates.length; offset += 500) {
    if (offset > 0) await new Promise<void>((resolve) => setImmediate(resolve))
    check()
    const pks = candidates.slice(offset, offset + 500).map(({ id }) => Number(id))
    const rows = database
      .prepare(
        `SELECT m.id AS id,m.text AS body${projection ? `,${projection}` : ""},(SELECT json_group_array(att.kind) FROM attachments att WHERE att.attachable_type='${corpus.item}' AND att.attachable_id=m.id) AS attachment_kinds ${joinedFrom} WHERE m.id IN (${pks.map(() => "?").join(",")})`,
      )
      .all(...projectionParams, ...pks)
    const byPk = new Map(rows.map((row) => [Number(row.id), row]))
    for (const id of pks) {
      check()
      const row = byPk.get(id) as Record<string, unknown>
      const attachments: unknown = JSON.parse(String(row.attachment_kinds))
      if (evaluate(execution.root, row, String(row.body), Array.isArray(attachments) ? attachments.map(String) : []))
        found.push(id)
      if (!by && found.length > execution.limit) break
    }
    if (!by && found.length > execution.limit) break
  }
  if (by === "pks") return found
  if (by) return grouped(by, "m.id IN (SELECT value FROM json_each(?))", [JSON.stringify(found)], joinedFrom)
  return {
    items: hits(found.slice(0, execution.limit)).map((hit, index) => ({
      ...hit,
      score: scores.get(found[index] as number) ?? null,
      ...(exactColumn ? { exact: exactness.get(found[index] as number) === true } : {}),
    })),
    hasMore: found.length > execution.limit,
  }
}
