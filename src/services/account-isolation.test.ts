import { afterEach, describe, expect, it, vi } from "vitest"
import type { Messenger } from "../cli/messenger/context.js"
import type { MessengerAdapter } from "../cli/messenger/port.js"
import type { Chat, MessageHit } from "../domain/models.js"
import type { SendGuard } from "../sends/guard.js"
import type { MessageStore } from "../store/store.js"
import {
  CHAT,
  EMAIL,
  leaksOf,
  openTwinStore,
  SENDER,
  SHARED_WORD,
  type TwinStore,
  twinAccount,
  twinMeetings,
} from "../testing/twin-accounts.js"
import { servicesFor, storedDeps } from "./index.js"
import { personTimeline } from "./person-timeline.js"
import { searchAll } from "./search-all.js"
import { searchAllIncludingMeetings } from "./search-all-meetings.js"

const alpha = twinAccount("alpha")
const messenger = { provider: "synthetic", app: { command: "chat" }, serverSearch: true } as Messenger
const guard: SendGuard = { check: vi.fn(), record: vi.fn() }

const opened: MessageStore[] = []
afterEach(async () => {
  for (const store of opened.splice(0)) await store.close()
})

const twinStore = async (): Promise<TwinStore> => {
  const twin = await openTwinStore()
  opened.push(twin.store)
  return twin
}

const chat: Chat = { id: CHAT, title: "chat", kind: "group", unreadCount: 0, lastMessageAt: null, participantsCount: 3 }

/** A messenger whose server answers chat 7's message 1 — an id both accounts hold. */
const asAlpha = (store: MessageStore, reads: "store" | "server" = "store") => {
  const hit: MessageHit = {
    id: "1",
    chatId: CHAT,
    chatTitle: "chat",
    senderId: SENDER,
    senderName: "Alice Example",
    timestamp: "2026-10-01T00:00:01.000Z",
    editedAt: null,
    text: `${SHARED_WORD} question alpha-only`,
    outgoing: false,
    attachments: [],
    replyTo: null,
    forwardedFrom: null,
    reactions: null,
  }
  const adapter = {
    self: () => alpha.account,
    searchMessages: async () => ({ items: [hit], hasMore: false, chats: [chat] }),
  } as unknown as MessengerAdapter
  const deps = {
    ...storedDeps(messenger, store, alpha, guard),
    offline: false,
    reads,
    connection: async () => adapter,
  }
  return servicesFor(deps)
}

const search = { text: SHARED_WORD, language: "lucene" as const, limit: 50 }

type Read = (twin: TwinStore) => Promise<unknown>

/** Each read as alpha, by what a caller asks; nothing of bravo may come back. */
const BOUND: [string, Read][] = [
  ["messages list", ({ store }) => asAlpha(store).messages.list(CHAT, { limit: 10 })],
  ["messages around", ({ store }) => asAlpha(store).messages.around(CHAT, "2", { before: 2, after: 2 })],
  ["search messages", ({ store }) => asAlpha(store).messages.search({ ...search, backend: "archive" })],
  ["search messages, legacy", ({ store }) => asAlpha(store).messages.search({ ...search, language: "legacy" })],
  ["search messages --chat 7", ({ store }) => asAlpha(store).messages.search({ ...search, chat: CHAT })],
  [
    "search messages chat:7",
    ({ store }) => asAlpha(store).messages.search({ ...search, text: `${SHARED_WORD} chat:7` }),
  ],
  ["search messages with context", ({ store }) => asAlpha(store).messages.search({ ...search, context: 2 })],
  [
    "search messages --backend server",
    ({ store }) => asAlpha(store, "server").messages.search({ ...search, backend: "server" }),
  ],
  [
    "search messages --backend both",
    ({ store }) => asAlpha(store, "server").messages.search({ ...search, backend: "both" }),
  ],
  [
    "search all --backend server",
    ({ store }) =>
      asAlpha(store, "server").messages.searchAll({
        text: SHARED_WORD,
        limit: 50,
        only: ["messages"],
        backend: "server",
      }),
  ],
  ["search stats by chat", ({ store }) => asAlpha(store).messages.stats({ ...search, by: "chat" })],
  ["chats list", ({ store }) => asAlpha(store).chats.list({}, { limit: 10, offset: 0 })],
  ["attachments list", ({ store }) => asAlpha(store).attachments.list({ chat: CHAT, limit: 10 })],
  ["store messages", ({ store }) => store.messages(alpha, CHAT, { limit: 10 })],
  ["store message by id", ({ store }) => store.message(alpha, "1", { chatId: CHAT })],
  ["store transcript", ({ store }) => store.transcript(alpha, CHAT, "1")],
  ["store attachments", ({ store }) => store.attachments(alpha, { chatId: CHAT, limit: 10 })],
  ["store find", ({ store }) => store.find({ account: alpha, text: SHARED_WORD, limit: 50 })],
  ["store find in chat 7", ({ store }) => store.find({ account: alpha, chatId: CHAT, text: SHARED_WORD, limit: 50 })],
  ["store search", ({ store }) => store.search(SHARED_WORD, { limit: 50, account: alpha })],
  ["direct replies", async ({ store }) => store.directReplies?.([{ account: alpha, chatId: CHAT, id: "1" }], 10)],
  ["mail threads", ({ store, twins }) => store.mail.threads({ accountId: twins.alpha.mailAccountId })],
  ["mail emails", ({ store, twins }) => store.mail.emails({ accountId: twins.alpha.mailAccountId })],
  ["mail email by id", ({ store, twins }) => store.mail.email(twins.alpha.mailAccountId, EMAIL)],
  ["documents of a folder", ({ store, twins }) => store.notes.notes({ folderId: twins.alpha.folderId })],
  ["meetings list", ({ store, twins }) => store.meetings.meetings({ accountId: twins.alpha.meetingAccountId })],
  [
    "meetings search",
    ({ store, twins }) => store.meetings.search(SHARED_WORD, { accountId: twins.alpha.meetingAccountId }),
  ],
  ["person timeline", ({ store }) => personTimeline(store, alpha, SENDER)],
  [
    "search all with meetings: the meeting hits",
    async ({ store }) => {
      const found = await searchAllIncludingMeetings(store, alpha, {
        text: SHARED_WORD,
        limit: 50,
        only: ["meetings"],
        meetingAccount: twinMeetings("alpha"),
      })
      return found.items
    },
  ],
]

/** Reads that span accounts today: each must find both twins, so this list says which ones do. */
const ACROSS: [string, Read][] = [
  ["search messages --source all", ({ store }) => asAlpha(store).messages.search({ ...search, source: "all" })],
  [
    "search messages in:all",
    ({ store }) => asAlpha(store).messages.search({ ...search, text: `${SHARED_WORD} in:all` }),
  ],
  [
    "today: search mail spans every mailbox — owner to confirm",
    ({ store }) => asAlpha(store).messages.search({ ...search, kind: "mail" }),
  ],
  ["search all", ({ store }) => searchAll(store, alpha, { text: SHARED_WORD, limit: 50 })],
  ["today: notes without a folder span every folder — owner to confirm", ({ store }) => store.notes.notes({})],
  [
    "direct replies, both parents named",
    async ({ store }) =>
      store.directReplies?.(
        [
          { account: alpha, chatId: CHAT, id: "1" },
          { account: twinAccount("bravo"), chatId: CHAT, id: "1" },
        ],
        10,
      ),
  ],
]

describe("one account's reads never answer with another's", () => {
  it.each(BOUND)("%s", async (_name, read) => {
    const twin = await twinStore()
    const answer = await read(twin)
    expect(leaksOf(answer, "alpha"), "the read found nothing of its own account").not.toEqual([])
    expect(leaksOf(answer, "bravo")).toEqual([])
  })

  it.each(ACROSS)("%s spans both accounts", async (_name, read) => {
    const twin = await twinStore()
    const answer = await read(twin)
    expect(leaksOf(answer, "alpha")).not.toEqual([])
    expect(leaksOf(answer, "bravo")).not.toEqual([])
  })

  it("across accounts, a server hit is the running account's; the twin's same ids stay archive hits", async () => {
    const { store } = await twinStore()
    const found = await asAlpha(store, "server").messages.search({ ...search, source: "all", backend: "both" })
    expect(found.server).toMatchObject({ calls: 1 })
    const bravo = found.items.filter(({ locator }) => locator.startsWith("msg:synthetic/600/"))
    expect(bravo.map(({ id }) => id).sort()).toEqual(["1", "2", "3"])
    expect(bravo.map(({ source }) => source)).toEqual(["archive", "archive", "archive"])
  })

  it("--source all --backend server answers only the running account's hits", async () => {
    const { store } = await twinStore()
    const found = await asAlpha(store, "server").messages.search({ ...search, source: "all", backend: "server" })
    expect(found.items.map(({ locator }) => locator)).toEqual(["msg:synthetic/500/7/1"])
  })

  it("a chat named across accounts that both hold is ambiguous, never both chats' hits", async () => {
    const { store } = await twinStore()
    await expect(
      asAlpha(store).messages.search({ ...search, text: `${SHARED_WORD} in:all chat:7` }),
    ).rejects.toMatchObject({ code: "validation_error" })
  })

  it("a chat id without its account is refused, since every account may hold that id", async () => {
    const { store } = await twinStore()
    await expect(store.find({ chatId: CHAT, text: SHARED_WORD, limit: 50 })).rejects.toMatchObject({
      code: "validation_error",
    })
    await expect(
      store.find({ provider: "synthetic", accounts: ["500", "600"], chatId: CHAT, text: SHARED_WORD, limit: 50 }),
    ).rejects.toMatchObject({ code: "validation_error" })
  })

  it.todo("unbound: localPathOf(attachmentPk) reads any account's attachment by its row id")
  it.todo("unbound: keepAttachmentText(attachmentPk) writes any account's attachment by its row id")
  it.todo("unbound: mail.thread(id) reads any account's thread by its row id")
  it.todo("unbound: meetings.meeting(id) reads any account's meeting by its row id")
  it.todo("unbound: mail.threads/emails and meetings.meetings read every account when accountId is left out")
})
