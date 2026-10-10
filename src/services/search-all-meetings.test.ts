import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { MeetingSave } from "@wirecat/cli-meetings"
import { sampleMeeting } from "@wirecat/cli-meetings/testing"
import { afterEach, describe, expect, it, vi } from "vitest"
import { type MessageStore, openStore } from "../store/store.js"
import type { SearchFound } from "./messages.js"
import { RESOURCES_SEARCHED, searchAll } from "./search-all.js"
import { type SearchAllIncludingMeetingsRequest, searchAllIncludingMeetings } from "./search-all-meetings.js"

const account = { provider: "zoom", account: "zm-profile:invented" }
const stores: MessageStore[] = []
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close()
})
const fixture = async () => {
  const folder = mkdtempSync(join(tmpdir(), "zm-test-unified-search-"))
  const path = join(folder, "wirecat.db")
  const store = await openStore({ path, env: { MESSAGING_STORE: path } })
  stores.push(store)
  await store.saveAccount({ provider: "example", account: "other-invented" }, { name: "Other invented" })
  const accountId = await store.saveAccount(account, { name: "Invented" })
  const save = async (
    externalId: string,
    text: string | string[],
    startedAt: number | null = 1000,
    extra: Partial<MeetingSave["meeting"]> = {},
  ) => {
    const sample = sampleMeeting()
    const input: MeetingSave = {
      meeting: { ...sample.meeting, accountId, externalId, startedAt, ...extra },
      transcripts: [
        {
          ...sample.transcripts[0],
          contentHash: JSON.stringify(text),
          rows: (Array.isArray(text) ? text : [text]).map((text, position) => ({
            ...sample.transcripts[0].rows[0],
            position,
            speakerParticipantPosition: null,
            text,
          })),
        },
      ],
      now: 3000,
    }
    return store.meetings.saveMeeting(input)
  }
  return { store, accountId, save }
}
const request = (extra: Partial<SearchAllIncludingMeetingsRequest> = {}): SearchAllIncludingMeetingsRequest => ({
  text: "needle",
  limit: 20,
  only: ["meetings"],
  ...extra,
})
const messageResult = (): SearchFound => ({
  items: [
    {
      id: "1",
      chatId: "7",
      senderId: "9",
      senderName: "Alice Example",
      timestamp: "2026-10-10T00:00:00Z",
      editedAt: null,
      text: "needle from messenger",
      outgoing: false,
      attachments: [],
      replyTo: null,
      forwardedFrom: null,
      reactions: null,
      chatTitle: "Invented chat",
      locator: "msg:example/other-invented/7/1",
    },
  ],
  hasMore: false,
  corrections: [],
  completeness: [],
  wordsReady: true,
  server: { backend: "both", skipped: null, calls: 1, returned: 1, new: 0, failed: [], complete: true },
})

describe("opt-in meeting-inclusive search", () => {
  it("keeps legacy results, exports and default resource behavior unchanged", async () => {
    const { store } = await fixture()
    const lookup = vi.spyOn(store, "storedAccount")
    const meetingSearch = vi.spyOn(store.meetings, "search")
    const legacy = await searchAll(store, account, { text: "needle", limit: 20, only: ["messages"] }, {}, async () =>
      messageResult(),
    )
    expect(
      await searchAllIncludingMeetings(store, account, request({ only: ["messages"] }), {}, async () =>
        messageResult(),
      ),
    ).toEqual(legacy)
    expect(RESOURCES_SEARCHED).toEqual(["messages", "mail", "notes"])
    expect(legacy.items[0]?.ref).toBe("msg:example/other-invented/7/1")
    expect(lookup).not.toHaveBeenCalled()
    expect(meetingSearch).not.toHaveBeenCalled()
  })

  it("uses the real scoped account id and preserves unknown timestamps without inventing references", async () => {
    const { store, accountId, save } = await fixture()
    await save("other-account", "needle private invented", 2000, { accountId: 1 })
    const saved = await save("selected", "needle selected", null, { title: null })
    const found = await searchAllIncludingMeetings(
      store,
      { provider: "example", account: "other-invented" },
      request({ meetingAccount: account }),
    )
    expect(found.items).toEqual([
      expect.objectContaining({
        kind: "meeting",
        accountId,
        provider: "zoom",
        account: account.account,
        meetingId: saved.meeting.id,
        scope: "transcript",
        startMs: 0,
        title: null,
        timestamp: null,
        text: "needle selected",
      }),
    ])
    expect(found.items[0]).not.toHaveProperty("ref")
    expect(found.meetings).toMatchObject({ accountId, complete: true, meetingsScanned: 1 })
    expect(found.hasMore).toBe(false)
  })

  it("reports unknown matching coverage on sparse pages and resumes into older matches", async () => {
    const { store, save } = await fixture()
    await save("old-match", "needle older", 1000)
    await save("new-no-match", "unrelated text", 2000)
    await save("newest-no-match", "unrelated text", 3000)
    const first = await searchAllIncludingMeetings(store, account, request({ limit: 1, maxMeetings: 1 }))
    expect(first.items).toEqual([])
    expect(first.hasMore).toBeNull()
    expect(first.meetings).toMatchObject({
      complete: false,
      meetingsScanned: 1,
      nextCursor: { meetingOffset: 1, hitOffset: 0 },
    })
    const rest = await searchAllIncludingMeetings(
      store,
      account,
      request({ limit: 1, meetingCursor: first.meetings?.nextCursor }),
    )
    expect(rest.items).toHaveLength(1)
    expect(rest.items[0]?.text).toBe("needle older")
    expect(rest.hasMore).toBe(false)
    expect(rest.meetings?.complete).toBe(true)
    expect(rest.meetings?.nextCursor).toBeUndefined()
  })

  it("pages hit rows within one meeting without skipping or repeating multiple matches", async () => {
    const { store, save } = await fixture()
    await save("many-matches", ["needle one", "needle two", "needle three", "needle four", "needle five"])
    const texts: string[] = []
    let cursor: SearchAllIncludingMeetingsRequest["meetingCursor"]
    for (let page = 0; page < 5; page++) {
      const found = await searchAllIncludingMeetings(
        store,
        account,
        request({ limit: 1, maxMeetings: 1, meetingCursor: cursor }),
      )
      expect(found.items).toHaveLength(1)
      texts.push(found.items[0]?.text ?? "")
      expect(found.hasMore).toBe(page !== 4)
      cursor = found.meetings?.nextCursor
    }
    expect(texts).toEqual(["needle one", "needle two", "needle three", "needle four", "needle five"])
    expect(cursor).toBeUndefined()
  })

  it("keeps the first unreturned meeting hit when legacy fusion fills the output limit", async () => {
    const { store, save } = await fixture()
    await save("meeting-match", "needle meeting")
    const legacy = vi.fn(async () => messageResult())
    const first = await searchAllIncludingMeetings(
      store,
      account,
      request({ only: ["messages", "meetings"], limit: 1 }),
      {},
      legacy,
    )
    expect(first.items[0]?.kind).toBe("message")
    expect(first.server).toEqual(messageResult().server)
    expect(first.hasMore).toBe(true)
    expect(first.meetings?.nextCursor).toMatchObject({ meetingOffset: 0, hitOffset: 0 })
    const next = await searchAllIncludingMeetings(
      store,
      account,
      request({ limit: 1, meetingCursor: first.meetings?.nextCursor }),
    )
    expect(next.items[0]?.text).toBe("needle meeting")
    expect(next.hasMore).toBe(false)
    expect(legacy).toHaveBeenCalledOnce()
  })

  it("searches current corrections and excludes deleted meetings", async () => {
    const { store, save } = await fixture()
    const saved = await save("corrected", "needle old")
    await save("corrected", "replacement text")
    await save("deleted", "needle deleted", 2000, { deletedAt: 3000 })
    const found = await searchAllIncludingMeetings(store, account, request())
    expect(found.items).toEqual([])
    expect(found.hasMore).toBe(false)
    expect((await store.meetings.meeting(saved.meeting.id))?.transcripts).toHaveLength(2)
  })

  it("supports conjunctive words and explains unsupported queries only for the meeting source", async () => {
    const { store, save } = await fixture()
    await save("conjunction", "needle planning")
    expect((await searchAllIncludingMeetings(store, account, request({ text: "needle plan" }))).items).toHaveLength(1)
    expect(
      (await searchAllIncludingMeetings(store, account, request({ text: "text:needle AND (plan)" }))).items,
    ).toHaveLength(1)
    const query = vi.spyOn(store.meetings, "search")
    for (const text of [
      '"needle plan"',
      "needle OR plan",
      "needle NOT plan",
      "needle*",
      "/needle/",
      "from:alice",
      "date:[2026-01-01 TO 2026-02-01]",
      '"unclosed',
    ]) {
      const found = await searchAllIncludingMeetings(
        store,
        account,
        request({ text, only: ["messages", "meetings"] }),
        {},
        async () => messageResult(),
      )
      expect(found.items[0]?.kind).toBe("message")
      expect(found.skipped).toEqual([expect.objectContaining({ resource: "meetings", reason: expect.any(String) })])
      expect(found.searched).toEqual(["messages"])
    }
    const exact = await searchAllIncludingMeetings(store, account, request({ exact: true }))
    expect(exact.skipped[0]?.reason).toContain("--exact")
    expect(query).not.toHaveBeenCalled()
  })

  it("binds continuation to its account and query and requires meeting-only continuation", async () => {
    const { store, save } = await fixture()
    await save("cursor", ["needle one", "needle two"])
    const first = await searchAllIncludingMeetings(store, account, request({ limit: 1 }))
    const cursor = first.meetings?.nextCursor
    expect(cursor).toBeDefined()
    if (!cursor) throw new Error("expected meeting continuation")
    for (const extra of [
      { text: "different", meetingCursor: cursor },
      { meetingCursor: { ...cursor, accountId: 1 } },
      { only: ["messages", "meetings"] as const, meetingCursor: cursor },
      { meetingCursor: { ...cursor, hitOffset: 999 } },
    ])
      await expect(searchAllIncludingMeetings(store, account, request(extra))).rejects.toMatchObject({
        code: "validation_error",
      })
  })

  it("validates limits and cursor bounds before invoking any legacy or meeting read", async () => {
    const { store } = await fixture()
    const lookup = vi.spyOn(store, "storedAccount")
    const legacy = vi.fn(async () => messageResult())
    for (const extra of [
      { limit: 0 },
      { limit: 1001 },
      { maxMeetings: 0 },
      { maxMeetings: 1.5 },
      { only: [] },
      { only: ["unknown"] as unknown as SearchAllIncludingMeetingsRequest["only"] },
      { meetingCursor: { accountId: 1, query: "needle", meetingOffset: -1, hitOffset: 0 } },
    ])
      await expect(searchAllIncludingMeetings(store, account, request(extra), {}, legacy)).rejects.toMatchObject({
        code: "validation_error",
      })
    expect(legacy).not.toHaveBeenCalled()
    expect(lookup).not.toHaveBeenCalled()
  })

  it("skips absent or mismatched-scope accounts without registration and propagates failures", async () => {
    const { store } = await fixture()
    const register = vi.spyOn(store, "saveAccount")
    for (const meetingAccount of [
      { provider: "zoom", account: "zm-profile:absent" },
      { ...account, scope: "work" as const },
    ]) {
      const found = await searchAllIncludingMeetings(store, account, request({ meetingAccount }))
      expect(found.skipped[0]?.resource).toBe("meetings")
      expect(found.hasMore).toBe(false)
    }
    expect(register).not.toHaveBeenCalled()
    const error = new Error("invented store failure")
    vi.spyOn(store, "storedAccount").mockRejectedValue(error)
    await expect(searchAllIncludingMeetings(store, account, request())).rejects.toBe(error)
  })

  it("checks cancellation before reads and after an active read settles", async () => {
    const { store, save } = await fixture()
    await save("cancel", "needle")
    const controller = new AbortController()
    const lookup = vi.spyOn(store, "storedAccount")
    controller.abort()
    await expect(
      searchAllIncludingMeetings(store, account, request({ signal: controller.signal })),
    ).rejects.toMatchObject({ code: "cancelled" })
    expect(lookup).not.toHaveBeenCalled()
    const active = new AbortController()
    const headers = vi.spyOn(store.meetings, "meetings")
    vi.spyOn(store.meetings, "search").mockImplementation(async () => {
      active.abort()
      return []
    })
    await expect(searchAllIncludingMeetings(store, account, request({ signal: active.signal }))).rejects.toMatchObject({
      code: "cancelled",
    })
    expect(headers).toHaveBeenCalledTimes(1)
  })

  it("detects changed meeting pages instead of attaching guessed metadata to hits", async () => {
    const { store, save } = await fixture()
    await save("changed", "needle")
    vi.spyOn(store.meetings, "search").mockResolvedValue([
      { meetingId: 999, scope: "transcript", id: 1, text: "needle", startMs: 0 },
    ])
    await expect(searchAllIncludingMeetings(store, account, request())).rejects.toMatchObject({
      code: "validation_error",
      message: expect.stringContaining("changed"),
    })
  })
})
