import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PNG } from "pngjs"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { OcrPipeline } from "../attachments/ocr.js"
import type { Messenger } from "../cli/messenger/context.js"
import type { Message } from "../domain/models.js"
import { type MessageStore, openStore } from "../store/store.js"
import { attachmentsService } from "./attachments.js"
import { storedDeps } from "./deps.js"
import { searchLucene } from "./messages-search.js"

const owner = { provider: "fixture", account: "500" }
const other = { provider: "fixture", account: "600" }
const app = { appName: "fixture-cli", command: "fixture", envPrefix: "APP", description: "", version: "1.0.0" }
const messenger = { app, provider: "fixture", chatArgument: "a chat" } as Messenger
const opened: MessageStore[] = []
afterEach(async () => {
  for (const store of opened.splice(0)) await store.close()
})

const setup = async (count = 3) => {
  const root = mkdtempSync(join(tmpdir(), "attachment-ocr-")),
    files = join(root, "files")
  mkdirSync(files)
  const store = await openStore({ path: join(root, "messages.db") })
  opened.push(store)
  const png = PNG.sync.write(new PNG({ width: 2, height: 2 }))
  const messages: Message[] = Array.from({ length: count }, (_, n) => ({
    id: String(n + 1),
    chatId: "7",
    senderId: "10",
    senderName: "Fixture sender",
    timestamp: new Date(1700000000000 + n).toISOString(),
    editedAt: null,
    text: "",
    outgoing: false,
    attachments: [{ kind: "photo", name: `${n + 1}.png` }],
    replyTo: null,
    forwardedFrom: null,
    reactions: null,
  }))
  for (const account of [owner, other]) {
    await store.saveChats(account, [
      { id: "7", title: "Fixture group", kind: "group", unreadCount: 0, lastMessageAt: null, participantsCount: null },
    ])
    await store.saveMessages(account, "7", messages, { via: "history" })
  }
  for (const message of messages) {
    const path = join(files, `${message.id}.png`)
    writeFileSync(path, png)
    await store.keepDownloads(owner, "7", message.id, [{ kind: "photo", name: `${message.id}.png`, path }])
  }
  const guard = { check: vi.fn(), record: () => {} }
  const service = attachmentsService(storedDeps(messenger, store, owner, guard))
  const hits = async (word: string, account = owner) =>
    (await searchLucene(store, account, { text: `content:${word}`, limit: 20 }, messenger)).items.map(({ id }) => id)
  return { store, service, hits, guard, files }
}

describe("API OCR in the existing attachment index", () => {
  it("preserves agent text written during a request and does not claim discarded API text was indexed", async () => {
    const { service, hits } = await setup(1)
    const ocr = {
      extractor: "ocr:v1:fixture",
      transcribe: async () => {
        await service.setText({ chat: "7", message: "1", text: "agentwinner" })
        return "discardedapi"
      },
    }
    expect(await service.extract({ ocr })).toMatchObject({ extracted: 0, unchanged: 1 })
    expect(await hits("agentwinner")).toEqual(["1"])
    expect(await hits("discardedapi")).toEqual([])
  })
  it("indexes OCR in real SQLite, skips a same-target repeat, and keeps accounts separate", async () => {
    const { service, hits } = await setup()
    const transcribe = vi.fn(async () => "massinvoice 42")
    const ocr: OcrPipeline = { extractor: "ocr:v1:fixture-a", transcribe }
    expect(await service.extract({ ocr, concurrency: 2 })).toMatchObject({ extracted: 3, failed: 0, complete: true })
    expect((await hits("massinvoice")).sort()).toEqual(["1", "2", "3"])
    expect(await hits("massinvoice", other)).toEqual([])
    expect(await service.extract({ ocr, concurrency: 2 })).toMatchObject({ extracted: 0, unchanged: 3 })
    expect(transcribe).toHaveBeenCalledTimes(3)
  })

  it("bounds concurrent requests and file limits, then resumes in stable attachment order", async () => {
    const { service } = await setup(5)
    let active = 0,
      maximum = 0
    const transcribe = vi.fn(async () => {
      active += 1
      maximum = Math.max(maximum, active)
      await new Promise((resolve) => setTimeout(resolve, 10))
      active -= 1
      return "bulkfixture"
    })
    const ocr = { extractor: "ocr:v1:fixture", transcribe }
    const first = await service.extract({ ocr, concurrency: 2, limit: 3 })
    expect(first).toMatchObject({ extracted: 3, complete: false, cursor: expect.any(String) })
    expect(first.items.map(({ locator }) => locator)).toEqual([
      "msg:fixture/500/7/5",
      "msg:fixture/500/7/4",
      "msg:fixture/500/7/3",
    ])
    const last = await service.extract({ ocr, concurrency: 2, limit: 3, cursor: first.cursor })
    expect(last).toMatchObject({ extracted: 2, complete: true })
    expect(maximum).toBe(2)
    expect(active).toBe(0)
    expect(transcribe).toHaveBeenCalledTimes(5)
  })

  it("does not invoke API without selection and exposes the exact agent file handoff", async () => {
    const { service, files } = await setup(1)
    expect(await service.extract()).toMatchObject({
      needsAgent: 1,
      items: [{ localPath: join(files, "1.png"), locator: "msg:fixture/500/7/1", attachment: 1 }],
    })
    await service.setText({ chat: "7", message: "1", text: "agentliteral" })
    const transcribe = vi.fn(async () => "must not replace agent")
    expect(await service.extract({ ocr: { extractor: "ocr:v1:fixture", transcribe } })).toMatchObject({ extracted: 0 })
    expect(transcribe).not.toHaveBeenCalled()
  })

  it("invalidates hash/target identity but preserves indexed text when the replacement fails", async () => {
    const { service, hits, files } = await setup(1)
    const first = { extractor: "ocr:v1:first", transcribe: vi.fn(async () => "oldinvoice") }
    await service.extract({ ocr: first })
    const failed = {
      extractor: "ocr:v1:second",
      transcribe: async () => {
        throw new Error("private provider payload")
      },
    }
    expect(await service.extract({ ocr: failed })).toMatchObject({ failed: 1, extracted: 0 })
    expect(await hits("oldinvoice")).toEqual(["1"])
    const next = { extractor: "ocr:v1:second", transcribe: vi.fn(async () => "newinvoice") }
    await service.extract({ ocr: next })
    expect(await hits("newinvoice")).toEqual(["1"])
    expect(await hits("oldinvoice")).toEqual([])
    const changed = new PNG({ width: 2, height: 2 })
    changed.data.fill(255)
    writeFileSync(join(files, "1.png"), PNG.sync.write(changed))
    await service.extract({ ocr: next })
    expect(next.transcribe).toHaveBeenCalledTimes(2)
  })

  it("refuses permissions before any model request and never indexes a late aborted answer", async () => {
    const { service, guard, hits } = await setup(1)
    const transcribe = vi.fn(async () => "lateinvoice")
    guard.check.mockImplementationOnce(() => {
      throw new Error("denied")
    })
    await expect(service.extract({ ocr: { extractor: "ocr:v1:fixture", transcribe } })).rejects.toThrow("denied")
    expect(transcribe).not.toHaveBeenCalled()
    const controller = new AbortController()
    const ocr = {
      extractor: "ocr:v1:fixture",
      transcribe: async () => {
        controller.abort()
        return "lateinvoice"
      },
    }
    expect(await service.extract({ ocr, signal: controller.signal })).toMatchObject({
      complete: false,
      batch: { stopReason: "cancelled", failures: [{ error: { code: "cancelled" } }] },
    })
    expect(await hits("lateinvoice")).toEqual([])
  })
})
