import { mkdtempSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import type { Chat, Message } from "../domain/models.js"
import { MIGRATIONS, migrate } from "./migrations.js"
import { openCache } from "./open.js"
import { storePath } from "./path.js"
import { type AccountKey, openStore } from "./store.js"

const fresh = () => join(mkdtempSync(join(tmpdir(), "store-")), "messages.db")
const ME: AccountKey = { provider: "telegram", account: "100" }

const chat: Chat = {
  id: "-1001234567890",
  title: "Valencia expats",
  kind: "group",
  unreadCount: 3,
  lastMessageAt: "2026-09-26T10:00:00.000Z",
  participantsCount: 5000,
  providerMetadata: { chatType: "supergroup" },
}

const message = (overrides: Partial<Message> = {}): Message => ({
  id: "42",
  chatId: chat.id,
  senderId: "777",
  senderName: "Ana",
  timestamp: "2026-09-26T10:00:00.000Z",
  editedAt: null,
  text: "empadronamiento renewal",
  outgoing: false,
  attachments: [{ kind: "photo", width: 800, height: 600, providerRef: { fileId: "abc" } }],
  replyTo: {
    id: "41",
    senderId: "778",
    senderName: "Luis",
    timestamp: null,
    text: "where?",
    attachments: [],
    outgoing: false,
  },
  replyToId: "41",
  forwardedFrom: null,
  threadId: "5",
  reactions: { counts: [{ reaction: "👍", count: 2 }], mine: null, total: 2 },
  providerMetadata: { views: 10 },
  ...overrides,
})

describe("the message store", () => {
  it("answers the store's id for an account, the same id every time, for meetings and mail", async () => {
    const store = await openStore({ path: fresh() })
    const first = await store.saveAccount({ provider: "zoom", account: "alice@example.com" }, { name: null })
    const again = await store.saveAccount({ provider: "zoom", account: "alice@example.com" }, { name: "Alice Example" })
    const other = await store.saveAccount({ provider: "zoom", account: "bob@example.com" }, { name: null })

    expect(again).toBe(first)
    expect(other).not.toBe(first)
    expect(await store.mail.threads({ accountId: first })).toEqual([])
    await store.close()
  })

  it("**gives back exactly the chat and the message it was given**", async () => {
    const store = await openStore({ path: fresh() })
    await store.saveChats(ME, [chat])
    await store.saveMessages(ME, chat.id, [message()], { via: "history" })

    expect((await store.chats(ME, {})).items).toEqual([chat])
    expect((await store.messages(ME, chat.id, { limit: 10 })).items).toEqual([message()])
    await store.close()
  })

  it("saves two batches started together on one store, each whole", async () => {
    const store = await openStore({ path: fresh() })
    const batch = (ids: string[]) => ids.map((id) => message({ id, text: `text ${id}` }))
    await Promise.all([
      store.saveMessages(ME, chat.id, batch(["1", "2", "3"]), { via: "history" }),
      store.saveMessages(ME, chat.id, batch(["4", "5", "6"]), { via: "update" }),
    ])

    const ids = (await store.messages(ME, chat.id, { limit: 10 })).items.map(({ id }) => id)
    expect(ids).toEqual(["1", "2", "3", "4", "5", "6"])
    await store.close()
  })

  it("keeps what an edit replaced, and searches only the new text", async () => {
    const path = fresh()
    const store = await openStore({ path })
    await store.saveMessages(ME, chat.id, [message()], { via: "history" })
    await store.saveMessages(ME, chat.id, [message()], { via: "history" })
    await store.saveMessages(
      ME,
      chat.id,
      [message({ text: "cita previa booked", editedAt: "2026-09-26T11:00:00.000Z" })],
      {
        via: "update",
      },
    )

    expect((await store.search("cita previa", { limit: 5 })).items.map((hit) => hit.locator)).toEqual([
      "msg:telegram/100/-1001234567890/42",
    ])
    expect((await store.search("empadronamiento", { limit: 5 })).items).toEqual([])
    const database = await openCache(path)
    expect(database.prepare("SELECT text FROM message_revisions").all()).toEqual([{ text: "empadronamiento renewal" }])
    database.close()
    await store.close()
  })

  it("does not let a copy that knows less erase what was stored", async () => {
    const store = await openStore({ path: fresh() })
    await store.saveMessages(ME, chat.id, [message()], { via: "history" })
    await store.saveMessages(
      ME,
      chat.id,
      [
        message({
          reactions: null,
          replyTo: null,
          senderId: null,
          senderName: null,
          threadId: undefined,
          outgoing: null,
        }),
      ],
      { via: "send" },
    )

    const [kept] = (await store.messages(ME, chat.id, { limit: 1 })).items
    expect(kept?.reactions?.total).toBe(2)
    expect(kept?.replyTo?.text).toBe("where?")
    expect(kept).toMatchObject({ senderId: "777", senderName: "Ana", threadId: "5", outgoing: false })
    await store.close()
  })

  it("gives every new sender an identity and a person of their own, and a channel neither", async () => {
    const path = fresh()
    const store = await openStore({ path })
    await store.saveMessages(
      ME,
      chat.id,
      [
        message({ id: "1" }),
        message({ id: "2" }),
        message({ id: "3", senderId: "888", senderName: "Marta" }),
        message({ id: "4", senderId: "-100555", senderName: "News", senderIsChat: true }),
      ],
      { via: "history" },
    )
    await store.close()

    const database = await openCache(path)
    const count = (table: string) => database.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.n
    expect([
      count("identities"),
      count("persons WHERE owner = 0"),
      count("identity_links"),
      count("identity_link_events"),
    ]).toEqual([2, 2, 2, 2])
    database.close()
  })

  it("keeps a sender's username from a message, and a later message without one does not erase it", async () => {
    const store = await openStore({ path: fresh() })
    await store.saveMessages(ME, chat.id, [message({ id: "1", senderUsername: "ana_v" })], { via: "history" })
    await store.saveMessages(ME, chat.id, [message({ id: "2" })], { via: "update" })
    expect((await store.people("telegram")).get("777")).toMatchObject({ name: "Ana", username: "ana_v" })
    await store.close()
  })

  it("pages backwards from a message, oldest to newest within a page", async () => {
    const store = await openStore({ path: fresh() })
    const at = (minute: number) => `2026-09-26T10:0${minute}:00.000Z`
    await store.saveMessages(
      ME,
      chat.id,
      [1, 2, 3, 4].map((n) => message({ id: String(n), timestamp: at(n) })),
      { via: "history" },
    )

    const newest = await store.messages(ME, chat.id, { limit: 2 })
    expect(newest.items.map((one) => one.id)).toEqual(["3", "4"])
    expect(newest.hasMore).toBe(true)
    expect((await store.messages(ME, chat.id, { limit: 2, before: "3" })).items.map((one) => one.id)).toEqual([
      "1",
      "2",
    ])
    await store.close()
  })

  it("keeps one forum topic's messages, paging back within it", async () => {
    const store = await openStore({ path: fresh() })
    const at = (minute: number) => `2026-09-26T10:0${minute}:00.000Z`
    await store.saveMessages(
      ME,
      chat.id,
      [1, 2, 3, 4].map((n) => message({ id: String(n), timestamp: at(n), threadId: n % 2 === 0 ? "7" : "9" })),
      { via: "history" },
    )

    expect((await store.messages(ME, chat.id, { limit: 5, threadId: "7" })).items.map((one) => one.id)).toEqual([
      "2",
      "4",
    ])
    expect(
      (await store.messages(ME, chat.id, { limit: 5, threadId: "7", before: "4" })).items.map((one) => one.id),
    ).toEqual(["2"])
    await store.close()
  })

  it("finds one message by its id, and asks for the chat when two chats share the id", async () => {
    const store = await openStore({ path: fresh() })
    await store.saveMessages(ME, chat.id, [message()], { via: "history" })
    expect((await store.message(ME, "42"))?.text).toBe("empadronamiento renewal")
    expect(await store.message(ME, "43")).toBeUndefined()

    await store.saveMessages(ME, "555", [message({ chatId: "555" })], { via: "history" })
    await expect(store.message(ME, "42")).rejects.toThrow(expect.objectContaining({ code: "validation_error" }))
    expect((await store.message(ME, "42", { chatId: "555" }))?.chatId).toBe("555")
    await store.close()
  })

  it("tombstones nothing for a deletion that names no chat when the messenger gives no rule", async () => {
    const store = await openStore({ path: fresh() })
    const dialog: Chat = { ...chat, id: "555", kind: "dialog", providerMetadata: {} }
    await store.saveChats(ME, [dialog])
    await store.saveMessages(ME, dialog.id, [message({ chatId: dialog.id })], { via: "history" })

    expect(await store.markDeleted(ME, ["42"])).toBe(0)
    expect(await store.message(ME, "42", { chatId: dialog.id })).toBeDefined()
    await store.close()
  })

  it("lets the messenger's rule pick the chats a deletion that names no chat may hit", async () => {
    const store = await openStore({ path: fresh() })
    const dialog: Chat = { ...chat, id: "555", kind: "dialog", providerMetadata: {} }
    const other: Chat = { ...chat, id: "-4001", kind: "group", providerMetadata: { chatType: "group" } }
    await store.saveChats(ME, [chat, dialog, other])
    await store.saveMessages(ME, chat.id, [message(), message({ id: "43" })], { via: "history" })
    await store.saveMessages(ME, dialog.id, [message({ chatId: dialog.id })], { via: "history" })
    await store.saveMessages(ME, other.id, [message({ id: "43", chatId: other.id })], { via: "history" })
    const seen: unknown[] = []
    const among = (one: Pick<Chat, "id" | "kind" | "providerMetadata">) => {
      seen.push(one)
      return one.providerMetadata?.chatType !== undefined
    }

    expect(await store.markDeleted(ME, ["42", "43"], { among })).toBe(1)
    expect(await store.message(ME, "42", { chatId: chat.id })).toBeUndefined()
    expect(await store.message(ME, "42", { chatId: dialog.id })).toBeDefined()
    expect(await store.message(ME, "43", { chatId: chat.id })).toBeDefined()
    expect(await store.message(ME, "43", { chatId: other.id })).toBeDefined()
    expect(seen).toContainEqual({ id: chat.id, kind: "group", providerMetadata: { chatType: "supergroup" } })
    await store.close()
  })

  it("**lifts a tombstone older than a read that still returned the message**, and keeps a newer one", async () => {
    let clock = 1_000
    const store = await openStore({ path: fresh(), now: () => clock })
    await store.saveMessages(ME, chat.id, [message(), message({ id: "43" })], { via: "history" })
    await store.markDeleted(ME, ["42", "43"], { chatId: chat.id })
    clock = 2_000

    await store.saveMessages(ME, chat.id, [message()], { via: "history", seenAt: 1_500 })
    await store.saveMessages(ME, chat.id, [message({ id: "43" })], { via: "history", seenAt: 500 })
    await store.saveMessages(ME, chat.id, [message({ id: "43" })], { via: "history" })

    expect(await store.message(ME, "42", { chatId: chat.id })).toBeDefined()
    expect(await store.message(ME, "43", { chatId: chat.id })).toBeUndefined()
    expect((await store.search("empadronamiento", { limit: 10 })).items.map((hit) => hit.id)).toEqual(["42"])
    await store.close()
  })

  it("keeps a deleted message out of reads and search, in its own chat only", async () => {
    const store = await openStore({ path: fresh() })
    await store.saveMessages(ME, chat.id, [message(), message({ id: "43" })], { via: "history" })
    await store.saveMessages(ME, "555", [message({ chatId: "555" })], { via: "history" })

    expect(await store.markDeleted(ME, ["42"], { chatId: chat.id })).toBe(1)
    expect(await store.markDeleted(ME, ["42"], { chatId: chat.id })).toBe(0)
    expect((await store.messages(ME, chat.id, { limit: 10 })).items.map((one) => one.id)).toEqual(["43"])
    expect(await store.message(ME, "42", { chatId: chat.id })).toBeUndefined()
    expect(await store.message(ME, "42", { chatId: "555" })).toBeDefined()
    expect((await store.search("empadronamiento", { limit: 10 })).items.map((hit) => hit.chatId).sort()).toEqual([
      "-1001234567890",
      "555",
    ])
    await store.close()
  })

  it("refuses a search too short for its index rather than answering nothing", async () => {
    const store = await openStore({ path: fresh() })
    await expect(store.search("ab", { limit: 5 })).rejects.toThrow(
      expect.objectContaining({ code: "validation_error" }),
    )
    await store.close()
  })

  it.skipIf(process.platform === "win32")("**is readable by nobody else**, its journal files included", async () => {
    const path = fresh()
    const store = await openStore({ path })
    await store.saveMessages(ME, chat.id, [message()], { via: "history" })

    for (const file of [path, `${path}-wal`, `${path}-shm`]) expect(statSync(file).mode & 0o777).toBe(0o600)
    await store.close()
  })

  it("defaults to the test sandbox, never the owner's file", () => {
    expect(storePath()).toBe(process.env.MESSAGING_STORE)
    expect(storePath({})).toContain("cli-messaging")
  })
})

describe("finding people and what they wrote", () => {
  const BOT: AccountKey = { provider: "max-bot", account: "1" }
  const OTHER_BOT: AccountKey = { provider: "max-bot", account: "2" }
  const said = (id: string, chatId: string, senderId: string, text: string, minute: number): Message =>
    message({
      id,
      chatId,
      senderId,
      senderName: `person ${senderId}`,
      text,
      timestamp: `2026-09-27T10:${String(minute).padStart(2, "0")}:00.000Z`,
      attachments: [],
      replyTo: null,
      replyToId: undefined,
    })

  const seeded = async () => {
    const store = await openStore({ path: fresh() })
    await store.saveMessages(
      BOT,
      "10",
      [said("a", "10", "7", "hello from seven", 1), said("b", "10", "8", "eight here", 2)],
      {
        via: "history",
      },
    )
    await store.saveMessages(BOT, "20", [said("c", "20", "7", "seven alone", 3)], { via: "history" })
    await store.saveMessages(
      OTHER_BOT,
      "30",
      [said("d", "30", "7", "seven again", 4), said("e", "30", "8", "eight again", 5), said("f", "30", "9", "nine", 6)],
      { via: "history" },
    )
    return store
  }

  it("keeps the messages of any sender, newest first, in one account or across a provider", async () => {
    const store = await seeded()
    expect((await store.find({ account: BOT, senders: ["7"], limit: 10 })).items.map(({ id }) => id)).toEqual([
      "c",
      "a",
    ])
    expect(
      (await store.find({ provider: "max-bot", senders: ["7", "9"], limit: 10 })).items.map(({ id }) => id),
    ).toEqual(["f", "d", "c", "a"])
    await store.close()
  })

  it("keeps only the chats where every sender wrote, with `together`", async () => {
    const store = await seeded()
    const page = await store.find({ provider: "max-bot", senders: ["7", "8"], together: true, limit: 10 })
    expect(page.items.map(({ id }) => id)).toEqual(["e", "d", "b", "a"])
    await store.close()
  })

  it("caps each chat rather than all of them, with `perChat`", async () => {
    const store = await seeded()
    const page = await store.find({ provider: "max-bot", senders: ["7", "8"], together: true, perChat: true, limit: 1 })
    expect(page).toMatchObject({ items: [{ id: "e" }, { id: "b" }], hasMore: true })
    await store.close()
  })

  it("combines text with a sender and leaves a deleted message out", async () => {
    const store = await seeded()
    const page = await store.find({ provider: "max-bot", senders: ["7"], text: "again", limit: 10 })
    expect(page.items.map(({ id }) => id)).toEqual(["d"])
    await store.markDeleted(OTHER_BOT, ["d"], { chatId: "30" })
    expect((await store.find({ provider: "max-bot", senders: ["7"], text: "again", limit: 10 })).items).toEqual([])
    await store.close()
  })

  it("finds nothing for a sender it has never seen, and refuses a filter with neither text nor sender", async () => {
    const store = await seeded()
    expect((await store.find({ provider: "max-bot", senders: ["404"], limit: 10 })).items).toEqual([])
    await expect(store.find({ provider: "max-bot", limit: 10 })).rejects.toThrow("say what to find")
    await store.close()
  })

  it("remembers a username and a bot flag, and a later name alone does not erase them", async () => {
    const store = await seeded()
    await store.savePeople(BOT, [{ id: "7", name: "Seven", username: "seven", isBot: false }])
    await store.saveMessages(BOT, "10", [said("g", "10", "7", "renamed", 7)], { via: "update" })
    expect((await store.people("max-bot")).get("7")).toMatchObject({ name: "person 7", username: "seven" })
    expect(
      (await store.people("max-bot", { account: "1" }))
        .all()
        .map(({ id }) => id)
        .toSorted(),
    ).toEqual(["7", "8"])
    await store.close()
  })

  it("leaves a person's row alone when a save says nothing new, and updates it when it does", async () => {
    const path = fresh()
    let clock = 1_000
    const store = await openStore({ path, now: () => clock })
    await store.savePeople(ME, [{ id: "7", name: "Vera", username: "vera", isBot: false }])
    clock = 2_000
    await store.savePeople(ME, [{ id: "7", name: "Vera", username: null }])
    const updatedAt = async () => {
      const database = await openCache(path)
      const row = database.prepare("SELECT updated_at FROM identities WHERE external_id = '7'").get()
      database.close()
      return row?.updated_at
    }
    expect(await updatedAt()).toBe(1_000)
    clock = 3_000
    await store.savePeople(ME, [{ id: "7", name: "Vera P." }])
    expect(await updatedAt()).toBe(3_000)
    await store.close()
  })

  it("reads a chosen few accounts, and never all of them by leaving the provider out", async () => {
    const store = await seeded()
    const ids = async (accounts: string[]) =>
      (await store.find({ provider: "max-bot", accounts, senders: ["7", "9"], limit: 10 })).items.map(({ id }) => id)
    expect(await ids(["1"])).toEqual(["c", "a"])
    expect(await ids(["1", "2"])).toEqual(["f", "d", "c", "a"])
    expect(await ids([])).toEqual([])
    await expect(store.find({ accounts: ["1"], senders: ["7"], limit: 10 })).rejects.toThrow(/provider/)
    expect(
      (await store.people("max-bot", { accounts: ["1", "2"] }))
        .all()
        .map(({ id }) => id)
        .toSorted(),
    ).toEqual(["7", "8", "9"])
    await store.close()
  })

  it("keeps each account's people to itself: a person seen by one bot is not another's", async () => {
    const store = await seeded()
    await store.savePeople(OTHER_BOT, [{ id: "11", name: "Only the other", username: "other" }])
    const ids = async (account?: string) =>
      (await store.people("max-bot", account ? { account } : {}))
        .all()
        .map(({ id }) => id)
        .toSorted()

    expect(await ids("1")).toEqual(["7", "8"])
    expect(await ids("2")).toEqual(["11", "7", "8", "9"])
    expect(await ids()).toEqual(["11", "7", "8", "9"])
    expect((await store.people("max-bot", { account: "1" })).get("11")).toBeUndefined()
    await store.close()
  })

  it("counts a person saved for an account as seen by it, though they never wrote there", async () => {
    const store = await seeded()
    await store.savePeople(BOT, [{ id: "12", name: "A member", username: null }])
    expect((await store.people("max-bot", { account: "1" })).get("12")).toMatchObject({ name: "A member" })
    expect((await store.people("max-bot", { account: "2" })).get("12")).toBeUndefined()
    await store.close()
  })
})

describe("searching message text", () => {
  it("**finds any three letters inside a word**, whatever its ending, and every word asked for", async () => {
    const store = await openStore({ path: fresh() })
    await store.saveMessages(
      ME,
      chat.id,
      [
        message({ id: "1", text: "Сдаю квартиру в центре" }),
        message({ id: "2", text: "Ищу квартира рядом с морем" }),
        message({ id: "3", text: "Продаю машину в центре" }),
      ],
      { via: "history" },
    )
    const ids = async (query: string) => (await store.search(query, { limit: 10 })).items.map((hit) => hit.id).sort()

    expect(await ids("квартир")).toEqual(["1", "2"])
    expect(await ids("квартир центр")).toEqual(["1"])
    expect(await ids("вартир")).toEqual(["1", "2"])
    expect(await ids("в центре")).toEqual(["1", "3"])
    await store.close()
  })
})

describe("finding by pattern", () => {
  it("**reads newest first past a chunk until the limit matches**, and says when there are more", async () => {
    const store = await openStore({ path: fresh() })
    const minute = (n: number) => new Date(Date.UTC(2026, 8, 1) + n * 60_000).toISOString()
    await store.saveMessages(
      ME,
      chat.id,
      Array.from({ length: 1200 }, (_, n) =>
        message({ id: String(n + 1), timestamp: minute(n), text: n % 400 === 0 ? `invoice #${n}` : `chat ${n}` }),
      ),
      { via: "history" },
    )

    const page = await store.find({ account: ME, pattern: /INVOICE #\d+/iu, limit: 2 })
    expect(page.items.map((hit) => hit.text)).toEqual(["invoice #800", "invoice #400"])
    expect(page.hasMore).toBe(true)
    expect(await store.find({ account: ME, pattern: /invoice #0$/u, limit: 5 })).toMatchObject({
      items: [{ id: "1" }],
      hasMore: false,
    })
    await expect(store.find({ account: ME, pattern: /x/u, perChat: true, limit: 1 })).rejects.toThrow("not per chat")
    await store.close()
  })
})

describe("the stretches held completely", () => {
  it("**merge when they overlap or touch**, and stay apart across a gap", async () => {
    const store = await openStore({ path: fresh() })
    await store.markRange(ME, chat.id, 100, 200)
    await store.markRange(ME, chat.id, 300, 400)
    expect(await store.markRange(ME, chat.id, 201, 250)).toEqual({ from: 100, to: 250 })
    expect(await store.ranges(ME, chat.id)).toEqual([
      { from: 100, to: 250 },
      { from: 300, to: 400 },
    ])
    expect(await store.markRange(ME, chat.id, 240, 310)).toEqual({ from: 100, to: 400 })
    expect(await store.ranges(ME, chat.id)).toEqual([{ from: 100, to: 400 }])
    await store.close()
  })
})

describe("migrating the store", () => {
  const latest = MIGRATIONS.at(-1)?.version ?? 0
  const next = { version: latest + 1, minCompatible: 1, statements: ["ALTER TABLE chats ADD COLUMN folder TEXT"] }

  it("opens a newer file this version can still write to, and changes nothing in it", async () => {
    const path = fresh()
    const newer = await openCache(path)
    migrate(newer, { migrations: [...MIGRATIONS, next] })
    newer.close()

    const store = await openStore({ path })
    await store.saveChats(ME, [chat])
    expect((await store.chats(ME, {})).items).toEqual([chat])
    await store.close()
  })

  it("**refuses a newer file it cannot write to**, and leaves it as it was", async () => {
    const path = fresh()
    const newer = await openCache(path)
    migrate(newer, { migrations: [...MIGRATIONS, { ...next, minCompatible: next.version }] })
    newer.close()

    await expect(openStore({ path })).rejects.toMatchObject({ code: "configuration_error" })
    const database = await openCache(path)
    expect(database.prepare("SELECT version FROM schema_migrations ORDER BY version").all()).toEqual(
      [...MIGRATIONS, next].map(({ version }) => ({ version })),
    )
    database.close()
  })

  it("brings an older file forward without losing a message", async () => {
    const path = fresh()
    const store = await openStore({ path })
    await store.saveMessages(ME, chat.id, [message()], { via: "history" })
    await store.close()

    const database = await openCache(path)
    migrate(database, { migrations: [...MIGRATIONS, next] })
    expect(database.prepare("SELECT count(*) AS n FROM messages").get()?.n).toBe(1)
    database.close()
  })
})

describe("the accounts a caller can name", () => {
  it("lists every account with the store's id, finds one without making it, and names a missing one", async () => {
    const store = await openStore({ path: fresh() })
    try {
      const zoom = await store.saveAccount(
        { provider: "zoom", account: "alice@example.com" },
        { name: "Alice Example" },
      )
      const telegram = await store.saveAccount(ME, { name: null })

      expect(await store.storedAccounts()).toEqual([
        { id: telegram, provider: "telegram", account: "100", name: null, scope: "personal" },
        { id: zoom, provider: "zoom", account: "alice@example.com", name: "Alice Example", scope: "personal" },
      ])
      expect((await store.storedAccount({ provider: "zoom", account: "alice@example.com" })).id).toBe(zoom)
      await expect(store.storedAccount({ provider: "zoom", account: "bob@example.com" })).rejects.toMatchObject({
        code: "not_found",
      })
      expect(await store.storedAccounts()).toHaveLength(2)
    } finally {
      await store.close()
    }
  })
})
