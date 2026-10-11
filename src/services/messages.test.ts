import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { botCopy } from "../cli/bot/copy.js"
import type { Messenger } from "../cli/messenger/context.js"
import type { MessengerAdapter } from "../cli/messenger/port.js"
import { parseMarkdown } from "../domain/markdown.js"
import type { Chat, Message } from "../domain/models.js"
import type { GuardRequest, SendGuard } from "../sends/guard.js"
import { sendGuard } from "../sends/guard.js"
import type { SendEntry } from "../sends/journal.js"
import { SendJournal } from "../sends/journal.js"
import { RecipientList } from "../sends/recipients.js"
import { type MessageStore, openStore } from "../store/store.js"
import { onlineDeps, storedDeps } from "./deps.js"
import { messagesService, searchStore } from "./messages.js"

const account = { provider: "test", account: "500" }
const messenger = { provider: "test", chatArgument: "a chat" } as Messenger
const guard = {} as SendGuard

const chat: Chat = {
  id: "7",
  title: "Book club",
  kind: "group",
  unreadCount: 0,
  lastMessageAt: "2026-09-27T10:02:00.000Z",
  participantsCount: 4,
}

const thread: Message[] = ["1", "2", "3"].map((id, index) => ({
  id,
  chatId: "7",
  senderId: "9",
  senderName: "Olga",
  timestamp: `2026-09-27T10:0${index}:00.000Z`,
  editedAt: null,
  text: `chapter ${id}`,
  outgoing: false,
  attachments: [],
  replyTo: null,
  forwardedFrom: null,
  reactions: null,
}))

const asked: unknown[] = []
const adapter = {
  self: () => "500",
  history: async (reference: string, window: unknown) => {
    asked.push({ reference, window })
    return { items: thread, hasMore: false }
  },
  around: async () => thread.slice(1, 2).map((one) => ({ ...one, anchor: true as const })),
} as unknown as MessengerAdapter

const opened: MessageStore[] = []
const keptStore = async () => {
  const store = await openStore({ path: join(mkdtempSync(join(tmpdir(), "services-")), "m.db") })
  opened.push(store)
  await store.saveChats(account, [chat])
  await store.saveMessages(account, "7", thread, { via: "history" })
  return store
}

afterEach(async () => {
  asked.length = 0
  for (const store of opened.splice(0)) await store.close()
})

describe("the messages service", () => {
  it("reads a chat from the messenger when online, as it was asked", async () => {
    const page = await messagesService(onlineDeps(messenger, adapter, guard)).list("Book", { limit: 2, before: "3" })

    expect(page.items.map((one) => one.id)).toEqual(["1", "2", "3"])
    expect(asked).toEqual([{ reference: "Book", window: { limit: 2, before: "3" } }])
  })

  it("reads on past a messenger's page cap until the limit, back or forward", async () => {
    const history = ["1", "2", "3", "4", "5"].map((id) => ({ ...(thread[0] as Message), id }))
    const windows: unknown[] = []
    const capped = {
      self: () => "500",
      history: async (_: string, window: { limit: number; before?: string }) => {
        windows.push(window)
        const end = window.before === undefined ? history.length : history.findIndex((one) => one.id === window.before)
        const start = Math.max(0, end - Math.min(2, window.limit))
        return { items: history.slice(start, end), hasMore: start > 0 }
      },
      historyAfter: async (_: string, window: { limit: number; after: { id: string } }) => {
        windows.push(window)
        const start = history.findIndex((one) => one.id === window.after.id) + 1
        const end = Math.min(history.length, start + Math.min(2, window.limit))
        return { items: history.slice(start, end), hasMore: end < history.length }
      },
    } as unknown as MessengerAdapter
    const service = messagesService(onlineDeps(messenger, capped, guard))

    const back = await service.list("7", { limit: 4 })
    const forward = await service.list("7", { limit: 10, after: { id: "1" } })

    expect(back).toEqual({ items: history.slice(1), hasMore: true })
    expect(forward).toEqual({ items: history.slice(1), hasMore: false })
    expect(windows).toEqual([
      { limit: 4 },
      { limit: 2, before: "4" },
      { limit: 10, after: { id: "1" } },
      { limit: 8, after: { id: "3" } },
    ])
  })

  it("reads the same chat from the store when offline, found by its title, without connecting", async () => {
    const service = messagesService(storedDeps(messenger, await keptStore(), account, guard))

    const page = await service.list("book", { limit: 2 })
    const around = await service.around("7", "2", { before: 1, after: 0 })

    expect(page.items.map((one) => one.id)).toEqual(["2", "3"])
    expect(around.map((one) => one.id)).toEqual(["1", "2"])
    expect(asked).toEqual([])
  })

  it("defaults the service to Lucene like CLI/MCP, keeping explicit legacy and the low-level helper", async () => {
    const store = await keptStore()
    const service = messagesService(storedDeps(messenger, store, account, guard))
    const strict = await service.search({ text: "chapter OR nonexistent", limit: 10 })
    expect(strict.query?.language).toBe("lucene-v1")
    expect(strict.items.map(({ id }) => id)).toEqual(["3", "2", "1"])
    await expect(service.search({ text: "chapter~1", limit: 10 })).rejects.toMatchObject({ code: "validation_error" })
    expect((await service.stats({ text: "chapter OR nonexistent", by: "chat", limit: 10 })).total).toBe(3)
    const explicit = await service.search({ text: "chapter", language: "legacy", limit: 10 })
    expect(explicit.query).toBeUndefined()
    expect((await searchStore(store, account, { text: "chapter", limit: 10 })).query).toBeUndefined()
    expect((await service.search({ pattern: /chapter/u, limit: 10 })).query).toBeUndefined()
  })

  it("keeps locator account isolation for time context before store or messenger reads", async () => {
    const store = await keptStore()
    const deps = storedDeps(messenger, store, account, guard)
    const open = vi.fn(deps.store)
    const connect = vi.fn(deps.connection)
    const service = messagesService({ ...deps, store: open, connection: connect })
    await expect(service.around("msg:test/501/7/2", undefined, { before: 1, after: 0 })).rejects.toMatchObject({
      code: "validation_error",
    })
    await expect(service.around("msg:other/500/7/2", undefined, { before: 1, after: 0 })).rejects.toMatchObject({
      code: "validation_error",
    })
    expect(open).not.toHaveBeenCalled()
    expect(connect).not.toHaveBeenCalled()
    const result = await service.around("msg:test/500/7/2", undefined, { before: 1, after: 0 })
    expect(result.map(({ id }) => id)).toEqual(["1", "2"])
    await expect(service.around("msg:test/500/7/2", "2", { before: 0, after: 0 })).rejects.toMatchObject({
      code: "validation_error",
    })
  })

  it("reads a stored chat offline by an id that is not digits", async () => {
    const store = await keptStore()
    await store.saveChats(account, [{ ...chat, id: "room-b", title: "Garden" }])
    await store.saveMessages(account, "room-b", [{ ...thread[0], chatId: "room-b" } as Message], { via: "history" })

    const page = await messagesService(storedDeps(messenger, store, account, guard)).list("room-b", { limit: 5 })

    expect(page.items.map((one) => one.chatId)).toEqual(["room-b"])
  })

  it("refuses to read forward offline, and online when the messenger cannot", async () => {
    const offline = messagesService(storedDeps(messenger, await keptStore(), account, guard))
    const online = messagesService(onlineDeps(messenger, adapter, guard))
    const after = { id: "1" }

    await expect(offline.list("7", { limit: 5, after })).rejects.toThrow(/the store pages only backwards/)
    await expect(online.list("7", { limit: 5, after })).rejects.toThrow(/read forward from a message/)
  })

  it("searches only the store, and never asks the messenger", async () => {
    const found = await messagesService(storedDeps(messenger, await keptStore(), account, guard)).search({
      text: "chapter",
      chat: "Book club",
      limit: 10,
    })

    expect(found.items.map((one) => one.id).sort()).toEqual(["1", "2", "3"])
    expect(asked).toEqual([])
  })

  it("**builds a slice of the word index first**, bounded in time", async () => {
    const store = await keptStore()
    const spentAtStart: (boolean | undefined)[] = []
    const watched: MessageStore = Object.assign(Object.create(store) as MessageStore, {
      fillSearchIndex: async (options: Parameters<MessageStore["fillSearchIndex"]>[0]) => {
        spentAtStart.push(options?.until?.())
        return store.fillSearchIndex(options)
      },
    })

    await messagesService(storedDeps(messenger, watched, account, guard)).search({ text: "chapter", limit: 10 })

    expect(spentAtStart).toEqual([false])
  })
})

describe("searchStore", () => {
  const bot = (account: string) => ({ provider: "test-bot", account })
  const said = (id: string, senderId: string, text: string): Message =>
    ({ ...thread[0], id, senderId, senderName: `Person ${senderId}`, text }) as Message

  const shared = async () => {
    const store = await keptStore()
    for (const [key, id] of [
      [bot("1"), "11"],
      [bot("2"), "21"],
    ] as const) {
      await store.saveChats(key, [chat])
      await store.saveMessages(key, "7", [said(id, "8", "chapter one"), said(`${id}0`, "6", "chapter two")], {
        via: "history",
      })
    }
    return store
  }
  const locators = (found: { items: { locator: string }[] }) => found.items.map((hit) => hit.locator).sort()

  it("**reads only the accounts it is given**, and any of several senders", async () => {
    const store = await shared()
    const bots = { accounts: [bot("1"), bot("2")], limit: 10 }

    expect(locators(await searchStore(store, account, { ...bots, text: "chapter" }))).toEqual([
      "msg:test-bot/1/7/11",
      "msg:test-bot/1/7/110",
      "msg:test-bot/2/7/21",
      "msg:test-bot/2/7/210",
    ])
    const senders = [
      { provider: "test-bot", id: "8" },
      { provider: "test-bot", id: "5" },
    ]
    expect(locators(await searchStore(store, account, { ...bots, text: "chapter", senders }))).toEqual([
      "msg:test-bot/1/7/11",
      "msg:test-bot/2/7/21",
    ])
    expect(locators(await searchStore(store, account, { ...bots, senders }))).toEqual([
      "msg:test-bot/1/7/11",
      "msg:test-bot/2/7/21",
    ])
  })

  it("**in:personal and in:bots split in:all** — a bot's account is one whose provider ends in -bot", async () => {
    const store = await shared()
    const found = async (scope: string) =>
      locators(await searchStore(store, account, { text: `chapter ${scope}`, limit: 10 }))

    expect(await found("in:personal")).toEqual(["msg:test/500/7/1", "msg:test/500/7/2", "msg:test/500/7/3"])
    expect(await found("in:bots")).toEqual([
      "msg:test-bot/1/7/11",
      "msg:test-bot/1/7/110",
      "msg:test-bot/2/7/21",
      "msg:test-bot/2/7/210",
    ])
    expect(await found("in:all")).toHaveLength(7)
    expect(() => botCopy("test")).toThrow(
      "a bot's provider ends in -bot, so a search can tell it from a person's account — not \"test\"",
    )
  })

  it("refuses to widen the accounts it is given, or to name the senders twice", async () => {
    const store = await shared()
    const bots = { accounts: [bot("1")], limit: 10 }

    await expect(searchStore(store, account, { ...bots, text: "chapter in:all" })).rejects.toThrow(
      "this search reads the accounts it was given — not with in: or --source",
    )
    await expect(searchStore(store, account, { ...bots, text: "chapter", source: "test" })).rejects.toThrow(
      /not with in: or --source/,
    )
    await expect(
      searchStore(store, account, { ...bots, text: "from:Olga chapter", senders: [{ provider: "test-bot", id: "8" }] }),
    ).rejects.toThrow("--from and from: together — name the people once")
    await expect(searchStore(store, account, { accounts: [], text: "chapter", limit: 10 })).rejects.toThrow(
      "a search names at least one account",
    )
  })
})

describe("the messages service's writes", () => {
  const journal: Omit<SendEntry, "at" | "profile">[] = []
  const guarding = (refuse: boolean): SendGuard =>
    ({
      check: (_request: GuardRequest) => {
        if (refuse) throw Object.assign(new Error("not on the allow-list"), { code: "permission_denied" })
      },
      record: (entry: Omit<SendEntry, "at" | "profile">) => journal.push(entry),
    }) as unknown as SendGuard
  const writes: string[] = []
  const writer = {
    formatMarkdown: async (text: string) => {
      const parsed = parseMarkdown(text)
      return { text: parsed.text, spans: parsed.markup }
    },
    ...adapter,
    resolve: async (reference: string) => ({ ...chat, id: reference === "Book" ? "7" : reference }),
    send: async (chatId: string, text: string, options: { sendId: string }) => {
      writes.push(`send ${chatId} ${text}`)
      return { sendId: options.sendId, message: { ...thread[0], id: "4", chatId, text } }
    },
    delete: async (chatId: string, ids: string[]) => {
      writes.push(`delete ${chatId} ${ids.join(",")}`)
    },
  } as unknown as MessengerAdapter

  afterEach(() => {
    journal.length = 0
    writes.length = 0
  })

  it.each(["bold", "underline"] as const)("delegates the same source to a provider producing %s", async (type) => {
    const formatMarkdown = vi.fn(async (source: string) => {
      expect(source).toBe("__same__")
      return { text: "same", spans: [{ type, from: 0, length: 4 }] }
    })
    const send = vi.fn(writer.send)
    const provider = { ...writer, formatMarkdown, send }
    await messagesService(onlineDeps(messenger, provider, guarding(false))).send({
      chat: "Book",
      text: "__same__",
      markdown: true,
    })
    expect(send).toHaveBeenCalledWith(
      "7",
      "same",
      expect.objectContaining({ formatting: [{ type, from: 0, length: 4 }] }),
    )
    expect(formatMarkdown).toHaveBeenCalledOnce()
  })

  it("refuses Markdown without a provider formatter while plain text still works", async () => {
    const provider = { ...writer, formatMarkdown: undefined }
    const service = messagesService(onlineDeps(messenger, provider, guarding(false)))
    await expect(service.send({ chat: "Book", text: "__source__", markdown: true })).rejects.toThrow("format Markdown")
    expect(writes).toEqual([])
    await service.send({ chat: "Book", text: "__source__" })
    expect(writes).toEqual(["send 7 __source__"])
  })

  it("formats HTML with the provider's formatter, and refuses it beside Markdown or without one", async () => {
    const formatHtml = vi.fn(async () => ({ text: "bold", spans: [{ type: "bold" as const, from: 0, length: 4 }] }))
    const send = vi.fn(writer.send)
    const service = messagesService(onlineDeps(messenger, { ...writer, formatHtml, send }, guarding(false)))

    await service.send({ chat: "Book", text: "<b>bold</b>", html: true })
    expect(formatHtml).toHaveBeenCalledWith("<b>bold</b>")
    expect(send).toHaveBeenCalledWith(
      "7",
      "bold",
      expect.objectContaining({ formatting: [{ type: "bold", from: 0, length: 4 }] }),
    )

    await expect(service.send({ chat: "Book", text: "<b>x</b>", html: true, markdown: true })).rejects.toThrow(
      "two ways",
    )
    const plain = messagesService(onlineDeps(messenger, writer, guarding(false)))
    await expect(plain.send({ chat: "Book", text: "<b>x</b>", html: true })).rejects.toThrow("format HTML")
    await expect(plain.edit({ chat: "Book", message: "4", text: "<b>x</b>", html: true })).rejects.toThrow(
      /format HTML|edit a message/,
    )
    expect(send).toHaveBeenCalledOnce()
  })

  it("reads one forum topic through the adapter, and refuses General, a time or reading forward", async () => {
    const topicHistory = vi.fn(async () => ({ items: [], hasMore: false }))
    const service = messagesService(onlineDeps(messenger, { ...writer, topicHistory }, guarding(false)))

    await service.list("Book", { limit: 5, before: "30", threadId: " 12 " })
    expect(topicHistory).toHaveBeenCalledWith("Book", "12", { limit: 5, before: "30" })
    await expect(service.list("Book", { limit: 5, threadId: "1" })).rejects.toThrow("General")
    await expect(service.list("Book", { limit: 5, threadId: "12", after: { id: "3" } })).rejects.toThrow("--before-id")
    await expect(service.list("Book", { limit: 5, threadId: "12", beforeTime: 1 })).rejects.toThrow("--before-id")
    const without = messagesService(onlineDeps(messenger, writer, guarding(false)))
    await expect(without.list("Book", { limit: 5, threadId: "12" })).rejects.toThrow("read one forum topic")
  })

  it("refuses invalid formatting before sending an attachment", async () => {
    const provider = {
      ...writer,
      formatMarkdown: async () => ({ text: "x", spans: [{ type: "bold" as const, from: 0, length: 8 }] }),
    }
    await expect(
      messagesService(onlineDeps(messenger, provider, guarding(false))).send({
        chat: "Book",
        text: "source",
        markdown: true,
        attachments: [{ kind: "file", name: "synthetic.txt", bytes: new Uint8Array([1]) }],
      }),
    ).rejects.toThrow("spans")
    expect(writes).toEqual([])
  })

  it("sends to the resolved chat, without the markdown marks, and records it", async () => {
    const sent = await messagesService(onlineDeps(messenger, writer, guarding(false))).send({
      chat: "Book",
      text: "**next** chapter",
      markdown: true,
    })

    expect(writes).toEqual(["send 7 next chapter"])
    expect(journal).toMatchObject([{ chatId: "7", kind: "message", outcome: "sent", messageId: "4", length: 12 }])
    expect(sent.message.id).toBe("4")
  })

  it("sends with the messenger's own form of send id when it has one", async () => {
    const minting = { ...writer, newSendId: () => "1790000000000" } as MessengerAdapter
    const sent = await messagesService(onlineDeps(messenger, minting, guarding(false))).send({
      chat: "Book",
      text: "hi",
    })

    expect(sent).toMatchObject({ sendId: "1790000000000", operationId: "1790000000000" })
    expect(journal).toMatchObject([{ sendId: "1790000000000", operationId: "1790000000000" }])
  })

  it("refuses before the messenger is asked, and records the refusal", async () => {
    const service = messagesService(onlineDeps(messenger, writer, guarding(true)))

    await expect(service.send({ chat: "Book", text: "hi" })).rejects.toThrow(/allow-list/)
    await expect(service.delete({ chat: "Book", messages: ["1"], forEveryone: false })).rejects.toThrow(/allow-list/)

    expect(writes).toEqual([])
    expect(journal.map((one) => [one.kind, one.outcome])).toEqual([
      ["message", "refused"],
      ["delete", "refused"],
    ])
  })

  it.each([undefined, "2027-01-01T12:00:00.000Z"])(
    "preserves thread addressing, formatting and attachments at %s",
    async (at) => {
      const validateThread = vi.fn(async () => {})
      const send = vi.fn(writer.send)
      const service = messagesService(onlineDeps(messenger, { ...writer, validateThread, send }, guarding(false)))
      const attachments = [{ kind: "photo" as const, name: "synthetic.png", bytes: new Uint8Array([1]) }]
      await service.send({
        chat: "Book",
        text: "**hello**",
        markdown: true,
        threadId: " 12 ",
        replyTo: "14",
        attachments,
        ...(at === undefined ? { sendId: "42" } : { at }),
      })
      expect(validateThread).toHaveBeenCalledWith("7", "12", { replyTo: "14" })
      expect(send).toHaveBeenCalledWith(
        "7",
        "hello",
        expect.objectContaining({
          threadId: "12",
          replyTo: "14",
          formatting: [{ type: "bold", from: 0, length: 5 }],
          attachments,
          ...(at === undefined ? { sendId: "42" } : { at }),
        }),
      )
      expect(journal[0]).toMatchObject({ threadId: "12", replyTo: "14", outcome: "sent" })
      expect(JSON.stringify(journal)).not.toContain("hello")
    },
  )

  it("refuses unsupported and empty threads without sending", async () => {
    const service = messagesService(onlineDeps(messenger, writer, guarding(false)))
    await expect(service.send({ chat: "Book", text: "hi", threadId: "12" })).rejects.toThrow(
      "cannot send to a forum topic",
    )
    await expect(service.send({ chat: "Book", text: "hi", threadId: " " })).rejects.toThrow("--topic needs")
    expect(writes).toEqual([])
  })

  it("forwards into a topic only where the messenger can, checking it in the --to chat before the write", async () => {
    const forward = vi.fn(async (_from: string, _id: string, to: string) => ({ ...thread[0], id: "9", chatId: to }))
    const validateThread = vi.fn(async () => {
      throw Object.assign(new Error("topic closed"), { code: "permission_error" })
    })
    const connection = { ...writer, forward, validateThread } as unknown as MessengerAdapter
    const target = { chat: "Book", message: "3", to: "20", silent: false, threadId: "5" }

    await expect(messagesService(onlineDeps(messenger, connection, guarding(false))).forward(target)).rejects.toThrow(
      "cannot forward to a forum topic",
    )
    const topics = { ...messenger, forwardTopic: true }
    await expect(messagesService(onlineDeps(topics, connection, guarding(false))).forward(target)).rejects.toThrow(
      "topic closed",
    )
    expect(validateThread).toHaveBeenCalledWith("20", "5", {})
    expect(forward).not.toHaveBeenCalled()
  })

  it("checks permissions before reading the topic, and records preflight failure without sending", async () => {
    const validateThread = vi.fn(async () => {
      throw Object.assign(new Error("topic deleted"), { code: "not_found" })
    })
    const connection = { ...writer, validateThread }
    await expect(
      messagesService(onlineDeps(messenger, connection, guarding(true))).send({
        chat: "Book",
        text: "hi",
        threadId: "12",
      }),
    ).rejects.toThrow(/allow-list/)
    expect(validateThread).not.toHaveBeenCalled()
    await expect(
      messagesService(onlineDeps(messenger, connection, guarding(false))).send({
        chat: "Book",
        text: "hi",
        threadId: "12",
      }),
    ).rejects.toThrow("topic deleted")
    expect(writes).toEqual([])
    expect(journal.map(({ outcome }) => outcome)).toEqual(["refused", "failed"])
  })

  it("never writes offline", async () => {
    const service = messagesService(storedDeps(messenger, await keptStore(), account, guarding(false)))

    await expect(service.delete({ chat: "7", messages: ["1"], forEveryone: false })).rejects.toThrow(/--offline/)
    expect(journal).toEqual([])
  })
})

it("checks an explicit unpin denial separately from allowed pinning", async () => {
  const dir = mkdtempSync(join(tmpdir(), "unpin-policy-"))
  const guard = sendGuard({
    profile: "p",
    readOnly: false,
    readOnlyFrom: "default",
    permissions: { "messages.pin": "allow", "messages.unpin": "deny" },
    sendsPerHour: 30,
    journal: new SendJournal(join(dir, "sends.jsonl")),
    recipients: new RecipientList(join(dir, "recipients.json"), "test"),
    warn: () => {},
  })
  const pin = vi.fn(async () => {})
  const unpin = vi.fn(async () => {})
  const connection = { ...adapter, resolve: async () => chat, pin, unpin }
  const service = messagesService(onlineDeps(messenger, connection, guard))
  await service.pin({ chat: "7", message: "1", notify: false })
  await expect(service.unpin({ chat: "7", message: "1" })).rejects.toMatchObject({ code: "permission_error" })
  expect(pin).toHaveBeenCalledOnce()
  expect(unpin).not.toHaveBeenCalled()
})
