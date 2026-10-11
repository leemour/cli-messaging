import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { Message } from "../domain/models.js"
import { implicitTextTerms, parseLucene } from "../search/lucene/parser.js"
import { QUERY_LIMITS } from "../search/lucene/types.js"
import { type AccountKey, type MessageStore, openStore } from "../store/store.js"
import { searchStore } from "./messages.js"
import { COMBINED_DEFAULTS, searchCombined } from "./messages-combined.js"

const account: AccountKey = { provider: "synthetic", account: "500" }
const stores: MessageStore[] = []
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close()
  vi.restoreAllMocks()
})
const message = (id: string, text: string, extra: Partial<Message> = {}): Message => ({
  id,
  chatId: "101",
  senderId: "700",
  senderName: "Mira",
  timestamp: `2026-10-02T12:00:${id.padStart(2, "0")}.000Z`,
  editedAt: null,
  text,
  outgoing: false,
  attachments: [],
  replyTo: null,
  forwardedFrom: null,
  reactions: null,
  ...extra,
})
const opened = async (
  messages = [message("1", "Aurora rollout decision"), message("2", "Aurora rolling decision")],
) => {
  const store = await openStore({ path: join(mkdtempSync(join(tmpdir(), "combined-test-")), "quality.db") })
  stores.push(store)
  await store.saveChats(account, [
    { id: "101", title: "Decisions", kind: "group", unreadCount: 0, lastMessageAt: null, participantsCount: 20 },
    { id: "102", title: "Other", kind: "group", unreadCount: 0, lastMessageAt: null, participantsCount: 20 },
  ])
  await store.saveMessages(account, "101", messages, { via: "synthetic" })
  await store.fillSearchIndex({})
  await store.fillStems({})
  return store
}
const request = (text: string) => ({ text, limit: 10, timezone: "UTC" })
const ids = (found: { items: { id: string }[] }) => found.items.map((h) => h.id)

describe("internal combined search", () => {
  it("merges whole and prefix matches even when whole words already match, with positive scores and labels", async () => {
    const store = await opened()
    const found = await searchCombined(store, account, request("aurora roll"))
    expect(ids(found).sort()).toEqual(["1", "2"])
    expect(found.items).toEqual(
      expect.arrayContaining([expect.objectContaining({ match: "beginnings", matches: ["beginnings"] })]),
    )
    for (const hit of found.items) expect(hit.score).toBeGreaterThan(0)
    expect(found.query.combined).toMatchObject({ expanded: true, truncated: false })
    expect(found.coverage?.accounts).toEqual([account])
    const mixed = await searchCombined(store, account, request("aurora rollout"))
    expect(mixed.items[0]).toMatchObject({ match: "words", matches: ["words"] })
    expect(new Set(mixed.items.map((h) => h.locator)).size).toBe(mixed.items.length)
  })

  it("reports only a used correction and never falls back to any-word or substring", async () => {
    const store = await opened()
    const fixed = await searchCombined(store, account, request("aurora rolluot"))
    expect(ids(fixed)).toEqual(["1"])
    expect(fixed.items[0]).toMatchObject({ match: "corrected", matches: ["corrected"] })
    expect(fixed.corrections).toEqual([{ from: "rolluot", to: ["rollout"] }])
    for (const text of ["aurora quantum unicorn", "lout", "aurora rolluot purple"]) {
      const found = await searchCombined(store, account, request(text))
      expect(found.items).toEqual([])
      expect(found.corrections).toEqual([])
    }
  })

  it.each([
    "aurora AND rolluot",
    "aurora OR rolluot",
    "aurora NOT rollout",
    "+aurora rolluot",
    "aurora -rollout",
    "aurora !rollout",
    '"aurora rolluot"',
    "text:rolluot",
    "exact:rolluot",
    "(aurora rolluot)",
  ])("preserves the strict execution for %s", async (text) => {
    const store = await opened()
    const strict = await searchStore(store, account, { ...request(text), language: "lucene" })
    const combined = await searchCombined(store, account, request(text))
    expect(combined.items).toEqual(strict.items)
    expect(combined.corrections).toEqual([])
  })

  it("preserves phrases, sender, chat, date, source and only-message boundaries across corrections", async () => {
    const store = await opened([
      message("1", "Aurora rollout green light"),
      message("2", "Aurora rollout light green"),
      message("3", "Aurora rollout green light", { senderId: "701" }),
      message("4", "Aurora rollout green light", { timestamp: "2026-10-03T12:00:00.000Z" }),
    ])
    await store.saveMessages(account, "102", [message("5", "Aurora rollout green light", { chatId: "102" })], {
      via: "synthetic",
    })
    const other = { provider: "synthetic", account: "600" }
    await store.saveChats(other, [
      { id: "101", title: "Other account", kind: "group", unreadCount: 0, lastMessageAt: null, participantsCount: 10 },
    ])
    await store.saveMessages(other, "101", [message("6", "Aurora rollout green light")], { via: "synthetic" })
    const found = await searchCombined(
      store,
      account,
      request('aurora rolluot "green light" from:700 chat:101 date:2026-10-02'),
    )
    expect(ids(found)).toEqual(["1"])
    expect(
      ids(
        await searchCombined(store, account, {
          ...request("aurora rolluot"),
          only: [{ ...account, chatId: "101", id: "3" }],
        }),
      ),
    ).toEqual(["3"])
    expect(
      ids(
        await searchCombined(store, account, {
          ...request("aurora rolluot"),
          senders: [{ provider: "synthetic", id: "701" }],
        }),
      ),
    ).toEqual(["3"])
    const all = await searchCombined(store, account, { ...request("aurora rolluot"), source: "all" })
    expect(all.items.some((h) => h.id === "6")).toBe(true)
    expect((await searchCombined(store, account, request("aurora rolluot"))).items.some((h) => h.id === "6")).toBe(
      false,
    )
  })

  it("retains strict exact and AST requests and the legacy SDK default", async () => {
    const store = await opened()
    const ast = parseLucene("aurora rollout")
    const exact = { ...request("aurora roll"), exact: true }
    expect((await searchCombined(store, account, exact)).items).toEqual(
      (await searchStore(store, account, { ...exact, language: "lucene" })).items,
    )
    const structured = { ast, limit: 10, timezone: "UTC" }
    expect((await searchCombined(store, account, structured)).items).toEqual(
      (await searchStore(store, account, structured)).items,
    )
    expect(
      (await searchStore(store, account, { text: "aurora quantum unicorn", limit: 10 })).items.length,
    ).toBeGreaterThan(0)
    expect((await searchCombined(store, account, request("aurora quantum unicorn"))).items).toEqual([])
  })

  it("matches stems and corrections independently, including Cyrillic", async () => {
    const store = await opened([
      message("1", "Север сертификат обновление"),
      message("2", "Aurora running safely"),
      message("3", "Aurora runners safely"),
    ])
    expect(ids(await searchCombined(store, account, request("север сертифкат")))).toEqual(["1"])
    const stemmed = await searchCombined(store, account, request("aurora run"))
    expect(ids(stemmed).sort()).toEqual(["2", "3"])
    expect(stemmed.query.stemming).toMatchObject({ applied: true })
  })

  it.each([1, 10, 50, 1000])(
    "honors limit %i, exposes truncation, hydrates context and sorts newest chronologically",
    async (limit) => {
      const store = await opened([
        message("1", "Aurora rollout decision"),
        message("2", "Aurora rollout"),
        message("3", "Aurora rollouts"),
      ])
      const found = await searchCombined(
        store,
        account,
        { ...request("aurora roll"), limit, newest: true, context: 1 },
        {},
        { ...COMBINED_DEFAULTS, candidateDepth: 1, chatCap: 3 },
      )
      expect(found.items.length).toBeLessThanOrEqual(limit)
      expect(found.items.every((h) => h.context)).toBe(true)
      expect(found.query.order).toBe("newest")
      const timestamps = found.items.map((h) => h.timestamp)
      expect(timestamps).toEqual([...timestamps].sort().reverse())
      if (limit === 1) {
        expect(found.hasMore).toBe(true)
        expect(found.query.combined.truncated).toBe(true)
      }
    },
  )

  it("diversifies chats without dropping deferred matches; one-chat requests keep their order", async () => {
    const store = await opened([
      message("1", "Aurora rollout"),
      message("2", "Aurora rollout"),
      message("3", "Aurora rollout"),
      message("4", "Aurora rollout"),
    ])
    await store.saveMessages(
      account,
      "102",
      [message("5", "Aurora rollout context long enough to rank behind", { chatId: "102" })],
      { via: "synthetic" },
    )
    const options = { ...COMBINED_DEFAULTS, chatCap: 3 }
    const diverse = await searchCombined(store, account, { ...request("aurora rollout"), limit: 5 }, {}, options)
    expect(diverse.items.slice(0, 3).some((h) => h.chatId === "102")).toBe(true)
    expect(diverse.items.length).toBe(5)
    const scoped = { ...request("aurora rollout"), chat: "101" }
    expect(ids(await searchCombined(store, account, scoped, {}, options))).toEqual(
      ids(await searchCombined(store, account, scoped)),
    )
  })

  it("handles filters-only, an empty authorized scope, and unsupported internal requests", async () => {
    const store = await opened()
    expect(ids(await searchCombined(store, account, request("chat:101")))).toEqual(["2", "1"])
    expect((await searchCombined(store, account, { ...request("aurora"), source: "bots" })).items).toEqual([])
    for (const extras of [
      { language: "legacy" as const },
      { pattern: /aurora/iu },
      { thread: { before: 1, after: 1 } },
    ])
      await expect(searchCombined(store, account, { ...request("aurora"), ...extras })).rejects.toMatchObject({
        code: "validation_error",
      })
    await expect(searchCombined({ ...store, matchQuery: undefined }, account, request("aurora"))).rejects.toThrow(
      "does not support Lucene",
    )
  })

  it.each([
    { candidateDepth: 0 },
    { candidateDepth: 1001 },
    { rrfK: 0 },
    { rrfK: NaN },
    { chatCap: -1 },
    { chatCap: 0.5 },
  ])("refuses invalid options %j", async (options) => {
    const store = await opened()
    await expect(
      searchCombined(store, account, request("aurora"), {}, { ...COMBINED_DEFAULTS, ...options }),
    ).rejects.toMatchObject({ code: "validation_error" })
  })

  it("honors cancellation before retrieval and between sources", async () => {
    const store = await opened()
    const before = new AbortController()
    before.abort()
    await expect(searchCombined(store, account, { ...request("aurora"), signal: before.signal })).rejects.toMatchObject(
      { details: { reason: "query_aborted" } },
    )
    const during = new AbortController()
    const match = store.matchQuery
    if (!match) throw new Error("test store must support Lucene")
    const interrupted = {
      ...store,
      matchQuery: vi.fn(async (...args: Parameters<typeof match>) => {
        const found = await match(...args)
        during.abort()
        return found
      }),
    }
    await expect(
      searchCombined(interrupted, account, { ...request("aurora"), signal: during.signal }),
    ).rejects.toMatchObject({ details: { reason: "query_aborted" } })
    expect(interrupted.matchQuery).toHaveBeenCalledTimes(1)
  })
})

it("keeps explicit wildcard and regex predicates as hard constraints beside expanded words", async () => {
  const store = await opened([
    message("1", "Aurora rollout decision"),
    message("2", "Aurorax rolling decision"),
    message("3", "Aurora unrelated decision"),
  ])
  expect(ids(await searchCombined(store, account, request("auror roll*"))).sort()).toEqual(["1", "2"])
  expect(ids(await searchCombined(store, account, request("auror text:/rollout/")))).toEqual(["1"])
})

it.each(["none", "coverage", "proximity", "phrase", "all"] as const)(
  "scores the %s ablation without leaking fusion state",
  async (rerank) => {
    const store = await opened([
      message("1", "Aurora widely separated rollout"),
      message("2", "Aurora rollout decision"),
    ])
    const found = await searchCombined(store, account, request("aurora rollout"), {}, { ...COMBINED_DEFAULTS, rerank })
    expect(found.items).toHaveLength(2)
    expect(found.items.every((hit) => Number.isFinite(hit.score) && Number(hit.score) > 0)).toBe(true)
    expect(found.items[0]).not.toHaveProperty("fused")
    if (rerank === "phrase" || rerank === "all" || rerank === "proximity") expect(ids(found)[0]).toBe("2")
  },
)

it("bounds hydrated candidate bytes, reranking work and elapsed time", async () => {
  const store = await opened()
  const original = await searchStore(store, account, { ...request("aurora"), language: "lucene" })
  const first = original.items[0]
  if (!first) throw new Error("fixture needs a hit")
  const oversized = {
    ...store,
    matchQuery: async () => ({
      items: [{ ...first, score: 1, text: "a".repeat(QUERY_LIMITS.bodyBytes + 1) }],
      hasMore: false,
    }),
  }
  await expect(searchCombined(oversized, account, request("aurora"))).rejects.toMatchObject({
    details: { reason: "query_limit", budget: "body bytes" },
  })
  const expensive = {
    ...store,
    matchQuery: async () => ({ items: [{ ...first, score: 1, text: "aurora ".repeat(100000) }], hasMore: false }),
  }
  await expect(
    searchCombined(expensive, account, request(Array.from({ length: 110 }, () => "aurora").join(" "))),
  ).rejects.toMatchObject({ details: { reason: "query_limit", budget: "work" } })
  vi.spyOn(performance, "now")
    .mockReturnValueOnce(0)
    .mockReturnValue(QUERY_LIMITS.milliseconds + 1)
  await expect(searchCombined(store, account, request("aurora"))).rejects.toMatchObject({
    details: { reason: "query_limit", budget: "milliseconds" },
  })
})

it("refuses corrected AST expansion past the parser node budget", async () => {
  const store = await opened()
  await expect(
    searchCombined(store, account, request(Array.from({ length: 130 }, () => "rolluot").join(" "))),
  ).rejects.toMatchObject({ details: { reason: "query_limit", budget: "nodes" } })
})

describe("implicit term intent", () => {
  it("does not mistake filter values, quotes, escaped operator words or ranges for explicit operators", () => {
    expect([...implicitTextTerms('aurora chat:101 "AND OR" date:[2026-10-01 TO *] roll')]).toEqual([0, 48])
    expect([...implicitTextTerms("aurora from:AND roll")]).toEqual([])
    expect([...implicitTextTerms('aurora from:"AND" roll')]).toEqual([0, 18])
    expect([...implicitTextTerms("aurora text:roll")]).toEqual([0])
  })
})
