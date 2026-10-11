import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CliError } from "@wirecat/cli-core"
import { afterEach, describe, expect, it } from "vitest"
import type { Messenger } from "../cli/messenger/context.js"
import type { MessengerAdapter } from "../cli/messenger/port.js"
import type { Chat, Message } from "../domain/models.js"
import type { SendGuard } from "../sends/guard.js"
import { fetchedKey, historyStartKey, type MessageStore, openStore } from "../store/store.js"
import { archiveService } from "./archive.js"
import type { ServiceDeps } from "./deps.js"
import { storedDeps } from "./deps.js"
import { inboxService } from "./inbox.js"
import { servicesFor } from "./index.js"

const account = { provider: "test", account: "500" }
const messenger = { provider: "test", chatArgument: "a chat" } as Messenger
const guard = {} as SendGuard

const chat: Chat = {
  id: "7",
  title: "Book club",
  kind: "group",
  unreadCount: 0,
  lastMessageAt: "2026-09-27T10:05:00.000Z",
  participantsCount: 4,
}

const messageAt = (id: number): Message => ({
  id: String(id),
  chatId: "7",
  senderId: "9",
  senderName: "Olga",
  timestamp: new Date(Date.parse("2026-09-27T10:00:00.000Z") + id * 60_000).toISOString(),
  editedAt: null,
  text: `chapter ${id}`,
  outgoing: false,
  attachments: [],
  replyTo: null,
  forwardedFrom: null,
  reactions: null,
})

const opened: MessageStore[] = []
const emptyStore = async () => {
  const store = await openStore({ path: join(mkdtempSync(join(tmpdir(), "services-")), "m.db") })
  opened.push(store)
  await store.saveChats(account, [chat])
  return store
}

afterEach(async () => {
  for (const store of opened.splice(0)) await store.close()
})

describe("the archive service", () => {
  it("fetches a chat page by page into the store, then reads it back out oldest first", async () => {
    const store = await emptyStore()
    const history = [1, 2, 3, 4, 5].map(messageAt)
    const adapter = {
      self: () => "500",
      history: async (_chat: string, { limit, before }: { limit: number; before?: string }) => {
        const older = history.filter((one) => before === undefined || Number(one.id) < Number(before))
        const items = older.slice(-limit)
        await store.saveMessages(account, "7", items, { via: "history" })
        return { items, hasMore: older.length > items.length }
      },
    } as unknown as MessengerAdapter
    const deps: ServiceDeps = {
      ...storedDeps(messenger, store, account, guard),
      offline: false,
      connection: async () => adapter,
    }
    const service = archiveService(deps)

    const fetched = await service.fetch("Book club", {
      limit: 1000,
      pageSize: 100,
      pauseMs: 0,
      note: () => {},
      stop: new AbortController().signal,
      onPage: () => {},
    })
    const exported = await service.export("book club")

    expect(fetched).toMatchObject({ chat: "7", fetched: 5, complete: true, ranges: [{ from: 1, to: 5 }] })
    expect(exported.title).toBe("Book club")
    expect(exported.messages.map((one) => one.id)).toEqual(["1", "2", "3", "4", "5"])
    expect(await service.held("7")).toEqual([{ from: 1, to: 5 }])
    expect(await store.syncState(account, historyStartKey("7"))).toMatchObject({ value: "1" })
    expect(await store.syncState(account, fetchedKey("7"))).toMatchObject({ value: "5" })
  })
})

describe("fetching every chat", () => {
  it("walks the chats most recently active first, counts a failing chat and goes on", async () => {
    const store = await emptyStore()
    const quiet = { ...chat, id: "8", title: "Quiet", lastMessageAt: "2026-01-01T00:00:00.000Z" }
    const broken = { ...chat, id: "9", title: "Broken", lastMessageAt: "2026-05-01T00:00:00.000Z" }
    const asked: string[] = []
    const adapter = {
      self: () => "500",
      chats: async () => ({ items: [quiet, broken, chat], hasMore: false }),
      history: async (reference: string) => {
        asked.push(reference)
        if (reference === "9") throw new Error("private provider detail")
        const items = [messageAt(1)].map((one) => ({ ...one, chatId: reference }))
        await store.saveMessages(account, reference, items, { via: "history" })
        return { items, hasMore: false }
      },
    } as unknown as MessengerAdapter
    const service = archiveService({
      ...storedDeps(messenger, store, account, guard),
      offline: false,
      connection: async () => adapter,
    })

    const all = await service.fetchAll({
      limit: 100,
      pageSize: 100,
      pauseMs: 0,
      note: () => {},
      stop: new AbortController().signal,
      onPage: () => {},
    })

    expect(asked).toEqual(["7", "9", "8"])
    expect(all).toMatchObject({ chats: 3, fetched: 2, complete: false })
    expect(all.items.map(({ chat, error }) => [chat, error ?? null])).toEqual([
      ["7", null],
      ["9", "generic_failure"],
      ["8", null],
    ])
    expect(JSON.stringify(all)).not.toContain("private provider detail")
  })
  it("sits out a short wait the chat list asks for, then fetches", async () => {
    const store = await emptyStore()
    let listed = 0
    const adapter = {
      self: () => "500",
      chats: async () => {
        listed += 1
        if (listed === 1) throw new CliError("rate_limited", "provider asks to wait", { retryAfterMs: 5 })
        return { items: [chat], hasMore: false }
      },
      history: async () => {
        await store.saveMessages(account, "7", [messageAt(1)], { via: "history" })
        return { items: [messageAt(1)], hasMore: false }
      },
    } as unknown as MessengerAdapter
    const notes: string[] = []
    const service = archiveService({
      ...storedDeps(messenger, store, account, guard),
      offline: false,
      connection: async () => adapter,
    })

    const all = await service.fetchAll({
      limit: 100,
      pageSize: 100,
      pauseMs: 0,
      note: (message) => notes.push(message),
      stop: new AbortController().signal,
      onPage: () => {},
    })

    expect(listed).toBe(2)
    expect(all).toMatchObject({ chats: 1, fetched: 1 })
    expect(notes.some((note) => note.startsWith("asked to wait"))).toBe(true)
  })
})

describe("what a search says about the archive", () => {
  it("counts what it searched, lists the chats a fetch would improve and names the one command", async () => {
    const store = await emptyStore()
    const quiet = { ...chat, id: "8", title: "Quiet", lastMessageAt: "2026-01-01T00:00:00.000Z" }
    await store.saveChats(account, [quiet])
    await store.saveMessages(account, "8", [{ ...messageAt(9), chatId: "8" }], { via: "context" })
    const history = [1, 2, 3, 4, 5].map(messageAt)
    const adapter = {
      self: () => "500",
      history: async () => {
        await store.saveMessages(account, "7", history, { via: "history" })
        return { items: history, hasMore: false }
      },
    } as unknown as MessengerAdapter
    const deps = {
      ...storedDeps({ ...messenger, app: { command: "chat" } } as Messenger, store, account, guard),
      offline: false,
      connection: async () => adapter,
    }
    const options = { limit: 100, pageSize: 100, pauseMs: 0, note: () => {}, onPage: () => {} }
    await archiveService(deps).fetch("7", { ...options, stop: new AbortController().signal })
    await store.fillSearchIndex()
    await store.fillStems()
    const search = (query: { chat?: string }) =>
      servicesFor(deps).messages.search({ text: "chapter", language: "lucene", limit: 20, ...query })

    const everywhere = await search({})
    const one = await search({ chat: "8" })
    const fetched = await search({ chat: "7" })

    expect(everywhere.coverage).toMatchObject({
      messages: 6,
      coveredChats: 2,
      chats: { complete: 1, neverFetched: 1 },
      attention: [{ chatId: "8", title: "Quiet", state: "unknown" }],
      next: "chat store fetch --all --background",
    })
    expect(one.coverage?.next).toBe("chat store fetch 8")
    expect(fetched.coverage).toMatchObject({ messages: 5, attention: [], next: null })
  })
})

describe("the inbox service", () => {
  it("refuses offline, before anything is opened", async () => {
    const service = inboxService(storedDeps(messenger, await emptyStore(), account, guard))

    await expect(service.read({ limit: 20 })).rejects.toThrow(/`inbox` asks the messenger/)
    await expect(service.review({ since: 0 })).rejects.toThrow(/`review` asks the messenger/)
  })
})

it("keeps earlier history pages and tells the caller when and where to resume", async () => {
  const store = await emptyStore()
  let calls = 0
  const adapter = {
    self: () => "500",
    history: async () => {
      calls += 1
      if (calls > 1) throw new CliError("rate_limited", "provider asks to wait", { retryAfterMs: 600000 })
      const items = [messageAt(5), messageAt(4)]
      await store.saveMessages(account, "7", items, { via: "history" })
      return { items, hasMore: true }
    },
  } as unknown as MessengerAdapter
  const service = archiveService({
    ...storedDeps(messenger, store, account, guard),
    offline: false,
    connection: async () => adapter,
  })
  const result = await service.fetch("7", {
    limit: 100,
    pageSize: 2,
    pauseMs: 0,
    note: () => {},
    stop: new AbortController().signal,
    onPage: () => {},
  })
  expect(result).toMatchObject({
    fetched: 2,
    complete: false,
    ranges: [{ from: 4, to: 5 }],
    resume: { before: "4" },
    issue: { code: "rate_limited", retryAfterMs: 600000 },
  })
  expect(calls).toBe(2)
})

it("fails the fetch when the first page fails, as there is nothing to resume", async () => {
  const store = await emptyStore()
  const adapter = {
    self: () => "500",
    history: async () => {
      throw new CliError("validation_error", "give --from <message link>")
    },
  } as unknown as MessengerAdapter
  const service = archiveService({
    ...storedDeps(messenger, store, account, guard),
    offline: false,
    connection: async () => adapter,
  })
  await expect(
    service.fetch("7", {
      limit: 100,
      pageSize: 2,
      pauseMs: 0,
      note: () => {},
      stop: new AbortController().signal,
      onPage: () => {},
    }),
  ).rejects.toMatchObject({ code: "validation_error" })
})
