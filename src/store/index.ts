export type { CacheDatabase, CacheStatement, OpenDatabase, SqlValue } from "./driver.js"
export { PRAGMAS } from "./driver.js"
export { MIGRATIONS, type Migration, migrate } from "./migrations.js"
export { openCache } from "./open.js"
export { storePath } from "./path.js"
export type { AgentAction, AgentActionInput, AgentActionsStore } from "./sqlite/agent-actions.js"
export { resetAttachmentWords } from "./sqlite/attachment-texts.js"
export { backfillNormalized, pendingNormalization } from "./sqlite/backfill.js"
export type { BotUpdate, BotUpdateStore } from "./sqlite/bot-updates.js"
export type { ChatMetadata } from "./sqlite/chats.js"
export type { Decision, DecisionInput, DecisionsStore } from "./sqlite/decisions.js"
export type {
  Email,
  EmailAddress,
  EmailInput,
  EmailRecipient,
  EmailThread,
  Mailbox,
  MailboxInput,
  MailFilter,
  MailStore,
  ThreadDetails,
  ThreadSave,
} from "./sqlite/emails.js"
export type { Involvement, InvolvementStore } from "./sqlite/involvements.js"
export type {
  Annotation,
  KnowledgeRelation,
  KnowledgeStore,
  KnowledgeTarget,
  LabelledType,
  Organization,
  Project,
  Reminder,
} from "./sqlite/knowledge.js"
export type { Author, MemoriesStore, Memory, MemoryInput } from "./sqlite/memories.js"
export type { NoteIndexState } from "./sqlite/note-index.js"
export {
  type NearestNote,
  NOTE_FIELDS,
  type NoteChunkToEmbed,
  type NoteHit,
  type NoteQuery,
  type NoteSearch,
} from "./sqlite/note-search.js"
export type {
  FileNoteInput,
  Link,
  LinkInput,
  Note,
  NoteFolder,
  NotesStore,
  NoteTag,
} from "./sqlite/notes.js"
export type { PrivateContact, PrivateContactNote } from "./sqlite/private-people.js"
export type { ProposalInput, ProposedAction, ProposedActionsStore } from "./sqlite/proposed-actions.js"
export {
  fillSearchIndex,
  resetSearchIndex,
  type SearchIndexFill,
  type SearchIndexState,
  searchIndexState,
} from "./sqlite/search-index.js"
export type { TagKind, TagRow } from "./sqlite/tags.js"
export type { StoreTaskStore } from "./sqlite/tasks.js"
export {
  type AccountKey,
  type AttachmentTextEntry,
  type AttachmentView,
  type ChatStats,
  type DeletionScope,
  type Delta,
  type FileAttachment,
  type IdentityRef,
  type IngestedVia,
  type LinkedIdentity,
  type LinkOptions,
  type MessageFilter,
  type MessageStore,
  openStore,
  type PersonFacts,
  type PersonRecord,
  type Range,
  type RankedEvidence,
  type RankedStoreFound,
  type RankedStoreRow,
  type RankingEvidenceItem,
  type RankingEvidenceRequest,
  type RankingRequest,
  type SearchCommand,
  type SearchRecord,
  type StoredAccount,
  type StoredChatFilter,
  type StoredHit,
  type StoredSearch,
  type StoredTag,
  type StoreOptions,
  type TagFilter,
  type TagTarget,
  type TextOrigin,
} from "./store.js"
