import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CliError } from "@wirecat/cli-core"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { Messenger } from "../cli/messenger/context.js"
import type { MessengerAdapter, ServerQuery } from "../cli/messenger/port.js"
import type { Chat, Message, MessageHit } from "../domain/models.js"
import type { SendGuard } from "../sends/guard.js"
import { type MessageStore, openStore } from "../store/store.js"
import { servicesFor, storedDeps } from "./index.js"
import type { SearchQuery } from "./messages.js"

const account = { provider: "test", account: "500" }
const messenger = { provider: "test", app: { command: "chat" }, serverSearch: true } as Messenger
const chat = (id: string): Chat => ({
  id,
  title: `Chat ${id}`,
  kind: "group",
  unreadCount: 0,
  lastMessageAt: null,
  participantsCount: null,
})
const message = (chatId: string, id: string, text: string): Message => ({
  id,
  chatId,
  senderId: "9",
  senderName: "Reader",
  timestamp: `2026-10-01T00:00:0${id}.000Z`,
  editedAt: null,
  text,
  outgoing: false,
  attachments: [],
  replyTo: null,
  forwardedFrom: null,
  reactions: null,
})
const hit = (chatId: string, id: string, text: string): MessageHit => ({
  ...message(chatId, id, text),
  chatTitle: `Chat ${chatId}`,
})

const stores: MessageStore[] = []
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close()
})

const setup = async (
  answer: (query: ServerQuery) => Promise<{ items: MessageHit[]; hasMore: boolean; chats: Chat[] }> = async () => ({
    items: [hit("7", "1", "invoice paid"), hit("8", "2", "invoices sent"), hit("8", "3", "nothing here")],
    hasMore: false,
    chats: [chat("7"), chat("8")],
  }),
) => {
  const store = await openStore({ path: join(mkdtempSync(join(tmpdir(), "server-search-")), "m.db") })
  stores.push(store)
  await store.saveChats(account, [chat("7")])
  await store.saveMessages(account, "7", [message("7", "1", "invoice paid"), message("7", "4", "invoice due")], {
    via: "history",
  })
  const asked: ServerQuery[] = []
  const searchMessages = vi.fn(async (query: ServerQuery) => {
    asked.push(query)
    return answer(query)
  })
  const adapter = { self: () => "500", searchMessages } as unknown as MessengerAdapter
  const guard = { check: vi.fn(), record: vi.fn() } satisfies SendGuard
  const connection = vi.fn(async () => adapter)
  const deps = { ...storedDeps(messenger, store, account, guard), offline: false, connection }
  const search = (query: Partial<SearchQuery>) =>
    servicesFor(deps).messages.search({ language: "lucene", limit: 20, ...query })
  return { store, deps, asked, guard, connection, search }
}

describe("server search beside the archive", () => {
  it("answers archive and server hits in one strict list, each with its source", async () => {
    const one = await setup()
    const found = await one.search({ text: "invoice", backend: "both" })
    expect(found.items.map(({ chatId, id, source }) => [chatId, id, source]).sort()).toEqual([
      ["7", "1", "both"],
      ["7", "4", "archive"],
      ["8", "2", "server"],
    ])
    expect(found.server).toEqual({
      backend: "both",
      skipped: null,
      calls: 1,
      returned: 3,
      new: 2,
      failed: [],
      complete: true,
    })
    expect(await one.store.message(account, "3", { chatId: "8" })).toMatchObject({ text: "nothing here" })
  })

  it("**search all** asks the server as search messages does, so it finds a message only the server holds", async () => {
    const one = await setup(async () => ({
      items: [hit("8", "2", "invoices sent")],
      hasMore: false,
      chats: [chat("8")],
    }))
    await one.store.saveChats({ provider: "test", account: "501" }, [chat("9")])
    const found = await servicesFor(one.deps).messages.searchAll({ text: "invoice", limit: 20, only: ["messages"] })
    expect(found.items.map(({ ref }) => ref).sort()).toEqual([
      "msg:test/500/7/1",
      "msg:test/500/7/4",
      "msg:test/500/8/2",
    ])
    expect(found.server).toMatchObject({ backend: "both", calls: 1, new: 1 })
  })

  it("**search all** on a fresh store, with no row for its own account yet, still asks the server", async () => {
    const store = await openStore({ path: join(mkdtempSync(join(tmpdir(), "server-search-")), "m.db") })
    stores.push(store)
    const searchMessages = vi.fn(async () => ({
      items: [hit("8", "2", "invoices sent")],
      hasMore: false,
      chats: [chat("8")],
    }))
    const adapter = { self: () => "500", searchMessages } as unknown as MessengerAdapter
    const guard = { check: vi.fn(), record: vi.fn() } satisfies SendGuard
    const deps = {
      ...storedDeps(messenger, store, account, guard),
      offline: false,
      connection: vi.fn(async () => adapter),
    }
    const found = await servicesFor(deps).messages.searchAll({ text: "invoice", limit: 20, only: ["messages"] })
    expect(found.items.map(({ ref }) => ref)).toEqual(["msg:test/500/8/2"])
    expect(found.server).toMatchObject({ calls: 1, new: 1 })
  })

  it("keeps exact: and negations strict over server candidates", async () => {
    const one = await setup()
    const exact = await one.search({ text: "exact:invoice", backend: "both" })
    expect(exact.items.map(({ id }) => id).sort()).toEqual(["1", "4"])
    const negated = await one.search({ text: "invoice -paid", backend: "both" })
    expect(negated.items.map(({ id }) => id).sort()).toEqual(["2", "4"])
    expect(one.asked.map(({ text }) => text)).toEqual(["invoice", "invoice"])
  })

  it("searches only what the server returned with --backend server", async () => {
    const one = await setup()
    const found = await one.search({ text: "invoice", backend: "server" })
    expect(found.items.map(({ id, source }) => [id, source]).sort()).toEqual([
      ["1", "both"],
      ["2", "server"],
    ])
  })

  it.each([
    { name: "--source all", query: { text: "invoice", source: "all" } },
    { name: "in:all", query: { text: "invoice in:all" } },
  ])("**keeps --backend server to the account it runs as** under $name", async ({ query }) => {
    const one = await setup()
    const twin = { provider: "test", account: "501" }
    await one.store.saveChats(twin, [chat("7"), chat("8")])
    await one.store.saveMessages(twin, "7", [message("7", "1", "invoice paid")], { via: "history" })
    await one.store.saveMessages(twin, "8", [message("8", "2", "invoices sent")], { via: "history" })
    const found = await one.search({ ...query, backend: "server" })
    expect(found.items.map(({ locator, source }) => [locator, source]).sort()).toEqual([
      ["msg:test/500/7/1", "both"],
      ["msg:test/500/8/2", "server"],
    ])
  })

  it("labels another account's twin of a server hit as the archive's under --backend both", async () => {
    const one = await setup()
    const twin = { provider: "test", account: "501" }
    await one.store.saveChats(twin, [chat("7")])
    await one.store.saveMessages(twin, "7", [message("7", "1", "invoice paid")], { via: "history" })
    const found = await one.search({ text: "invoice", source: "all", backend: "both" })
    expect(found.items.filter(({ locator }) => locator.startsWith("msg:test/501/"))).toEqual([
      expect.objectContaining({ locator: "msg:test/501/7/1", source: "archive" }),
    ])
  })

  it.each([
    { text: "invoice chat:7", sent: [{ text: "invoice", chat: "7" }] },
    { text: "invoice", chat: "7", sent: [{ text: "invoice", chat: "7" }] },
    { text: "invoice OR receipt", sent: [{ text: "invoice" }, { text: "receipt" }] },
    { text: '"invoice paid" -late has:file', sent: [{ text: "invoice paid" }] },
    {
      text: "invoice date:[2026-10-01 TO 2026-10-02]",
      timezone: "UTC",
      sent: [{ text: "invoice", minDate: Date.UTC(2026, 9, 1), maxDate: Date.UTC(2026, 9, 3) - 1 }],
    },
  ])("sends only what narrows the candidates for $text", async ({ sent, ...query }) => {
    const one = await setup()
    await one.search({ ...query, backend: "both" })
    expect(one.asked).toEqual(sent)
  })

  it("makes at most three calls and says the answer is incomplete", async () => {
    const one = await setup()
    const found = await one.search({ text: "a OR b OR c OR d", backend: "both" })
    expect(one.asked).toHaveLength(3)
    expect(found.server?.complete).toBe(false)
  })

  it.each([
    { name: "no_words", query: { text: "has:file" }, deps: {} },
    { name: "legacy", query: { text: "invoice", language: "legacy" as const }, deps: {} },
    { name: "offline", query: { text: "invoice" }, deps: { offline: true } },
    { name: "pushed_history", query: { text: "invoice" }, deps: { reads: "store" as const } },
    { name: "unsupported", query: { text: "invoice" }, deps: { messenger: { ...messenger, serverSearch: false } } },
  ])("falls back to the archive under both, and refuses under server: $name", async ({ name, query, deps }) => {
    const one = await setup()
    const services = servicesFor({ ...one.deps, ...deps })
    const found = await services.messages.search({ language: "lucene", limit: 20, ...query, backend: "both" })
    expect(found.server).toMatchObject({ skipped: name, complete: false, calls: 0 })
    expect(found.items.every(({ source }) => source === "archive")).toBe(true)
    expect(one.connection).not.toHaveBeenCalled()
    await expect(
      services.messages.search({ language: "lucene", limit: 20, ...query, backend: "server" }),
    ).rejects.toMatchObject({ code: "validation_error", details: { reason: name } })
  })

  it("asks a one-chat server only for a query that names one chat", async () => {
    const one = await setup()
    const services = servicesFor({ ...one.deps, messenger: { ...messenger, serverSearch: "chat" } })
    const search = (query: Partial<SearchQuery>) =>
      services.messages.search({ language: "lucene", limit: 20, text: "invoice", ...query })
    expect((await search({ backend: "both" })).server).toMatchObject({ skipped: "needs_chat" })
    expect((await search({})).server).toBeUndefined()
    await expect(search({ backend: "server" })).rejects.toMatchObject({ details: { reason: "needs_chat" } })
    expect(one.asked).toEqual([])
    expect((await search({ chat: "7" })).server).toMatchObject({ calls: 1, skipped: null })
    expect(one.asked).toEqual([{ text: "invoice", chat: "7" }])
  })

  it("answers from the archive when the profile does not allow the server search", async () => {
    const one = await setup()
    one.guard.check.mockImplementation(() => {
      throw new CliError("permission_error", "readonly")
    })
    const found = await one.search({ text: "invoice", backend: "both" })
    expect(found.server?.skipped).toBe("not_allowed")
    expect(found.items).toHaveLength(2)
    await expect(one.search({ text: "invoice", backend: "server" })).rejects.toMatchObject({
      code: "permission_error",
    })
  })

  it("drops a reply that comes after the time bound and writes nothing", async () => {
    let late: (() => void) | undefined
    const one = await setup(
      () =>
        new Promise((resolve) => {
          late = () => resolve({ items: [hit("8", "2", "invoices sent")], hasMore: false, chats: [chat("8")] })
        }),
    )
    const found = await one.search({ text: "invoice", backend: "both", server: { timeMs: 20 } })
    expect(found.server).toMatchObject({ complete: false, failed: [{ chat: null, reason: "time_or_abort_bound" }] })
    expect(found.items.map(({ id }) => id).sort()).toEqual(["1", "4"])
    late?.()
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(await one.store.message(account, "2", { chatId: "8" })).toBeUndefined()
  })

  it("names a flood wait without the provider's words", async () => {
    const one = await setup(async () => {
      throw new CliError("rate_limited", "Telegram asks to wait 30 s")
    })
    const found = await one.search({ text: "invoice", backend: "both" })
    expect(found.server?.failed).toEqual([{ chat: null, reason: "rate_limited" }])
    expect(found.items).toHaveLength(2)
  })

  it("keeps the archive answer when the connection fails", async () => {
    const one = await setup()
    one.connection.mockRejectedValue(new Error("private provider detail"))
    const found = await one.search({ text: "invoice", backend: "both" })
    expect(found.server?.failed).toEqual([{ chat: null, reason: "search_failed" }])
    expect(found.items).toHaveLength(2)
    expect(JSON.stringify(found)).not.toContain("private provider detail")
  })

  it("asks the server by default, and stays quiet where it cannot", async () => {
    const one = await setup()
    const found = await one.search({ text: "invoice" })
    expect(found.server).toMatchObject({ backend: "both", calls: 1, new: 2 })
    const local = servicesFor({ ...one.deps, offline: true })
    const offline = await local.messages.search({ language: "lucene", limit: 20, text: "invoice" })
    expect(offline.server).toBeUndefined()
    expect(offline.items[0]).not.toHaveProperty("source")
    const archive = await one.search({ text: "invoice", backend: "archive" })
    expect(archive.server).toBeUndefined()
    expect(one.asked).toHaveLength(1)
  })
})
