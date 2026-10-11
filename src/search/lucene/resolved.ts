import type { AccountKey } from "../../store/store.js"
import type { Stemmer } from "../stem.js"
import type { DateRange } from "./dates.js"
import type { Predicate, QueryNode, Span } from "./types.js"

export type ResolvedPredicate = Predicate & {
  resolution?: {
    chat?: { account: AccountKey; chatId: string }
    sender?: { provider: string; id: string }
    outgoing?: boolean
    date?: DateRange
    source?: string
  }
}
export type ResolvedNode =
  | ResolvedPredicate
  | { kind: "boolean"; clauses: { occur: "must" | "should" | "mustNot"; node: ResolvedNode }[]; span: Span }
export interface QueryExecution {
  root: ResolvedNode
  accounts: AccountKey[]
  chat?: { account: AccountKey; chatId: string }
  senders?: { provider: string; id: string }[]
  limit: number
  newest?: boolean
  signal?: AbortSignal
  /** Internal conversation eligibility, applied before lexical ranking. */
  conversationIds?: string[]
  conversationSince?: number
  /** Only these messages, by account, chat and message id. */
  only?: (AccountKey & { chatId: string; id: string })[]
  /** The store's stemmer, set when a leaf is stemmed: queries stem with the choices that built the index. */
  stemmer?: Stemmer
  /** Stemmed leaves match their words only, because the stems are not ready to search. */
  unstemmed?: boolean
  /** `mail` searches the mail tables; the default is messages. */
  corpus?: "messages" | "mail"
}
/** A leaf that reads the word index: every `text` and `exact` leaf, stemmed or not. */
export const hasText = (node: QueryNode): boolean =>
  node.kind === "predicate"
    ? node.field === "text" || node.field === "exact"
    : node.clauses.some(({ node }) => hasText(node))
/** A leaf that reads the stems: `text` terms and phrases. Patterns never stem. */
export const isStemmed = (node: Predicate): boolean =>
  node.field === "text" && (node.operator === "term" || node.operator === "phrase") && node.value !== ""
export const hasStems = (node: QueryNode): boolean =>
  node.kind === "predicate" ? isStemmed(node) : node.clauses.some(({ node }) => hasStems(node))
