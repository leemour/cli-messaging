import { CliError } from "@wirecat/cli-core"
import type { Meeting, MeetingDetails, MeetingFilter, SearchHit } from "@wirecat/cli-meetings"
import type { Page } from "../domain/models.js"
import type { AttachmentTextEntry } from "./sqlite/attachment-texts.js"
import type { Email, EmailFilter, EmailThread, Mailbox, MailFilter, ThreadDetails } from "./sqlite/emails.js"
import type { AccountKey, AccountMessageFilter, MessageStore, StoredHit } from "./store.js"

// Without forAccount, whose own type is built from these.
type Store = Omit<MessageStore, "forAccount">

/** Every store method whose first argument is the account it reads or writes. */
const ACCOUNT_METHODS = [
  "saveAccount",
  "saveChats",
  "saveMessages",
  "chats",
  "countChats",
  "saveMembers",
  "members",
  "saveRoster",
  "memberStays",
  "memberCounts",
  "profileRevisions",
  "trackMembers",
  "trackedChats",
  "chatsWith",
  "syncState",
  "setSyncState",
  "clearSyncState",
  "applyDelta",
  "claim",
  "release",
  "transcript",
  "keepTranscript",
  "keepDownloads",
  "fileAttachments",
  "attachments",
  "linkInputs",
  "senderHandles",
  "replaceConversations",
  "conversations",
  "conversation",
  "conversationOf",
  "conversationsOfMessages",
  "links",
  "replies",
  "agentAnswers",
  "saveAnswers",
  "clearAnswers",
  "batchStatus",
  "nextBatch",
  "chunksToEmbed",
  "vectorStatus",
  "clearVectors",
  "nearestConversations",
  "conversationVectors",
  "readiness",
  "unbuiltGroups",
  "embeddedOnlyElsewhere",
  "conversationState",
  "messages",
  "countMessages",
  "changes",
  "messagesWindow",
  "around",
  "message",
  "purge",
  "markChatsLeft",
  "leftChats",
  "markDeleted",
  "rankingDiscussionChats",
  "retention",
  "chatCompleteness",
  "savePeople",
  "contacts",
  "countContacts",
  "refreshRecency",
  "storedAccount",
  "accountName",
  "mentioning",
  "saveReactions",
  "counterStates",
  "updateCounterObservations",
  "markRange",
  "chatStats",
  "senderStats",
  "personNames",
  "ranges",
  "chatMetadata",
  "saveChatMetadata",
  "replaceAutoTags",
  "privateContact",
  "setContactAlias",
  "addContactNote",
  "contactNote",
  "editContactNote",
  "removeContactNote",
  "addTags",
  "removeTags",
  "tags",
] as const satisfies readonly AccountMethod[]

type AccountMethod = {
  [K in keyof Store]-?: NonNullable<Store[K]> extends (first: infer A, ...rest: never[]) => unknown
    ? [A] extends [AccountKey]
      ? [AccountKey] extends [A]
        ? K
        : never
      : never
    : never
}[keyof Store]

// A new account method left out of the list fails to compile here.
type Unlisted = Exclude<AccountMethod, (typeof ACCOUNT_METHODS)[number]>
const everyMethodListed: [Unlisted] extends [never] ? true : Unlisted = true

type Bound<F> = F extends (key: AccountKey, ...rest: infer R) => infer T ? (...rest: R) => T : never
type Listed = Pick<Store, (typeof ACCOUNT_METHODS)[number]>

/** One account's mail: the thread and email ids of another account read as nothing. */
export interface AccountMail {
  threads(filter?: Omit<MailFilter, "accountId">): Promise<EmailThread[]>
  thread(id: number): Promise<ThreadDetails | null>
  email(externalId: string): Promise<Email | null>
  emails(filter?: Omit<EmailFilter, "accountId">): Promise<Email[]>
  mailboxes(): Promise<Mailbox[]>
}

/** One account's meetings: a meeting id of another account reads as nothing. */
export interface AccountMeetings {
  meetings(filter?: Omit<MeetingFilter, "accountId">): Promise<Meeting[]>
  meeting(id: number): Promise<MeetingDetails | null>
  search(query: string, filter?: Omit<MeetingFilter, "accountId">): Promise<SearchHit[]>
}

/**
 * The store with one account bound: every read and write takes the account from here, and a row id
 * of another account is not found. A read across accounts goes to the whole store, by name.
 */
export type AccountStore = { readonly account: AccountKey } & { [K in keyof Listed]: Bound<Listed[K]> } & {
  find(filter: AccountMessageFilter): Promise<Page<StoredHit>>
  search(query: string, options: { limit: number }): Promise<Page<StoredHit>>
  localPathOf(attachmentPk: number): Promise<string | null>
  keepAttachmentText(attachmentPk: number, entry: AttachmentTextEntry): Promise<boolean>
  readonly mail: AccountMail
  readonly meetings: AccountMeetings
}

/** What only the store's own tables can answer: whose an attachment row is. */
export interface AccountOwners {
  /** The account's row id; `undefined` until the account is stored. */
  accountPk(): number | undefined
  /** The account row that holds an attachment's message, email or meeting. */
  attachmentAccount(attachmentPk: number): number | undefined
}

export const bindAccount = (store: MessageStore, account: AccountKey, owners: AccountOwners): AccountStore => {
  void everyMethodListed
  const bound: Record<string, unknown> = {}
  for (const name of ACCOUNT_METHODS) {
    const method = store[name] as ((key: AccountKey, ...rest: unknown[]) => unknown) | undefined
    if (method) bound[name] = (...rest: unknown[]) => method.call(store, account, ...rest)
  }
  const ownAttachment = (attachmentPk: number) => {
    const pk = owners.accountPk()
    if (pk === undefined || owners.attachmentAccount(attachmentPk) !== pk)
      throw new CliError("not_found", `no attachment ${attachmentPk} in this account`)
  }
  const accountId = () => owners.accountPk()
  const mail: AccountMail = {
    threads: async (filter = {}) => {
      const id = accountId()
      return id === undefined ? [] : store.mail.threads({ ...filter, accountId: id })
    },
    thread: async (id) => {
      const found = await store.mail.thread(id)
      return found && found.thread.accountId === accountId() ? found : null
    },
    email: async (externalId) => {
      const id = accountId()
      return id === undefined ? null : store.mail.email(id, externalId)
    },
    emails: async (filter = {}) => {
      const id = accountId()
      return id === undefined ? [] : store.mail.emails({ ...filter, accountId: id })
    },
    mailboxes: async () => {
      const id = accountId()
      return id === undefined ? [] : store.mail.mailboxes(id)
    },
  }
  const meetings: AccountMeetings = {
    meetings: async (filter = {}) => {
      const id = accountId()
      return id === undefined ? [] : store.meetings.meetings({ ...filter, accountId: id })
    },
    meeting: async (id) => {
      const found = await store.meetings.meeting(id)
      return found && found.meeting.accountId === accountId() ? found : null
    },
    search: async (query, filter = {}) => {
      const id = accountId()
      return id === undefined ? [] : store.meetings.search(query, { ...filter, accountId: id })
    },
  }
  return {
    ...(bound as { [K in keyof Listed]: Bound<Listed[K]> }),
    account,
    find: (filter) => store.find({ ...filter, account }),
    search: (query, options) => store.search(query, { ...options, account }),
    localPathOf: async (attachmentPk) => {
      ownAttachment(attachmentPk)
      return store.localPathOf(attachmentPk)
    },
    keepAttachmentText: async (attachmentPk, entry) => {
      ownAttachment(attachmentPk)
      return store.keepAttachmentText(attachmentPk, entry)
    },
    mail,
    meetings,
  }
}
