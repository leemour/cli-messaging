import { mkdirSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { CliError } from "@wirecat/cli-core"
import type { MeetingStore } from "@wirecat/cli-meetings"
import type { TextRange } from "../conversations/chunks.js"
import type { Link, LinkInput } from "../conversations/link.js"
import type { DownloadedFile } from "../domain/attachments.js"
import type { ChannelTagMatch } from "../domain/channel-tags.js"
import type { CounterObservations, CounterState } from "../domain/counters.js"
import type {
  Chat,
  ChatKind,
  Contact,
  Id,
  Member,
  Message,
  MessageHit,
  Page,
  PersonAlias,
  Provider,
  Reactions,
  WindowedMessage,
} from "../domain/models.js"
import type { RetentionOptions } from "../domain/retention.js"
import type { PeopleLookup } from "../resolve.js"
import type { QueryExecution } from "../search/lucene/resolved.js"
import type { Stemmers } from "../search/stem.js"
import { migrate } from "./migrations.js"
import { storeCapable } from "./open.js"
import { storePath } from "./path.js"
import * as accounts from "./sqlite/accounts.js"
import { type AdminStoreRequest, type AdminStoreResult, adminStatisticsQuery } from "./sqlite/admin-statistics.js"
import { type AgentActionsStore, agentActionsStoreOver } from "./sqlite/agent-actions.js"
import type { AttachmentTextEntry, AttachmentView, FileAttachment } from "./sqlite/attachment-texts.js"
import * as attachmentTexts from "./sqlite/attachment-texts.js"
import * as attachmentRows from "./sqlite/attachments.js"
import { backfillNormalized, pendingNormalization } from "./sqlite/backfill.js"
import * as batches from "./sqlite/batches.js"
import { type BotUpdateStore, botUpdateStoreOver } from "./sqlite/bot-updates.js"
import type { ChatMetadata } from "./sqlite/chats.js"
import * as metadataQueries from "./sqlite/chats.js"
import * as chatQueries from "./sqlite/chats.js"
import type { ChatCompleteness } from "./sqlite/completeness.js"
import * as completeness from "./sqlite/completeness.js"
import { type ConversationEligibility, conversationEligibility } from "./sqlite/conversation-eligibility.js"
import * as conversationQueries from "./sqlite/conversations.js"
import { applyCounterObservations, type CounterTarget, counterStates, counterTargets } from "./sqlite/counters.js"
import { type DecisionsStore, decisionsStoreOver } from "./sqlite/decisions.js"
import { type MailStore, mailStoreOver } from "./sqlite/emails.js"
import * as identities from "./sqlite/identities.js"
import { type InvolvementStore, involvementStoreOver } from "./sqlite/involvements.js"
import { type KnowledgeStore, knowledgeStoreOver } from "./sqlite/knowledge.js"
import { findRegex } from "./sqlite/legacy-regex.js"
import type { QueryGroup, QueryGrouping } from "./sqlite/lucene.js"
import * as lucene from "./sqlite/lucene.js"
import { meetingStoreOver } from "./sqlite/meetings.js"
import { type MemoriesStore, memoriesStoreOver } from "./sqlite/memories.js"
import * as messageWrites from "./sqlite/messages.js"
import { noteSearchOver } from "./sqlite/note-search.js"
import { type NotesStore, notesStoreOver } from "./sqlite/notes.js"
import { openSqlite, type StoreContext } from "./sqlite/open.js"
import * as personLinks from "./sqlite/person-links.js"
import type { PrivateContact, PrivateContactNote } from "./sqlite/private-people.js"
import * as privatePeople from "./sqlite/private-people.js"
import { type ProposedActionsStore, proposedActionsStoreOver } from "./sqlite/proposed-actions.js"
import * as ranges from "./sqlite/ranges.js"
import { type RankedEvidence, type RankingEvidenceRequest, rankingEvidence } from "./sqlite/ranking-evidence.js"
import { type RankedStoreFound, type RankingRequest, rankQuery } from "./sqlite/rankings.js"
import * as reads from "./sqlite/reads.js"
import { type RetentionResult, retentionQuery } from "./sqlite/retention.js"
import type {
  MemberCount,
  MemberStay,
  ProfileRevision,
  RosterChange,
  RosterRead,
  TrackedChat,
} from "./sqlite/roster.js"
import * as roster from "./sqlite/roster.js"
import * as search from "./sqlite/search.js"
import type { SearchIndexFill, SearchIndexState } from "./sqlite/search-index.js"
import * as searchIndex from "./sqlite/search-index.js"
import type { SearchRecord, StoredSearch } from "./sqlite/searches.js"
import * as searchRecords from "./sqlite/searches.js"
import type { StemsFill, StemsState } from "./sqlite/stems.js"
import * as stems from "./sqlite/stems.js"
import * as sync from "./sqlite/sync.js"
import type { StoredTag, TagFilter, TagTarget } from "./sqlite/tags.js"
import * as tagQueries from "./sqlite/tags.js"
import { type StoreTaskStore, taskStoreOver } from "./sqlite/tasks.js"
import * as transcripts from "./sqlite/transcripts.js"
import { toMs } from "./sqlite/values.js"
import type { ChunkToEmbed } from "./sqlite/vectors.js"
import * as vectors from "./sqlite/vectors.js"
import type { ScoredHit, SearchScope, WordOptions, WordQuery } from "./sqlite/words.js"
import * as words from "./sqlite/words.js"

/** Which account of which messenger a call is about. */
export interface AccountKey {
  provider: Provider
  account: Id
  scope?: "personal" | "work"
}

/** An account as the store holds it: `id` is what `meetings` and `mail` take. */
export interface StoredAccount {
  id: number
  provider: Provider
  account: Id
  name: string | null
  scope: "personal" | "work"
}

/** Whether a stored chat may hold a message deleted without naming its chat. */
export type DeletionScope = (chat: Pick<Chat, "id" | "kind" | "providerMetadata">) => boolean

/** How a message reached the store — `history`, `send`, `backfill`, `update`. Diagnostic. */
export type IngestedVia = string

export interface StoredHit extends MessageHit {
  locator: string
}

/** What a provider says about a person. `null` or absent never erases what was known. */
export interface PersonFacts {
  id: Id
  name: string | null
  username?: string | null
  isBot?: boolean | null
  description?: string | null
}

/**
 * Which messages `find` returns. At least `text` or `senders`.
 *
 * `together` keeps only the chats where **every** sender has a message in this store — written
 * there, as far as this copy knows, which is not the same as being a member.
 */
/** One identity in one messenger, by the messenger's own id. `provider` is any string: `email` is one. */
export interface IdentityRef {
  provider: Provider
  id: Id
}

/** How a link was decided (`manual`, `same-email`) and who decided it (`owner`, a program's name). */
export interface LinkOptions {
  method: string
  by: string
}

export interface LinkedIdentity extends IdentityRef {
  name: string | null
  username: string | null
  isBot: boolean | null
  /** The accounts in this store that have seen it. */
  accounts: Id[]
  method: string
  linkedBy: string
  linkedAt: string
}

/** A person across messengers: `uid` stays the same however their names change. */
export interface PersonRecord {
  uid: string
  name: string | null
  identities: LinkedIdentity[]
}

export interface MessageFilter {
  provider?: Provider
  account?: AccountKey
  /** Several accounts of `provider`, by native id — a read across some of them, never all by accident. */
  accounts?: Id[]
  senders?: Id[]
  together?: boolean
  text?: string
  /**
   * Tested against each stored message's text, newest first, in JavaScript — no index serves it, so
   * it reads the chat (or the account) until `limit` match. Not with `text` or `perChat`.
   */
  pattern?: RegExp
  signal?: AbortSignal
  /** Only this chat of the account; needs `account`. */
  chatId?: Id
  /** With `perChat`, the newest `limit` of each chat rather than of all of them together. */
  limit: number
  perChat?: boolean
}

export interface Delta {
  chats?: Chat[]
  people?: PersonFacts[]
  members?: Map<Id, Id[]>
  state?: Record<string, string>
}

export interface StoredChatFilter {
  query?: string
  kind?: Chat["kind"]
  unread?: boolean
}

export interface MessageStore {
  /** Answers the store's id for the account, which `meetings` and `mail` take. */
  saveAccount(key: AccountKey, account: { name: string | null }): Promise<number>
  saveChats(key: AccountKey, chats: Chat[]): Promise<void>
  /** A scheduled message is not kept: it is not history yet. */
  /**
   * `seenAt` is when the messenger was asked: a message it still returned is not deleted, so a
   * tombstone older than that is lifted. A tombstone set after it stays — the deletion is newer.
   */
  saveMessages(
    key: AccountKey,
    chatId: Id,
    messages: Message[],
    options: { via: IngestedVia; seenAt?: number },
  ): Promise<void>
  /** Newest first. `query` matches three letters or more of a title; `unread` keeps chats with unread messages. */
  chats(key: AccountKey, window: { limit?: number; offset?: number } & StoredChatFilter): Promise<Page<Chat>>
  countChats(key: AccountKey, filter?: StoredChatFilter): Promise<number>
  /** Replaces who is in a chat with this list, whole: a person left out has left. */
  saveMembers(key: AccountKey, chatId: Id, memberIds: Id[]): Promise<void>
  /** Who is in a chat, by name, as the last list said; empty when no list was ever saved. */
  members(key: AccountKey, chatId: Id): Promise<Member[]>
  /**
   * One read of a group's member list: stays opened and kept, a stay closed only when the read was whole,
   * profiles revised when they differ, today's count. The chat's present members become the list read whole.
   */
  saveRoster(key: AccountKey, chatId: Id, read: RosterRead): Promise<RosterChange>
  /** Stays open at `since` (ISO) or begun after it, oldest first; every stay without it. */
  memberStays(key: AccountKey, chatId: Id, options?: { since?: string }): Promise<MemberStay[]>
  /** One row a day, oldest first; from `since` (`YYYY-MM-DD`) when given. */
  memberCounts(key: AccountKey, chatId: Id, options?: { since?: string }): Promise<MemberCount[]>
  /** Every profile the chat's members were seen with, oldest first. */
  profileRevisions(key: AccountKey, chatId: Id, options?: { since?: string }): Promise<ProfileRevision[]>
  /** Starts or stops `serve`'s daily fetch of the chat's members; history already kept stays. */
  trackMembers(key: AccountKey, chatId: Id, tracked: boolean): Promise<void>
  trackedChats(key: AccountKey): Promise<TrackedChat[]>
  /** The chats a person is in, newest first — as far as the saved member lists go. */
  chatsWith(key: AccountKey, memberId: Id): Promise<Chat[]>
  /** What a sync remembered under `name` for this account, and when; a caller encodes a number itself. */
  syncState(key: AccountKey, name: string): Promise<{ value: string; at: string } | undefined>
  setSyncState(key: AccountKey, name: string, value: string): Promise<void>
  clearSyncState(key: AccountKey, name: string): Promise<void>
  /**
   * A catch-up's whole answer in one transaction, so a reader never sees half of it: chats, people,
   * each listed chat's members (replaced whole) and sync state such as a delta marker.
   */
  applyDelta(key: AccountKey, delta: Delta): Promise<void>
  /**
   * Takes the stretch of a chat at `anchor` for `forMs`; answers whether `holder` has it. Refused
   * while another holder's lease runs; the same holder renews its own.
   */
  claim(key: AccountKey, chatId: Id, anchor: string, holder: string, forMs: number): Promise<boolean>
  /** Gives the stretch back, if `holder` still has it. */
  release(key: AccountKey, chatId: Id, anchor: string, holder: string): Promise<void>
  /** What a voice message said, when it was heard before, and by what. */
  transcript(key: AccountKey, chatId: Id, messageId: Id): Promise<{ text: string; source: string } | undefined>
  /** Keeps a finished transcript; an empty one is not kept, so the message is heard again. */
  keepTranscript(key: AccountKey, chatId: Id, messageId: Id, text: string, source: string): Promise<void>
  /**
   * Where `messages download` saved a held message's files, for reading them later. Answers how many
   * attachments it recorded: a file it cannot tell apart from another is not recorded.
   */
  keepDownloads(key: AccountKey, chatId: Id, messageId: Id, files: readonly DownloadedFile[]): Promise<number>
  /** File attachments of this account's live messages, newest first, below `beforePk`; never one an agent wrote. */
  fileAttachments(
    key: AccountKey,
    page: { chatId?: Id; messageId?: Id; beforePk?: number; limit: number },
  ): Promise<FileAttachment[]>
  /** File attachments of live messages and what is held of their text, newest first; never the text. */
  attachments(
    key: AccountKey,
    filter: { chatId?: Id; messageId?: Id; needsText?: boolean; offset?: number; limit: number },
  ): Promise<AttachmentView[]>
  /** Where the file of one attachment was saved, when that is recorded. */
  localPathOf(attachmentPk: number): Promise<string | null>
  /** An extraction never replaces an agent's text; answers whether it was kept. */
  keepAttachmentText(attachmentPk: number, entry: AttachmentTextEntry): Promise<boolean>
  /** A chat's live messages for the conversation rules, oldest first; pass `next` back as `after`. */
  linkInputs(
    key: AccountKey,
    chatId: Id,
    page: { after?: string; limit: number },
  ): Promise<{ items: LinkInput[]; next: string | null }>
  /** Who wrote in the chat, by lowercased username: what an `@mention` names. */
  senderHandles(key: AccountKey, chatId: Id): Promise<Map<string, Id>>
  /**
   * The chat's provider and rule links and its conversations, rebuilt: written as a new build in short
   * transactions and made current in one, so readers never see half of it and a failed build changes nothing.
   */
  replaceConversations(key: AccountKey, chatId: Id, build: ConversationBuild): Promise<void>
  /** Newest first; `after` and `before` bound when a conversation started. */
  conversations(
    key: AccountKey,
    chatId: Id,
    window: { limit: number; after?: string; before?: string },
  ): Promise<Page<ConversationSummary>>
  /** Its messages oldest first; `undefined` when the account has no such conversation. */
  conversation(key: AccountKey, id: string): Promise<{ summary: ConversationSummary; messages: Message[] } | undefined>
  /** Which conversation a message is in, once the chat is built. */
  conversationOf(key: AccountKey, chatId: Id, messageId: Id): Promise<string | undefined>
  /** The conversation of the current build each message is in, in the same order; `undefined` where none. */
  conversationsOfMessages(
    key: AccountKey,
    refs: { chatId: Id; messageId: Id }[],
  ): Promise<(ConversationSummary | undefined)[]>
  /** Every link a message has, the messenger's first. */
  links(key: AccountKey, chatId: Id, messageId: Id, options?: { limit: number }): Promise<StoredLink[]>
  replies?(key: AccountKey, chatId: Id, messageId: Id, limit: number): Promise<Page<{ messageId: Id }>>
  /** The user's agent's current answer per message: its parent, or `null` for "starts a conversation". */
  agentAnswers(key: AccountKey, chatId: Id): Promise<Map<Id, Id | null>>
  /** Stores the agent's answer to a batch, checked whole first; answers how many were stored (A5). */
  saveAnswers(key: AccountKey, batch: string, answer: AgentAnswer): Promise<{ chat: Id; stored: number }>
  /** Drops the agent's answers for a chat, or one model's; answers how many. Messages are never touched. */
  clearAnswers(key: AccountKey, chatId: Id, model?: string): Promise<number>
  /** How many messages still need the user's agent, and their characters (phase 4). */
  batchStatus(key: AccountKey, chatId: Id): Promise<{ messages: number; characters: number }>
  /** The earliest window holding a message the agent has not answered; `undefined` when none is left. */
  nextBatch(key: AccountKey, chatId: Id, options: { size: number }): Promise<LinkBatch | undefined>
  /** Chunks of the chat's current build with no vector of `model`, by hash after `after` (phase 5). */
  chunksToEmbed(
    key: AccountKey,
    chatId: Id,
    model: string,
    options: { after?: string; limit: number },
  ): Promise<ChunkToEmbed[]>
  saveVectors(model: string, dims: number, vectors: { hash: string; vector: Float32Array }[]): Promise<void>
  /** The current build's distinct chunks, and how many have a vector of `model`. */
  vectorStatus(key: AccountKey, chatId: Id, model: string): Promise<{ chunks: number; embedded: number }>
  /** Drops the chat's vectors, or one model's; a vector another chat's chunk shares stays. */
  clearVectors(key: AccountKey, chatId: Id, model?: string): Promise<number>
  /** The conversations nearest in meaning to `query`, in one chat or every one of the account, best first. */
  nearestConversations(
    key: AccountKey,
    options: {
      chatId?: Id
      model: string
      since?: string
      limit: number
      query: Float32Array
      exclude?: string
      conversations?: string[]
      scope?: "personal" | "work"
      projectId?: string
      personId?: string
      before?: string
    },
  ): Promise<ConversationHit[]>
  /**
   * A conversation of the current build: how many chunks it has, and the vectors of `model` of those whose
   * messages did not change since — none when it is not the account's or not current.
   */
  conversationVectors(key: AccountKey, id: string, model: string): Promise<{ chunks: number; vectors: Float32Array[] }>
  /**
   * How fresh each built chat's conversations and `model`'s vectors are — one chat, or every chat whose
   * conversations were ever built. A chat never built answers `builtAt: null`.
   */
  readiness(key: AccountKey, options: { chatId?: Id; model: string }): Promise<StoredReadiness[]>
  /** Group chats with stored messages whose conversations were never built, the newest message first. */
  unbuiltGroups(key: AccountKey): Promise<Id[]>
  /** Chats in scope embedded with another model and not with `model`, which a search with it cannot see. */
  embeddedOnlyElsewhere(key: AccountKey, options: { chatId?: Id; model: string }): Promise<Id[]>
  /** Whether the chat's conversations were built, and when; `undefined` when never. */
  conversationState(
    key: AccountKey,
    chatId: Id,
  ): Promise<{ enabledAt: string; builtAt: string | null; algorithmVersion: number | null } | undefined>
  /** Oldest to newest, like a provider's history page. */
  /** `threadId` keeps one forum topic's. */
  messages(
    key: AccountKey,
    chatId: Id,
    window: { limit: number; before?: Id; since?: string; threadId?: Id },
  ): Promise<Page<Message>>
  /** How many stored messages the chat has, sent at `since` or later when it is given. */
  countMessages(key: AccountKey, chatId: Id, options?: { since?: string }): Promise<number>
  /** Saved or edited after `at` (ISO, this machine's clock), oldest first, and the ids deleted after it. */
  changes(key: AccountKey, chatId: Id, at: string): Promise<{ messages: Message[]; deleted: Id[] }>
  /**
   * By time rather than by id: `before` messages sent at `at` or earlier and `after` sent later,
   * oldest first. `around` answers the same question for a message id.
   */
  messagesWindow(key: AccountKey, chatId: Id, window: { at: string; before: number; after: number }): Promise<Message[]>
  /**
   * A stored message and its stored neighbours, oldest first, the one asked for with `anchor`. Until
   * backfill records which stretches are complete, a neighbour here is the nearest one kept, not
   * necessarily the next one sent.
   */
  around(
    key: AccountKey,
    chatId: Id,
    messageId: Id,
    window: { before: number; after: number },
  ): Promise<WindowedMessage[]>
  /**
   * One message by its id. Without `chatId` it is looked up across the account, which is enough
   * where ids are unique per account (MAX) and refused where two chats share one (Telegram).
   */
  message(key: AccountKey, messageId: Id, options?: { chatId?: Id }): Promise<Message | undefined>
  /**
   * Everything one account holds — its chats, messages, members, state, leases, transcripts and whom
   * it has seen — for `cache clear`. Other accounts, and identities they share, stay.
   */
  purge(key: AccountKey): Promise<void>
  /**
   * Given every chat the account is in, marks the rest `left` and says how many it marked. Only
   * ever from a complete list: a page or a cut list says nothing about the chats it leaves out.
   * Remembers when, so a search can say the store knows the account's whole chat list.
   */
  markChatsLeft(key: AccountKey, present: Id[]): Promise<number>
  /** The chats marked left and the messages they hold; with `clear`, deletes them and all under them. */
  leftChats(key: AccountKey, options?: { clear?: boolean }): Promise<{ chats: number; messages: number }>
  /**
   * A tombstone, not a removal: the row stays, so a copy fetched before the deletion does not bring
   * the message back, and reads and search stop returning it. Its text goes — from the row, the
   * search copy, the edit history and the transcript. Only the messenger returning it again, when
   * asked after the deletion, lifts the tombstone (`saveMessages`' `seenAt`).
   *
   * Without `chatId`, a message is tombstoned only when exactly one live message with its id is left
   * in the chats `among` accepts. Without `among`, nothing is: only the messenger knows which of its
   * chats a deletion without one may belong to (`Messenger.deletedWithoutChat`).
   */
  markDeleted(key: AccountKey, messageIds: Id[], options?: { chatId?: Id; among?: DeletionScope }): Promise<number>
  /** Newest first. At least three characters: a trigram index answers a shorter query with nothing. */
  search(query: string, options: { limit: number; account?: AccountKey }): Promise<Page<StoredHit>>
  /** Newest first — by text, by who wrote it, or both. */
  find(filter: MessageFilter): Promise<Page<StoredHit>>
  /**
   * The word index, ranked by bm25, ties newest first (phase 2 plan S4 steps 1, 2 and 4). Chats marked
   * not searchable are left out unless the scope names the chat.
   */
  rankingDiscussionChats?(account: AccountKey, chatId: string): Promise<string[]>
  rankingEvidence?(execution: QueryExecution, request: RankingEvidenceRequest): Promise<RankedEvidence>
  retention?(
    key: AccountKey,
    chatId: Id,
    options: RetentionOptions,
    evidence?: { cohort: string; cursor?: string },
  ): Promise<RetentionResult>
  adminStatisticsQuery?(execution: QueryExecution, request: AdminStoreRequest): Promise<AdminStoreResult>
  rankQuery?(execution: QueryExecution, request: RankingRequest): Promise<RankedStoreFound>
  directReplies?(parents: { account: AccountKey; chatId: Id; id: Id }[], limit: number): Promise<Page<StoredHit>>
  matchQuery?(execution: QueryExecution): Promise<Page<ScoredHit>>
  conversationEligibility?(execution: QueryExecution): Promise<ConversationEligibility>
  /** The same matches as `matchQuery`, each counted once, grouped by chat, sender or quarter hour. */
  countQuery?(execution: QueryExecution, by: QueryGrouping): Promise<QueryGroup[]>
  matchWords(query: WordQuery, scope: SearchScope, options: WordOptions): Promise<Page<ScoredHit>>
  /** The substring index, newest first (step 5); pieces under three letters are dropped. */
  matchSubstring(query: WordQuery, scope: SearchScope, options: { limit: number }): Promise<Page<ScoredHit>>
  /** The kinds of attachment held, for `has:` to name the ones it can find. */
  attachmentKinds(): Promise<string[]>
  /** Messages matching the scope alone, newest first: a search with filters and no word. */
  matchFilters(scope: SearchScope, options: { limit: number }): Promise<Page<ScoredHit>>
  /** Per chat: whether its history is held up to date, without gaps, back to its start. */
  chatCompleteness(key: AccountKey, chatIds: Id[]): Promise<ChatCompleteness[]>
  /** Of `terms`, those the index knows as a word or the beginning of one. */
  knownTerms(terms: string[]): Promise<Set<string>>
  /** Known words sharing these trigrams, within the lengths, most shared first. */
  termCandidates(
    trigrams: string[],
    lengths: { shortest: number; longest: number },
  ): Promise<{ term: string; docs: number }[]>
  /** How far the word index is built; `undefined` on a file before it existed. */
  searchIndexState(): Promise<SearchIndexState | undefined>
  /**
   * Builds the word index towards "ready" in short batches — the normalized text, the messages up to
   * the watermark, the typo vocabulary — until done or `until` says stop. Each batch is its own write.
   */
  fillSearchIndex(options?: { until?: () => boolean }): Promise<SearchIndexFill>
  /** How far the stems are built, and by which stemmer choices; `undefined` on a file before they existed. */
  stemsState(): Promise<StemsState | undefined>
  /** Builds the stems towards "ready" in short batches until done or `until` says stop; never rebuilds. */
  fillStems(options?: { until?: () => boolean }): Promise<StemsFill>
  /**
   * The stemmer choices saved in the store for every profile, tg and MAX; `undefined` while the defaults
   * apply, `null` when a newer tool saved one this build does not know.
   */
  stemmers(): Promise<Stemmers | null | undefined>
  /** Saves them; stems built by other choices wait for `store reindex` or `store migrate`. */
  saveStemmers(stemmers: Stemmers): Promise<void>
  savePeople(key: AccountKey, people: PersonFacts[]): Promise<void>
  /**
   * The people this account has a one-to-one chat with — as far as the saved member lists go —
   * newest conversation first or by name. `query` matches three letters or more of a name or
   * username.
   */
  contacts(
    key: AccountKey,
    options: { order: "recent" | "name"; query?: string; limit: number; offset?: number },
  ): Promise<Page<Contact>>
  countContacts(key: AccountKey, options?: { query?: string }): Promise<number>
  /** Works out again when each contact was last written to, from their one-to-one chats. */
  refreshRecency(key: AccountKey): Promise<void>
  /** Every account of every messenger the file holds, by messenger then id. */
  accounts(): Promise<AccountKey[]>
  /** Every account with the store's id for it, by provider then external id. */
  storedAccounts(): Promise<StoredAccount[]>
  /** One account by provider and external id, never created: `not_found` when the store has none. */
  storedAccount(key: AccountKey): Promise<StoredAccount>
  /** The name the messenger last gave for this account; `null` when it never did. */
  accountName(key: AccountKey): Promise<string | null>
  /** Everyone this provider's accounts have seen; with `account`, only who that account has seen. */
  people(provider: Provider, options?: { account?: Id; accounts?: Id[] }): Promise<PeopleLookup>
  personOf(identity: IdentityRef): Promise<PersonRecord | undefined>
  /** The person a `person:<uid>` reference names. */
  personByUid(uid: string): Promise<PersonRecord | undefined>
  /** Records the decision in `identity_link_events`; `unlinkIdentity` undoes it. */
  linkIdentities(person: IdentityRef, other: IdentityRef, options: LinkOptions): Promise<PersonRecord>
  unlinkIdentity(identity: IdentityRef, options: LinkOptions): Promise<PersonRecord>
  /** Messages of the account that name this person, newest first. */
  mentioning(key: AccountKey, person: { id: Id; username: string | null }, limit: number): Promise<Page<StoredHit>>
  /** A message's reactions as they are now; answers whether the message is held at all. */
  saveReactions(
    key: AccountKey,
    chatId: Id,
    messageId: Id,
    reactions: Reactions,
    options?: { observation?: CounterObservations["reactions"] },
  ): Promise<boolean>
  counterTargets?(
    execution: QueryExecution,
    options: { now: number; maxAge: number },
  ): Promise<{ items: CounterTarget[]; hasMore: boolean }>
  counterStates?(
    key: AccountKey,
    chatId: Id,
    messageId: Id,
    options: { now: number; maxAge: number },
  ): Promise<CounterState[]>
  updateCounterObservations?(
    key: AccountKey,
    chatId: Id,
    messageId: Id,
    observations: CounterObservations,
  ): Promise<number>
  /**
   * Records that every message from `from` to `to` (inclusive, by ordering key) is held, merging it
   * with the stretches it overlaps or touches. Answers the merged stretch.
   */
  markRange(key: AccountKey, chatId: Id, from: number, to: number): Promise<Range>
  /** Per chat that has messages: how many, the oldest and newest, and when the last one was stored. */
  chatStats(key: AccountKey, chatId?: Id): Promise<ChatStats[]>
  /** One person's stored messages per chat of this account, newest first. */
  senderStats(key: AccountKey, senderId: Id): Promise<SenderChatStats[]>
  /** Every name and username this account's store recorded for one person, the current ones included. */
  personNames(key: AccountKey, personId: Id): Promise<PersonAlias[]>
  /** The stretches held completely, oldest first. */
  ranges(key: AccountKey, chatId: Id): Promise<Range[]>
  /** Labels one stored chat, person or message; answers the tags it did not have. `not_found` for one not held. */
  chatMetadata(key: AccountKey, chatId: Id): Promise<ChatMetadata | undefined>
  saveChatMetadata(key: AccountKey, entry: Omit<ChatMetadata, "fetchedAt">): Promise<ChatMetadata>
  replaceAutoTags(key: AccountKey, chatId: Id, algorithm: string, tags: ChannelTagMatch[]): Promise<void>
  privateContact(key: AccountKey, personId: Id): Promise<PrivateContact>
  setContactAlias(key: AccountKey, personId: Id, alias: string | null): Promise<{ personId: Id; alias: string | null }>
  addContactNote(key: AccountKey, personId: Id, text: string): Promise<PrivateContactNote>
  contactNote(key: AccountKey, personId: Id, id: string): Promise<PrivateContactNote>
  editContactNote(
    key: AccountKey,
    personId: Id,
    id: string,
    text: string,
    revision: number,
  ): Promise<PrivateContactNote>
  removeContactNote(key: AccountKey, personId: Id, id: string): Promise<{ id: string; personId: Id; removed: boolean }>
  addTags(key: AccountKey, target: TagTarget, tags: string[]): Promise<string[]>
  /** Answers the tags it had. */
  removeTags(key: AccountKey, target: TagTarget, tags: string[], source?: "manual" | "auto"): Promise<string[]>
  /** The account's tagged chats and messages, and its messenger's tagged people. */
  tags(key: AccountKey, filter?: TagFilter): Promise<StoredTag[]>
  /** One run of a search or stats; the same unnamed run again counts on its row. `saved` is the saved search it ran. */
  recordSearch(run: SearchRecord, options?: { saved?: string }): Promise<void>
  /** A saved search by name; a name already taken is refused unless `replace`. */
  saveSearch(name: string, search: SearchRecord, options?: { replace?: boolean }): Promise<StoredSearch>
  /** A saved search by name, or any row by id. */
  storedSearch(reference: string): Promise<StoredSearch | undefined>
  savedSearches(): Promise<StoredSearch[]>
  /** Runs, newest first, one more than `limit` when there are more. */
  searchHistory(limit: number): Promise<StoredSearch[]>
  deleteSearch(reference: string): Promise<StoredSearch>
  /** Drops the unnamed runs; answers how many. */
  clearSearchHistory(): Promise<number>
  /** Open tasks waiting on the owner, for `@wirecat/cli-tasks`'s service. */
  readonly botUpdates: BotUpdateStore
  readonly involvements: InvolvementStore
  readonly tasks: StoreTaskStore
  readonly knowledge: KnowledgeStore
  /** Notes, the links between anything and anything, and the owner's organisations and projects. */
  readonly notes: NotesStore
  /** Choices that hold until replaced, each with its evidence. */
  readonly decisions: DecisionsStore
  /** What agents concluded: summaries, digests, facts, preferences, each with evidence and a scope. */
  readonly memories: MemoriesStore
  /** What an agent wants done outside the store, waiting for the owner's approval. */
  readonly proposedActions: ProposedActionsStore
  /** One row per tool an agent called, never its arguments. */
  readonly agentActions: AgentActionsStore
  /** Meetings and calendar events: the port `@wirecat/cli-meetings` defines. */
  readonly meetings: MeetingStore
  /** Email threads, emails, recipients and mailboxes. */
  readonly mail: MailStore
  close(): Promise<void>
}

/** One sender's stored messages in one chat. */
export interface SenderChatStats {
  chatId: Id
  title: string | null
  kind: ChatKind
  messages: number
  firstAt: string | null
  lastAt: string | null
}

export interface ChatStats {
  chatId: Id
  title: string | null
  messages: number
  oldestAt: string | null
  newestAt: string | null
  lastStoredAt: string | null
}

/** One build of a chat's conversations, by message id; phase 3 plan C3. */
export interface ConversationBuild {
  check?: () => void
  /** When the build started reading: a change after it is not in the build. */
  startedAt: number
  algorithmVersion: number
  links: Link[]
  /** Message ids, each conversation oldest first. */
  conversations: Id[][]
  /** Each conversation's chunks, in the same order as `conversations` (phase 5). */
  chunks?: { firstId: Id; lastId: Id; hash: string; range?: TextRange }[][]
}

/**
 * A conversation found by meaning: the chunk that matched best, and how near it is (−1 to 1). `stale` when
 * the chunk's messages no longer read as they did when it was embedded (NEED-550 B).
 */
export interface ConversationHit {
  summary: ConversationSummary
  chunk: { firstMessageId: Id; lastMessageId: Id }
  score: number
  stale: boolean
}

export interface StoredReadiness {
  chatId: Id
  builtAt: string | null
  algorithmVersion: number | null
  /** Messages the current build has not seen. */
  pending: { new: number; edited: number; deleted: number }
  /** The current build's distinct chunk texts: `current` + `stale` + `missing`; `embedded` have any vector. */
  vectors: { chunks: number; embedded: number; current: number; stale: number; missing: number }
}

export interface ConversationSummary {
  id: string
  chatId: Id
  firstMessageId: Id
  firstAt: string
  lastAt: string
  messageCount: number
  /** How many people wrote in it. */
  senders: number
  builtAt: string
  algorithmVersion: number
}

/** One message as the user's agent sees it in a batch (phase 4 plan A4). */
export interface BatchMessage {
  id: Id
  at: string
  sender: { id: Id | null; name: string | null }
  text: string
  /** The message it answers, by the messenger's own record. */
  replyTo?: Id
  thread?: Id
  mentions?: Id[]
  /** `true`: the agent is asked which earlier message this one answers. `false`: context only. */
  answer: boolean
  /** For a message to answer: the current build's messenger and rule links, strongest first. */
  candidates?: { parent: Id | null; source: string; kind: string; confidence: number }[]
}

/** What the user's agent returns for a batch (phase 4 plan A5), as read from stdin. */
export interface AgentAnswer {
  /** The model that answered; stored as the link's method. */
  model: string
  /** The skill's version, when the skill sends it. */
  skill?: string
  answers: { message: Id; parent: Id | null; confidence: number }[]
}

/** A window of a chat for the agent: the messages to answer and the ones before them (A1). */
export interface LinkBatch {
  /** Names the window, so an answer can be checked against it (A3). */
  batch: string
  chat: Id
  messages: BatchMessage[]
  /** Messages still needing the agent after this batch, and their characters. */
  remaining: { messages: number; characters: number }
}

export interface StoredLink {
  /** `null`: the source says the message starts a conversation. */
  parentId: Id | null
  source: "provider" | "rule" | "agent"
  kind: string
  confidence: number
  method: string
  version: string | null
  createdAt: string
  /** An end changed after the link was written; it is not chosen. */
  stale: boolean
}

export interface Range {
  from: number
  to: number
}

export interface StoreOptions {
  path?: string
  env?: NodeJS.ProcessEnv
  now?: () => number
}

/** About 40 ms of the first open (129k rows/s measured at 1M, 2026-09-30); Tab opens the store too. */
export const BACKFILL_ON_OPEN = 5_000

export const openStore = async ({ path, env, now = Date.now }: StoreOptions = {}): Promise<MessageStore> => {
  await storeCapable()
  const file = path ?? storePath(env)
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  // Created before SQLite opens it: SQLite gives -wal and -shm the mode of the database file.
  writeFileSync(file, "", { flag: "a", mode: 0o600 })
  const { database, orm } = await openSqlite(file)
  try {
    migrate(database, { now })
    // A small file is filled on the spot; a larger one waits for `db migrate`, since nothing reads the copy yet.
    const pending = pendingNormalization(database)
    if (pending > 0 && pending <= BACKFILL_ON_OPEN) backfillNormalized(database)
    stems.followDefaultStemmers(database, now)
    const stemming = stems.stemsState(database)
    if (
      stemming?.cause === "building" &&
      stemming.watermark - stemming.filledThrough + stemming.pending <= BACKFILL_ON_OPEN
    ) {
      stems.fillStems(database, { now })
    }
  } catch (error) {
    database.close()
    throw error
  }
  return storeOver({ database, orm, now })
}

const storeOver = (context: StoreContext): MessageStore => {
  const { database } = context
  const stemmerFor = stems.stemmerCache()
  const inTransaction = (body: () => void): void => {
    database.exec("BEGIN IMMEDIATE")
    try {
      body()
      stems.drainStems(database, stemmerFor)
      database.exec("COMMIT")
    } catch (error) {
      database.exec("ROLLBACK")
      throw error
    }
  }

  const accountPk = (key: AccountKey, name: string | null = null) => accounts.accountPk(context, key, name)
  const findAccountPk = (key: AccountKey) => accounts.findAccountPk(context, key)

  const findChatPk = (accountKey: number, chatId: Id) => chatQueries.findChatPk(context, accountKey, chatId)
  const chatKeyOf = (key: AccountKey, chatId: Id) => {
    const accountKey = findAccountPk(key)
    return accountKey === undefined ? undefined : findChatPk(accountKey, chatId)
  }
  const chatPkFor = (accountKey: number, chatId: Id) => chatQueries.chatPkFor(context, accountKey, chatId)

  const identityPk = (
    accountKey: number,
    provider: Provider,
    nativeId: Id,
    name: string | null,
    facts?: Omit<PersonFacts, "id" | "name">,
  ) => identities.identityPk(context, accountKey, provider, nativeId, name, facts)

  const upsertMessage = (
    key: AccountKey,
    accountKey: number,
    chatKey: number,
    message: Message,
    via: string,
    seenAt?: number,
  ) => messageWrites.upsertMessage(context, key, accountKey, chatKey, message, via, seenAt)

  const writeMembers = (key: AccountKey, accountKey: number, chatId: Id, memberIds: Id[]) =>
    chatQueries.writeMembers(context, key, accountKey, chatId, memberIds)

  const writeState = (accountKey: number, name: string, value: string) =>
    sync.writeState(context, accountKey, name, value)
  let botUpdates: BotUpdateStore | undefined
  let involvements: InvolvementStore | undefined
  let tasks: MessageStore["tasks"] | undefined
  let knowledge: MessageStore["knowledge"] | undefined
  let notes: MessageStore["notes"] | undefined
  let decisions: MessageStore["decisions"] | undefined
  let memories: MessageStore["memories"] | undefined
  let proposedActions: MessageStore["proposedActions"] | undefined
  let agentActions: MessageStore["agentActions"] | undefined
  let meetings: MessageStore["meetings"] | undefined
  let mail: MessageStore["mail"] | undefined

  return {
    saveAccount: async (key, { name }) => accountPk(key, name),

    saveChats: async (key, list) =>
      inTransaction(() => {
        const accountKey = accountPk(key)
        for (const chat of list) chatQueries.upsertChat(context, accountKey, chat)
      }),

    saveMessages: async (key, chatId, messages, { via, seenAt }) =>
      inTransaction(() => {
        const accountKey = accountPk(key)
        const chatKey = chatPkFor(accountKey, chatId)
        for (const message of messages) {
          if (message.scheduledFor === undefined) upsertMessage(key, accountKey, chatKey, message, via, seenAt)
        }
      }),

    saveMembers: async (key, chatId, memberIds) =>
      inTransaction(() => writeMembers(key, accountPk(key), chatId, memberIds)),

    saveRoster: async (key, chatId, read) => {
      let change: RosterChange = { joined: [], gone: [], changed: [] }
      inTransaction(() => {
        const accountKey = accountPk(key)
        change = roster.saveRoster(context, accountKey, key.provider, chatPkFor(accountKey, chatId), read)
      })
      return change
    },

    memberStays: async (key, chatId, { since } = {}) => {
      const chatKey = chatKeyOf(key, chatId)
      return chatKey === undefined
        ? []
        : roster.memberStaysOf(context, chatKey, since === undefined ? undefined : Date.parse(since))
    },

    memberCounts: async (key, chatId, { since } = {}) => {
      const chatKey = chatKeyOf(key, chatId)
      return chatKey === undefined ? [] : roster.memberCountsOf(context, chatKey, since)
    },

    profileRevisions: async (key, chatId, { since } = {}) => {
      const chatKey = chatKeyOf(key, chatId)
      return chatKey === undefined
        ? []
        : roster.profileRevisionsOf(context, chatKey, since === undefined ? undefined : Date.parse(since))
    },

    trackMembers: async (key, chatId, tracked) =>
      inTransaction(() => roster.setTracked(context, chatPkFor(accountPk(key), chatId), tracked)),

    trackedChats: async (key) => {
      const accountKey = findAccountPk(key)
      return accountKey === undefined ? [] : roster.trackedChats(context, accountKey)
    },

    members: async (key, chatId) => {
      const accountKey = findAccountPk(key)
      const chatKey = accountKey === undefined ? undefined : findChatPk(accountKey, chatId)
      return chatKey === undefined ? [] : chatQueries.members(context, chatKey)
    },

    personOf: async (identity) => personLinks.personOf(context, identity),
    personByUid: async (uid) => personLinks.personByUid(context, uid),
    linkIdentities: async (person, other, options) => {
      let linked: PersonRecord | undefined
      inTransaction(() => {
        linked = personLinks.linkIdentities(context, person, other, options)
      })
      return linked as PersonRecord
    },
    unlinkIdentity: async (identity, options) => {
      let alone: PersonRecord | undefined
      inTransaction(() => {
        alone = personLinks.unlinkIdentity(context, identity, options)
      })
      return alone as PersonRecord
    },
    mentioning: async (key, person, limit) => {
      const accountKey = findAccountPk(key)
      return accountKey === undefined
        ? { items: [], hasMore: false }
        : personLinks.mentioning(context, accountKey, person, limit)
    },

    chatsWith: async (key, memberId) => {
      const accountKey = findAccountPk(key)
      return accountKey === undefined ? [] : chatQueries.chatsWith(context, accountKey, key, memberId)
    },

    syncState: async (key, name) => {
      const accountKey = findAccountPk(key)
      return accountKey === undefined ? undefined : sync.syncStateOf(context, accountKey, name)
    },

    setSyncState: async (key, name, value) => inTransaction(() => writeState(accountPk(key), name, value)),

    applyDelta: async (key, { chats = [], people = [], members = new Map(), state = {} }) =>
      inTransaction(() => {
        const accountKey = accountPk(key)
        for (const chat of chats) chatQueries.upsertChat(context, accountKey, chat)
        for (const person of people) identityPk(accountKey, key.provider, person.id, person.name, person)
        for (const [chatId, ids] of members) writeMembers(key, accountKey, chatId, ids)
        for (const [name, value] of Object.entries(state)) writeState(accountKey, name, value)
      }),

    clearSyncState: async (key, name) => {
      const accountKey = findAccountPk(key)
      if (accountKey !== undefined) sync.clearState(context, accountKey, name)
    },

    claim: async (key, chatId, anchor, holder, forMs) => {
      let taken = false
      inTransaction(() => {
        taken = sync.claim(context, chatPkFor(accountPk(key), chatId), anchor, holder, forMs)
      })
      return taken
    },

    release: async (key, chatId, anchor, holder) => {
      const accountKey = findAccountPk(key)
      const chatKey = accountKey === undefined ? undefined : findChatPk(accountKey, chatId)
      if (chatKey !== undefined) sync.release(context, chatKey, anchor, holder)
    },

    transcript: async (key, chatId, messageId) => {
      const accountKey = findAccountPk(key)
      const chatKey = accountKey === undefined ? undefined : findChatPk(accountKey, chatId)
      return chatKey === undefined ? undefined : transcripts.transcript(context, chatKey, messageId)
    },

    keepTranscript: async (key, chatId, messageId, text, source) => {
      if (text.trim() === "") return
      inTransaction(() =>
        transcripts.keepTranscript(context, chatPkFor(accountPk(key), chatId), messageId, text, source),
      )
    },

    fileAttachments: async (key, { chatId, ...page }) => {
      const accountKey = findAccountPk(key)
      if (accountKey === undefined) return []
      if (chatId === undefined) return attachmentTexts.fileAttachments(context, accountKey, page)
      const chatKey = findChatPk(accountKey, chatId)
      return chatKey === undefined ? [] : attachmentTexts.fileAttachments(context, accountKey, { ...page, chatKey })
    },

    attachments: async (key, { chatId, ...filter }) => {
      const accountKey = findAccountPk(key)
      if (accountKey === undefined) return []
      if (chatId === undefined) return attachmentTexts.attachmentViews(context, accountKey, filter)
      const chatKey = findChatPk(accountKey, chatId)
      return chatKey === undefined ? [] : attachmentTexts.attachmentViews(context, accountKey, { ...filter, chatKey })
    },

    localPathOf: async (attachmentPk) => attachmentTexts.localPathOf(context, attachmentPk),

    keepAttachmentText: async (attachmentPk, entry) => {
      let kept = false
      inTransaction(() => {
        kept = attachmentTexts.keepText(context, attachmentPk, entry)
      })
      return kept
    },

    keepDownloads: async (key, chatId, messageId, files) => {
      const chatKey = chatKeyOf(key, chatId)
      if (chatKey === undefined || files.length === 0) return 0
      let kept = 0
      inTransaction(() => {
        kept = attachmentRows.keepDownloads(context, chatKey, messageId, files)
      })
      return kept
    },

    linkInputs: async (key, chatId, page) => {
      const chatKey = chatKeyOf(key, chatId)
      return chatKey === undefined ? { items: [], next: null } : conversationQueries.linkInputs(context, chatKey, page)
    },

    senderHandles: async (key, chatId) => {
      const chatKey = chatKeyOf(key, chatId)
      return chatKey === undefined ? new Map() : conversationQueries.senderHandles(context, chatKey)
    },

    replaceConversations: async (key, chatId, build) => {
      const chatKey = chatKeyOf(key, chatId)
      if (chatKey === undefined) throw new CliError("not_found", `chat ${chatId} is not in the local copy`)
      await conversationQueries.replaceConversations(context, chatKey, build)
    },

    conversations: async (key, chatId, { limit, after, before }) => {
      const chatKey = chatKeyOf(key, chatId)
      return chatKey === undefined
        ? { items: [], hasMore: false }
        : conversationQueries.conversationPage(context, chatKey, {
            limit,
            ...(after === undefined ? {} : { after: toMs(after) as number }),
            ...(before === undefined ? {} : { before: toMs(before) as number }),
          })
    },

    conversation: async (key, id) => {
      const accountKey = findAccountPk(key)
      const pk = Number(id)
      return accountKey === undefined || !Number.isSafeInteger(pk)
        ? undefined
        : conversationQueries.conversation(context, accountKey, pk)
    },

    conversationOf: async (key, chatId, messageId) => {
      const chatKey = chatKeyOf(key, chatId)
      return chatKey === undefined ? undefined : conversationQueries.conversationOf(context, chatKey, messageId)
    },

    conversationsOfMessages: async (key, refs) => {
      const accountPk = findAccountPk(key)
      if (accountPk === undefined) return refs.map(() => undefined)
      const pks = refs.map(({ chatId, messageId }) => {
        const chatKey = findChatPk(accountPk, chatId)
        const id = chatKey === undefined ? undefined : conversationQueries.conversationOf(context, chatKey, messageId)
        return id === undefined ? undefined : Number(id)
      })
      const found = conversationQueries.summariesOf(
        context,
        accountPk,
        pks.filter((pk) => pk !== undefined),
      )
      return pks.map((pk) => (pk === undefined ? undefined : found.get(pk)))
    },

    links: async (key, chatId, messageId, options) => {
      const chatKey = chatKeyOf(key, chatId)
      return chatKey === undefined ? [] : conversationQueries.linksOf(context, chatKey, messageId, options?.limit)
    },

    replies: async (key, chatId, messageId, limit) => {
      const chatKey = chatKeyOf(key, chatId)
      return chatKey === undefined
        ? { items: [], hasMore: false }
        : conversationQueries.repliesTo(context, chatKey, messageId, limit)
    },

    agentAnswers: async (key, chatId) => {
      const chatKey = chatKeyOf(key, chatId)
      return chatKey === undefined ? new Map() : conversationQueries.agentAnswers(context, chatKey)
    },

    saveAnswers: async (key, batch, answer) => {
      const chatKey = batches.chatOfBatch(batch)
      const accountKey = findAccountPk(key)
      const chat =
        chatKey === undefined || accountKey === undefined ? undefined : chatQueries.chatOf(context, accountKey, chatKey)
      if (chatKey === undefined || chat === undefined) {
        throw new CliError("validation_error", `the answer was not stored: ${batch} is not a batch of this account`)
      }
      let stored = 0
      inTransaction(() => {
        stored = batches.saveAnswers(context, batch, answer)
      })
      return { chat, stored }
    },

    clearAnswers: async (key, chatId, model) => {
      const chatKey = chatKeyOf(key, chatId)
      if (chatKey === undefined) return 0
      let cleared = 0
      inTransaction(() => {
        cleared = batches.clearAnswers(context, chatKey, model)
      })
      return cleared
    },

    batchStatus: async (key, chatId) => {
      const chatKey = chatKeyOf(key, chatId)
      return chatKey === undefined ? { messages: 0, characters: 0 } : batches.batchStatus(context, chatKey)
    },

    nextBatch: async (key, chatId, { size }) => {
      const chatKey = chatKeyOf(key, chatId)
      if (chatKey === undefined) return undefined
      const found = batches.nextBatch(context, chatKey, chatId, size)
      if (!found) return undefined
      const answered = found.messages.filter(({ answer }) => answer)
      const left = batches.batchStatus(context, chatKey)
      return {
        ...found,
        remaining: {
          messages: left.messages - answered.length,
          characters: left.characters - answered.reduce((sum, { text }) => sum + [...text].length, 0),
        },
      }
    },

    chunksToEmbed: async (key, chatId, model, options) => {
      const chatKey = chatKeyOf(key, chatId)
      return chatKey === undefined ? [] : vectors.chunksToEmbed(context, chatKey, model, options)
    },

    saveVectors: async (model, dims, rows) => {
      inTransaction(() => vectors.saveVectors(context, model, dims, rows))
    },

    vectorStatus: async (key, chatId, model) => {
      const chatKey = chatKeyOf(key, chatId)
      return chatKey === undefined ? { chunks: 0, embedded: 0 } : vectors.vectorStatus(context, chatKey, model)
    },

    clearVectors: async (key, chatId, model) => {
      const chatKey = chatKeyOf(key, chatId)
      if (chatKey === undefined) return 0
      let cleared = 0
      inTransaction(() => {
        cleared = vectors.clearVectors(context, chatKey, model)
      })
      return cleared
    },

    nearestConversations: async (
      key,
      { chatId, model, since, limit, query, exclude, conversations, scope, projectId, personId, before },
    ) => {
      const accountPk = findAccountPk(key)
      if (accountPk === undefined) return []
      const chatKey = chatId === undefined ? undefined : chatKeyOf(key, chatId)
      if (chatId !== undefined && chatKey === undefined) return []
      const nearest = vectors.nearestChunks(context, accountPk, {
        ...(chatKey === undefined ? {} : { chatKey }),
        ...(since === undefined ? {} : { since: Date.parse(since) }),
        ...(exclude === undefined ? {} : { exclude: Number(exclude) }),
        model,
        limit,
        query,
        ...(conversations === undefined ? {} : { conversations }),
        ...(scope === undefined ? {} : { scope }),
        ...(projectId === undefined ? {} : { projectId: Number(projectId) }),
        ...(personId === undefined ? {} : { personId: Number(personId) }),
        ...(before === undefined ? {} : { before: Date.parse(before) }),
      })
      const found = conversationQueries.summariesOf(
        context,
        accountPk,
        nearest.map(({ conversationPk }) => conversationPk),
      )
      const ids = vectors.messageIds(
        context,
        nearest.flatMap(({ firstMessagePk, lastMessagePk }) => [firstMessagePk, lastMessagePk]),
      )
      return nearest.flatMap((chunk) => {
        const summary = found.get(chunk.conversationPk)
        const first = ids.get(chunk.firstMessagePk)
        const last = ids.get(chunk.lastMessagePk)
        const freshness = vectors.chunkFreshness(context, chunk)
        return summary && first && last && freshness !== "deleted"
          ? [
              {
                summary,
                chunk: { firstMessageId: first, lastMessageId: last },
                score: chunk.score,
                stale: freshness === "stale",
              },
            ]
          : []
      })
    },

    conversationVectors: async (key, id, model) => {
      const accountPk = findAccountPk(key)
      const pk = Number(id)
      if (accountPk === undefined || !conversationQueries.summariesOf(context, accountPk, [pk]).has(pk)) {
        return { chunks: 0, vectors: [] }
      }
      return vectors.conversationVectors(context, pk, model)
    },

    readiness: async (key, { chatId, model }) => {
      const accountPk = findAccountPk(key)
      if (accountPk === undefined) return []
      const chats =
        chatId === undefined
          ? vectors.builtChats(context, accountPk)
          : [{ chatKey: chatKeyOf(key, chatId), id: chatId }].flatMap(({ chatKey, id }) =>
              chatKey === undefined ? [] : [{ chatKey, id }],
            )
      return chats.map(({ chatKey, id }) => {
        const found = vectors.readiness(context, chatKey, model)
        return found
          ? { chatId: id, ...found, builtAt: new Date(found.builtAt).toISOString() }
          : {
              chatId: id,
              builtAt: null,
              algorithmVersion: null,
              pending: { new: 0, edited: 0, deleted: 0 },
              vectors: { chunks: 0, embedded: 0, current: 0, stale: 0, missing: 0 },
            }
      })
    },

    unbuiltGroups: async (key) => {
      const accountPk = findAccountPk(key)
      return accountPk === undefined ? [] : vectors.unbuiltGroups(context, accountPk)
    },

    embeddedOnlyElsewhere: async (key, { chatId, model }) => {
      const accountPk = findAccountPk(key)
      if (accountPk === undefined) return []
      const chatKey = chatId === undefined ? undefined : chatKeyOf(key, chatId)
      if (chatId !== undefined && chatKey === undefined) return []
      return vectors.embeddedOnlyElsewhere(context, accountPk, { ...(chatKey === undefined ? {} : { chatKey }), model })
    },

    conversationState: async (key, chatId) => {
      const chatKey = chatKeyOf(key, chatId)
      return chatKey === undefined ? undefined : conversationQueries.stateOf(context, chatKey)
    },

    chats: async (key, window) => {
      const accountKey = findAccountPk(key)
      return accountKey === undefined
        ? { items: [], hasMore: false }
        : chatQueries.listChats(context, accountKey, window)
    },

    countChats: async (key, filter = {}) => {
      const accountKey = findAccountPk(key)
      return accountKey === undefined ? 0 : chatQueries.countChats(context, accountKey, filter)
    },

    countMessages: async (key, chatId, { since } = {}) => {
      const chatKey = chatKeyOf(key, chatId)
      return chatKey === undefined ? 0 : reads.countMessages(context, chatKey, since)
    },

    changes: async (key, chatId, at) => {
      const chatKey = chatKeyOf(key, chatId)
      return chatKey === undefined
        ? { messages: [], deleted: [] }
        : reads.changesSince(context, chatKey, Date.parse(at))
    },

    messagesWindow: async (key, chatId, window) => {
      const chatKey = chatKeyOf(key, chatId)
      return chatKey === undefined ? [] : reads.messagesWindow(context, chatKey, window)
    },

    messages: async (key, chatId, window) => {
      const chatKey = chatKeyOf(key, chatId)
      return chatKey === undefined ? { items: [], hasMore: false } : reads.messagePage(context, chatKey, window)
    },

    around: async (key, chatId, messageId, window) => reads.around(context, chatKeyOf(key, chatId), messageId, window),

    message: async (key, messageId, { chatId } = {}) => {
      const accountKey = findAccountPk(key)
      return accountKey === undefined ? undefined : reads.message(context, accountKey, messageId, chatId)
    },

    markDeleted: async (key, messageIds, { chatId, among } = {}) => {
      const accountKey = findAccountPk(key)
      if (accountKey === undefined || messageIds.length === 0) return 0
      let changed = 0
      inTransaction(() => {
        changed = messageWrites.markDeleted(context, accountKey, messageIds, chatId, among)
      })
      return changed
    },

    purge: async (key) => {
      const accountKey = findAccountPk(key)
      if (accountKey === undefined) return
      inTransaction(() => accounts.purgeAccount(context, accountKey))
    },

    markChatsLeft: async (key, present) => {
      const accountKey = findAccountPk(key)
      if (accountKey === undefined) return 0
      let marked = 0
      inTransaction(() => {
        marked = chatQueries.markLeft(context, accountKey, present)
        writeState(accountKey, completeness.CHAT_LIST_KEY, String(present.length))
      })
      return marked
    },

    leftChats: async (key, { clear = false } = {}) => {
      const accountKey = findAccountPk(key)
      if (accountKey === undefined) return { chats: 0, messages: 0 }
      let found = { pks: [] as number[], messages: 0 }
      inTransaction(() => {
        found = chatQueries.leftChats(context, accountKey)
        if (clear) chatQueries.purgeChats(context, found.pks)
      })
      return { chats: found.pks.length, messages: found.messages }
    },

    search: async (query, { limit, account }) =>
      search.find(context, { text: query, limit, ...(account ? { account } : {}) }),

    find: async (filter) => (filter.pattern ? findRegex(context, filter) : search.find(context, filter)),

    rankingDiscussionChats: async (account, chatId) => {
      const rows = database
        .prepare(
          "SELECT DISTINCT json_extract(CASE WHEN json_valid(m.metadata) THEN m.metadata ELSE '{}' END,'$.graph.discussionChatId') AS id FROM messages m JOIN chats c ON c.id=m.chat_id JOIN accounts ac ON ac.id=m.account_id WHERE ac.provider=? AND ac.external_id=? AND c.external_id=? AND c.kind='channel' AND m.deleted_at IS NULL AND json_extract(CASE WHEN json_valid(m.metadata) THEN m.metadata ELSE '{}' END,'$.graph.version')=1 AND json_type(CASE WHEN json_valid(m.metadata) THEN m.metadata ELSE '{}' END,'$.graph.discussionChatId')='text' LIMIT 101",
        )
        .all(account.provider, account.account, chatId)
      if (rows.length > 100)
        throw new CliError("validation_error", "too many linked discussion groups — narrow the channel scope")
      return rows.map(({ id }) => String(id))
    },
    rankingEvidence: async (execution, request) => rankingEvidence(context, execution, request),
    retention: async (key, chatId, options, evidence) => {
      const accountKey = findAccountPk(key)
      const chatKey = accountKey === undefined ? undefined : findChatPk(accountKey, chatId)
      if (accountKey === undefined || chatKey === undefined)
        throw new CliError("validation_error", "retention needs a stored chat and membership observations")
      context.database.exec("BEGIN")
      try {
        const result = retentionQuery(context, accountKey, chatKey, chatId, options, evidence)
        context.database.exec("COMMIT")
        return result
      } catch (error) {
        context.database.exec("ROLLBACK")
        throw error
      }
    },
    adminStatisticsQuery: async (execution, request) => adminStatisticsQuery(context, execution, request),
    rankQuery: async (execution, request) => rankQuery(context, execution, request),
    directReplies: async (parents, limit) => search.directReplies(context, parents, limit),
    matchQuery: async (execution) => lucene.matchQuery(context, execution),
    conversationEligibility: async (execution) => conversationEligibility(context, execution),
    countQuery: async (execution, by) => lucene.countQuery(context, execution, by),

    matchWords: async (query, scope, options) => words.matchWords(context, query, scope, options),

    matchSubstring: async (query, scope, options) => words.matchSubstring(context, query, scope, options),

    attachmentKinds: async () =>
      database
        .prepare("SELECT DISTINCT kind FROM attachments ORDER BY kind")
        .all()
        .map((row) => String(row.kind)),

    matchFilters: async (scope, options) => words.matchFilters(context, scope, options),

    accounts: async () => accounts.heldAccounts(context),
    storedAccounts: async () => accounts.storedAccounts(context),
    storedAccount: async (key) => accounts.storedAccount(context, key),
    accountName: async (key) => accounts.accountName(context, key),

    chatCompleteness: async (key, chatIds) => {
      const accountKey = accounts.findAccountPk(context, key)
      return accountKey === undefined ? [] : completeness.chatCompleteness(context, accountKey, chatIds)
    },

    knownTerms: async (terms) => words.knownTerms(context, terms),

    termCandidates: async (trigrams, lengths) => words.termCandidates(context, trigrams, lengths),

    searchIndexState: async () => searchIndex.searchIndexState(database),

    fillSearchIndex: async ({ until } = {}) =>
      searchIndex.fillSearchIndex(database, { now: context.now, ...(until ? { until } : {}) }),

    stemsState: async () => stems.stemsState(database),

    fillStems: async ({ until } = {}) => stems.fillStems(database, { now: context.now, ...(until ? { until } : {}) }),

    stemmers: async () => stems.savedStemmers(database),

    saveStemmers: async (stemmers) => inTransaction(() => stems.saveStoreStemmers(database, stemmers, context.now())),

    contacts: async (key, options) => {
      const accountKey = findAccountPk(key)
      if (accountKey === undefined) return { items: [], hasMore: false }
      return identities.contacts(context, accountKey, key, options)
    },

    countContacts: async (key, { query } = {}) => {
      const accountKey = findAccountPk(key)
      return accountKey === undefined ? 0 : identities.countContacts(context, accountKey, key, query)
    },

    refreshRecency: async (key) => {
      const accountKey = findAccountPk(key)
      if (accountKey !== undefined) identities.refreshRecency(context, accountKey)
    },

    savePeople: async (key, people) =>
      inTransaction(() => {
        const accountKey = accountPk(key)
        for (const person of people) identityPk(accountKey, key.provider, person.id, person.name, person)
      }),

    people: async (provider, options = {}) => identities.people(context, provider, options),

    counterTargets: async (execution, options) => counterTargets(context, execution, options),
    counterStates: async (key, chatId, messageId, options) => {
      const row = database
        .prepare(
          "SELECT m.id AS pk FROM messages m JOIN chats c ON c.id=m.chat_id JOIN accounts ac ON ac.id=m.account_id WHERE ac.provider=? AND ac.external_id=? AND c.external_id=? AND m.external_id=? AND m.deleted_at IS NULL",
        )
        .get(key.provider, key.account, chatId, messageId)
      return row ? counterStates(context, Number(row.pk), options.now, options.maxAge) : []
    },
    updateCounterObservations: async (key, chatId, messageId, observations) => {
      let updated = 0
      inTransaction(() => {
        const row = database
          .prepare(
            "SELECT m.id AS pk FROM messages m JOIN chats c ON c.id=m.chat_id JOIN accounts ac ON ac.id=m.account_id WHERE ac.provider=? AND ac.external_id=? AND c.external_id=? AND m.external_id=? AND m.deleted_at IS NULL",
          )
          .get(key.provider, key.account, chatId, messageId)
        if (row) updated = applyCounterObservations(context, Number(row.pk), observations)
      })
      return updated
    },
    saveReactions: async (key, chatId, messageId, reactions, options = {}) => {
      const accountKey = findAccountPk(key)
      const chatKey = accountKey === undefined ? undefined : findChatPk(accountKey, chatId)
      if (chatKey === undefined) return false
      let saved = false
      inTransaction(() => {
        saved = messageWrites.saveReactions(context, chatKey, messageId, reactions)
        const row = database
          .prepare("SELECT id AS pk FROM messages WHERE chat_id=? AND external_id=? AND deleted_at IS NULL")
          .get(chatKey, messageId)
        if (row && options.observation)
          applyCounterObservations(context, Number(row.pk), { reactions: options.observation })
      })
      return saved
    },

    markRange: async (key, chatId, from, to) => {
      let merged: Range = { from, to }
      inTransaction(() => {
        merged = ranges.markRange(context, chatPkFor(accountPk(key), chatId), from, to)
      })
      return merged
    },

    senderStats: async (key, senderId) => {
      const accountKey = findAccountPk(key)
      return accountKey === undefined ? [] : reads.senderStats(context, accountKey, key.provider, senderId)
    },

    personNames: async (key, personId) => {
      const accountKey = findAccountPk(key)
      return accountKey === undefined ? [] : identities.namesOf(context, accountKey, key.provider, personId)
    },

    chatStats: async (key, chatId) => {
      const accountKey = findAccountPk(key)
      return accountKey === undefined ? [] : reads.chatStats(context, accountKey, chatId)
    },

    ranges: async (key, chatId) => {
      const accountKey = findAccountPk(key)
      const chatKey = accountKey === undefined ? undefined : findChatPk(accountKey, chatId)
      return chatKey === undefined ? [] : ranges.ranges(context, chatKey)
    },

    chatMetadata: async (key, chatId) => metadataQueries.metadata(context, key, chatId),
    saveChatMetadata: async (key, entry) => metadataQueries.saveMetadata(context, key, entry),
    replaceAutoTags: async (key, chatId, algorithm, matches) =>
      inTransaction(() => metadataQueries.replaceAutoTags(context, key, chatId, algorithm, matches)),
    privateContact: async (key, person) => privatePeople.privateContact(context, key, person),
    setContactAlias: async (key, person, alias) => {
      let result: { personId: Id; alias: string | null } | undefined
      inTransaction(() => {
        result = privatePeople.setAlias(context, key, person, alias)
      })
      return result as { personId: Id; alias: string | null }
    },
    addContactNote: async (key, person, text) => {
      let added: PrivateContactNote | undefined
      inTransaction(() => {
        added = privatePeople.addNote(context, key, person, text)
      })
      return added as PrivateContactNote
    },
    contactNote: async (key, person, id) => privatePeople.note(context, key, person, id),
    editContactNote: async (key, person, id, text, revision) => {
      let edited: PrivateContactNote | undefined
      inTransaction(() => {
        edited = privatePeople.editNote(context, key, person, id, text, revision)
      })
      return edited as PrivateContactNote
    },
    removeContactNote: async (key, person, id) => privatePeople.removeNote(context, key, person, id),

    addTags: async (key, target, list) => {
      let added: string[] = []
      inTransaction(() => {
        added = tagQueries.addTags(context, tagQueries.targetThing(context, key, target), list)
      })
      return added
    },

    removeTags: async (key, target, list, source) => {
      let removed: string[] = []
      inTransaction(() => {
        removed = tagQueries.removeTags(context, tagQueries.targetThing(context, key, target), list, source)
      })
      return removed
    },

    tags: async (key, filter = {}) => tagQueries.tagsOf(context, key, filter),

    recordSearch: async (run, { saved } = {}) => inTransaction(() => searchRecords.recordRun(context, run, saved)),

    saveSearch: async (name, search, { replace = false } = {}) => {
      let saved: StoredSearch | undefined
      inTransaction(() => {
        saved = searchRecords.saveSearch(context, name, search, replace)
      })
      return saved as StoredSearch
    },

    storedSearch: async (reference) => searchRecords.findSearch(context, reference),

    savedSearches: async () => searchRecords.savedSearches(context),

    searchHistory: async (limit) => searchRecords.searchHistory(context, limit),

    deleteSearch: async (reference) => {
      let deleted: StoredSearch | undefined
      inTransaction(() => {
        deleted = searchRecords.deleteSearch(context, reference)
      })
      return deleted as StoredSearch
    },

    clearSearchHistory: async () => {
      let cleared = 0
      inTransaction(() => {
        cleared = searchRecords.clearHistory(context)
      })
      return cleared
    },

    // Built on first use: an area that prepares its statements must not stop the store opening for the rest.
    get botUpdates() {
      botUpdates ??= botUpdateStoreOver(context)
      return botUpdates
    },
    get involvements() {
      involvements ??= involvementStoreOver(context)
      return involvements
    },
    get tasks() {
      tasks ??= taskStoreOver(database, context.now)
      return tasks
    },
    get knowledge() {
      knowledge ??= knowledgeStoreOver(context)
      return knowledge
    },
    get notes() {
      notes ??= { ...notesStoreOver(context), ...noteSearchOver(context) }
      return notes
    },
    get decisions() {
      decisions ??= decisionsStoreOver(context)
      return decisions
    },
    get memories() {
      memories ??= memoriesStoreOver(context)
      return memories
    },
    get proposedActions() {
      proposedActions ??= proposedActionsStoreOver(context)
      return proposedActions
    },
    get agentActions() {
      agentActions ??= agentActionsStoreOver(context)
      return agentActions
    },
    get meetings() {
      meetings ??= meetingStoreOver(context)
      return meetings
    },
    get mail() {
      mail ??= mailStoreOver(context)
      return mail
    },

    close: async () => database.close(),
  }
}

export type { CounterField, CounterObservations, CounterState } from "../domain/counters.js"
export type { RetentionOptions } from "../domain/retention.js"
export type { AdminStoreRequest, AdminStoreResult } from "./sqlite/admin-statistics.js"
export type { AttachmentTextEntry, AttachmentView, FileAttachment, TextOrigin } from "./sqlite/attachment-texts.js"
export { CHAT_LIST_KEY, type ChatCompleteness, fetchedKey, historyStartKey } from "./sqlite/completeness.js"
export type { RankedEvidence, RankingEvidenceItem, RankingEvidenceRequest } from "./sqlite/ranking-evidence.js"
export type { RankedStoreFound, RankedStoreRow, RankingRequest } from "./sqlite/rankings.js"
export type { RetentionResult } from "./sqlite/retention.js"
export type {
  MemberCount,
  MemberStay,
  ProfileRevision,
  RosterChange,
  RosterRead,
  TrackedChat,
} from "./sqlite/roster.js"
export type { SearchCommand, SearchRecord, StoredSearch } from "./sqlite/searches.js"
export type { StoredTag, TagFilter, TagTarget } from "./sqlite/tags.js"
export type { ScoredHit, SearchScope, WordOptions, WordQuery } from "./sqlite/words.js"
