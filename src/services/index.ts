import { type BotCheckService, botCheckService } from "../botcheck/service.js"
import { type AccountService, accountService } from "./account.js"
import { type AdminService, adminService } from "./admin.js"
import { type AdminStatisticsService, adminStatisticsService } from "./admin-statistics.js"
import { type ArchiveService, archiveService } from "./archive.js"
import { gapsService } from "./archive-gaps.js"
import { type AttachmentsService, attachmentsService } from "./attachments.js"
import { type ChatsService, chatsService } from "./chats.js"
import { type ConversationsService, conversationsService } from "./conversations.js"
import { type CountersService, countersService } from "./counters.js"
import type { ServiceDeps } from "./deps.js"
import { type EmbeddingsService, embeddingsService } from "./embeddings.js"
import { type FoldersService, foldersService } from "./folders.js"
import { type InboxService, inboxService } from "./inbox.js"
import { type MessagesService, messagesService } from "./messages.js"
import { metadataService } from "./metadata.js"
import { type ModerationService, moderationService } from "./moderation.js"
import { type PeopleService, peopleService } from "./people.js"
import { privatePeopleService } from "./private-people.js"
import { type RankingsService, rankingsService } from "./rankings.js"
import { type RetentionService, retentionService } from "./retention.js"
import { type SearchesService, searchesService } from "./searches.js"
import { type TagsService, tagsService } from "./tags.js"
import { type TasksService, tasksService } from "./tasks.js"
import { type TopicsService, topicsService } from "./topics.js"

export type { AccountService } from "./account.js"
export { accountService } from "./account.js"
export type { AdminService, NewGroup } from "./admin.js"
export { adminService } from "./admin.js"
export type { ArchiveService, Fetched, FetchOptions } from "./archive.js"
export { archiveService } from "./archive.js"
export type {
  AttachmentItem,
  AttachmentsService,
  AttachmentTextSet,
  ExtractItem,
  ExtractOptions,
  ExtractRun,
  ExtractStatus,
} from "./attachments.js"
export { attachmentsService } from "./attachments.js"
export type { ChatFilter, ChatsService, MarkedRead, PageWindow } from "./chats.js"
export { CHAT_SCAN, chatsService, EVENTS_DAYS } from "./chats.js"
export type { BatchStatus, Built, ConversationsService, MessageLinks } from "./conversations.js"
export { BATCH_SIZE, conversationsService } from "./conversations.js"
export type { ServiceDeps } from "./deps.js"
export { OFFLINE, onlineDeps, storedDeps, storeOnlyDeps } from "./deps.js"
export type { Embedded, EmbeddingsService, EmbedStatus, FoundConversation } from "./embeddings.js"
export { embeddingsService } from "./embeddings.js"
export type { EvidenceKind, EvidenceMessage, EvidencePacket, EvidencePacketInput, EvidenceSource } from "./evidence.js"
export { prepareEvidencePacket } from "./evidence.js"
export type { EvidenceReadQuery, StoredEvidencePacket } from "./evidence-read.js"
export { readEvidencePacket } from "./evidence-read.js"
export type { FolderEdit, FoldersService } from "./folders.js"
export { foldersService } from "./folders.js"
export type { InboxService } from "./inbox.js"
export { inboxService } from "./inbox.js"
export type {
  AroundWindow,
  FoundMessage,
  ListWindow,
  MessagesService,
  MessageTarget,
  Pinned,
  Reacted,
  SearchFound,
  SearchQuery,
  SendRequest,
} from "./messages.js"
export { DELETE_AT_ONCE, messagesService, searchStore, storedChatId } from "./messages.js"
export type { ModerateOptions, ModerationService, ShownRules } from "./moderation.js"
export { moderationService } from "./moderation.js"
export type { ContactSync, PeopleService } from "./people.js"
export { peopleService, phoneOf } from "./people.js"
export type {
  ContextMessage,
  ContextOptions,
  NotReadReason,
  PersonContext,
  SharedChat,
} from "./person-context.js"
export { CONTEXT_BYTES, CONTEXT_MESSAGES, identityIn, personContext } from "./person-context.js"
export type { PersonTimeline, Scope, TimelineItem, TimelineOptions } from "./person-timeline.js"
export { personTimeline, SCOPES, TIMELINE_ITEMS, TIMELINE_MAX } from "./person-timeline.js"
export type { RankedRow, RankingFound, RankingQuery, RankingsService } from "./rankings.js"
export { rankingsService } from "./rankings.js"
export type { ResolvedSearch, SearchesService, SearchParams } from "./searches.js"
export { searchesService, searchRecordOf } from "./searches.js"
export type { TagsAdded, TagsRemoved, TagsService, TagTargetInput, TagTargetView } from "./tags.js"
export { tagsService } from "./tags.js"
export type { TaskListFilter, TasksService, TaskView } from "./tasks.js"
export { closedStateOf, taskStateOf, tasksService, taskTypeOf, taskView } from "./tasks.js"
export { type TopicsService, topicsService } from "./topics.js"

export interface Services {
  metadata: ReturnType<typeof metadataService>
  privatePeople: ReturnType<typeof privatePeopleService>
  adminStatistics: AdminStatisticsService
  counters: CountersService
  retention: RetentionService
  rankings: RankingsService
  topics: TopicsService
  messages: MessagesService
  chats: ChatsService
  people: PeopleService
  inbox: InboxService
  archive: ArchiveService
  gaps: ReturnType<typeof gapsService>
  admin: AdminService
  folders: FoldersService
  account: AccountService
  moderation: ModerationService
  conversations: ConversationsService
  embeddings: EmbeddingsService
  tags: TagsService
  searches: SearchesService
  tasks: TasksService
  attachments: AttachmentsService
  botcheck: BotCheckService
}

/**
 * How a CLI replaces a use case: it returns the services it changes, whole, and can call the shared
 * method inside its own — `messages: { ...base.messages, list: (chat, window) => … base.messages.list … }`.
 */
export type Override = (base: Services, deps: ServiceDeps) => Partial<Services>

/** The shared services, with the messenger's `services` override applied — commands and MCP tools alike. */
export const servicesFor = (deps: ServiceDeps): Services => {
  const base: Services = {
    metadata: metadataService(deps),
    privatePeople: privatePeopleService(deps),
    adminStatistics: adminStatisticsService(deps),
    counters: countersService(deps),
    retention: retentionService(deps),
    rankings: rankingsService(deps),
    topics: topicsService(deps),
    messages: messagesService(deps),
    chats: chatsService(deps),
    people: peopleService(deps),
    inbox: inboxService(deps),
    archive: archiveService(deps),
    gaps: gapsService(deps),
    admin: adminService(deps),
    folders: foldersService(deps),
    account: accountService(deps),
    moderation: moderationService(deps),
    conversations: conversationsService(deps),
    embeddings: embeddingsService(deps),
    tags: tagsService(deps),
    attachments: attachmentsService(deps),
    searches: searchesService(deps),
    tasks: tasksService(deps),
    botcheck: botCheckService(deps),
  }
  return deps.messenger.services ? { ...base, ...deps.messenger.services(base, deps) } : base
}

export { migrateLegacyQuery, type QueryMigration, type SavedQuery } from "../search/lucene/migration.js"
export { parseLucene } from "../search/lucene/parser.js"
export { FIELD_VERSION, QUERY_FIELDS, QUERY_OPERATORS, validateAst } from "../search/lucene/registry.js"
export { type Predicate, QUERY_LIMITS, QUERY_VERSION, type QueryAst, type QueryNode } from "../search/lucene/types.js"
export type { AdminFound, AdminQuery, AdminSelection, AdminStatisticsService } from "./admin-statistics.js"
export { adminStatisticsService } from "./admin-statistics.js"
export { GAP_BOUNDS, type GapPlan, type GapRepair, gapsService, type RepairOptions } from "./archive-gaps.js"
export type { CounterQuery, CountersService } from "./counters.js"
export { countersService } from "./counters.js"
export {
  type MeetingEvidenceCue,
  type MeetingEvidenceOptions,
  type MeetingEvidencePacket,
  readMeetingEvidence,
} from "./meeting-evidence.js"
export { type MeetingReadStore, type ResolvedMeetingReference, resolveMeetingReference } from "./meeting-reference.js"
export { type MeetingTaskProposal, proposeMeetingTask } from "./meeting-task-proposal.js"
export type { QueryMetadata, SearchCoverage } from "./messages-search.js"
export { metadataService } from "./metadata.js"
export {
  embedNotes,
  type FoundNote,
  type LinkedRecord,
  type NotesEmbedded,
  type NotesEmbedOptions,
  type NotesFound,
  type NotesQuery,
  type NotesSearchRequest,
  nearestNotes,
  searchNotes,
  searchNotesQuery,
} from "./notes-search.js"
export {
  type PackageUpgradeOutcome,
  type PackageUpgradePorts,
  type PackageUpgradeResult,
  type ServerRestarts,
  upgradePackage,
} from "./package-upgrade.js"
export {
  type PersonMeetingContext,
  type PersonMeetingContextItem,
  type PersonMeetingContextOptions,
  personMeetingContext,
} from "./person-meeting-context.js"
export { privatePeopleService } from "./private-people.js"
export type { RetentionQuery, RetentionService } from "./retention.js"
export { retentionService } from "./retention.js"
export {
  RESOURCES_SEARCHED,
  type SearchAllFound,
  type SearchAllItem,
  type SearchAllRequest,
  type SearchedResource,
  searchAll,
} from "./search-all.js"
export {
  type MeetingSearchCoverage,
  type MeetingSearchCursor,
  type MeetingSearchItem,
  meetingAccountOf,
  RESOURCES_SEARCHED_WITH_MEETINGS,
  type ResourceWithMeetings,
  type SearchAllIncludingMeetingsFound,
  type SearchAllIncludingMeetingsRequest,
  type SearchAllWithMeetingsRequest,
  searchAllIncludingMeetings,
  searchAllWithMeetings,
} from "./search-all-meetings.js"
export {
  CATCH_UP_BOUNDS,
  type CatchUpOptions,
  type CatchUpResult,
  catchUpSearch,
  validateCatchUp,
} from "./search-catchup.js"
export { accountsOfKind, type SearchKind } from "./search-kind.js"
export type { SearchRefreshed, SyncOptions } from "./search-refresh.js"
export { SYNC_BOUNDS, SYNC_KEY } from "./search-refresh.js"
export {
  type Backend,
  type HitSource,
  SERVER_BOUNDS,
  SERVER_SEARCH_KEY,
  type ServerSearched,
} from "./server-search.js"
export type { ThreadContext, ThreadOptions } from "./thread-context.js"
export { readThreadContext, THREAD_BOUNDS } from "./thread-context.js"
