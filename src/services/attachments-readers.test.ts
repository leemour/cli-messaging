import { createHash } from "node:crypto"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { Messenger } from "../cli/messenger/context.js"
import type { Message } from "../domain/models.js"
import { type MessageStore, openStore } from "../store/store.js"
import { zip } from "../testing/files.js"
import { odfEntries, officeFixture } from "../testing/office-files.js"
import { attachmentsService } from "./attachments.js"
import { storedDeps } from "./deps.js"
import { searchLucene } from "./messages-search.js"

const owner = { provider: "fixture", account: "500" }
const other = { provider: "fixture", account: "600" }
const app = { command: "fixture", appName: "fixture-cli", envPrefix: "APP", description: "", version: "1.0.0" }
const messenger = { app, provider: "fixture", chatArgument: "a chat" } as Messenger
const opened: MessageStore[] = []
afterEach(async () => {
  for (const store of opened.splice(0)) await store.close()
})
const setup = async (bytes: Uint8Array, extension: string) => {
  const root = mkdtempSync(join(tmpdir(), "attachment-reader-")),
    path = join(root, `fixture.${extension}`)
  const store = await openStore({ path: join(root, "messages.db") })
  opened.push(store)
  const message: Message = {
    id: "1",
    chatId: "7",
    senderId: "10",
    senderName: "Fixture",
    timestamp: "2026-10-08T00:00:00Z",
    editedAt: null,
    text: "",
    outgoing: false,
    attachments: [{ kind: "file", name: `fixture.${extension}` }],
    replyTo: null,
    forwardedFrom: null,
    reactions: null,
  }
  for (const account of [owner, other]) {
    await store.saveChats(account, [
      { id: "7", title: "Fixture", kind: "group", unreadCount: 0, lastMessageAt: null, participantsCount: null },
    ])
    await store.saveMessages(account, "7", [message], { via: "test" })
  }
  writeFileSync(path, bytes)
  await store.keepDownloads(owner, "7", "1", [{ kind: "file", name: `fixture.${extension}`, path }])
  const file = (await store.fileAttachments(owner, { limit: 1 }))[0]
  if (!file) throw new Error("fixture attachment missing")
  const service = attachmentsService(storedDeps(messenger, store, owner, { check: vi.fn(), record: vi.fn() }))
  return { store, service, path, pk: file.pk, sha: createHash("sha256").update(bytes).digest("hex") }
}
const found = async (store: MessageStore, word: string, account = owner) =>
  (await searchLucene(store, account, { text: `content:${word}`, limit: 20 }, messenger)).items.map(
    (message) => message.id,
  )

describe("local attachment readers in the shared index", () => {
  it.each([
    ["odt", "readerneedle"],
    ["ods", "cellneedle"],
    ["xlsx", "sharedneedle"],
    ["pptx", "slideneedle"],
    ["epub", "bookneedle"],
  ] as const)("indexes %s locally, isolates accounts and reuses the successful cache", async (kind, word) => {
    const { store, service } = await setup(officeFixture(kind), kind)
    const transcribe = vi.fn(async () => {
      throw new Error("API must not receive local digital documents")
    })
    const result = await service.extract({ ocr: { extractor: "ocr:fixture", transcribe } })
    expect(result).toMatchObject({ extracted: 1, failed: 0 })
    expect(JSON.stringify(result)).not.toContain(word)
    expect(await found(store, word)).toEqual(["1"])
    expect(await found(store, word, other)).toEqual([])
    expect(await service.extract()).toMatchObject({ extracted: 0, unchanged: 1 })
    expect(transcribe).not.toHaveBeenCalled()
  })
  it("retries an old same-hash decoding failure and indexes Windows-1251 text", async () => {
    const text =
      "Договор поставки оборудования. Получатель подтверждает получение документов и согласование условий оплаты. ".repeat(
        20,
      )
    const decoder = new TextDecoder("windows-1251"),
      mapping = new Map(Array.from({ length: 256 }, (_, i) => [decoder.decode(new Uint8Array([i])), i]))
    const bytes = new Uint8Array([...text].map((character) => mapping.get(character) ?? 0))
    const { store, service, pk, sha } = await setup(bytes, "txt")
    await store.keepAttachmentText(pk, {
      text: "",
      origin: "extracted",
      extractor: "plain",
      error: "not_utf8",
      contentSha256: sha,
    })
    expect(await service.extract()).toMatchObject({ extracted: 1, unchanged: 0 })
    expect(await found(store, "договор")).toEqual(["1"])
    const row = (await store.attachments(owner, { limit: 1 }))[0]
    expect(row?.text).toMatchObject({ extractor: "plain:v2:windows-1251", error: null })
  })
  it("invalidates obsolete reader provenance even when the content hash matches", async () => {
    const { store, service, pk, sha } = await setup(officeFixture("odt"), "odt")
    await store.keepAttachmentText(pk, {
      text: "oldneedle",
      origin: "extracted",
      extractor: "document:v0:odt",
      contentSha256: sha,
    })
    expect(await service.extract()).toMatchObject({ extracted: 1, unchanged: 0 })
    expect(await found(store, "oldneedle")).toEqual([])
    expect(await found(store, "readerneedle")).toEqual(["1"])
  })
  it("preserves good indexed text when a changed file fails, including an atomic failed write", async () => {
    const { store, service, pk, path } = await setup(officeFixture("odt"), "odt")
    await service.extract()
    writeFileSync(path, zip({ ...odfEntries("odt"), "content.xml": "<broken>" }))
    expect(await service.extract()).toMatchObject({ failed: 1, extracted: 0 })
    expect(await found(store, "readerneedle")).toEqual(["1"])
    expect(
      await store.keepAttachmentText(pk, {
        text: "",
        origin: "extracted",
        extractor: "document:v1:odt",
        error: "invalid_document",
      }),
    ).toBe(false)
    expect(await found(store, "readerneedle")).toEqual(["1"])
  })
  it("protects agent text and skips it in extraction", async () => {
    const { store, service, pk } = await setup(officeFixture("odt"), "odt")
    await store.keepAttachmentText(pk, { text: "agentneedle", origin: "agent", extractor: "agent" })
    expect(await service.extract()).toMatchObject({ extracted: 0, failed: 0, items: [] })
    expect(await found(store, "agentneedle")).toEqual(["1"])
    expect(await found(store, "readerneedle")).toEqual([])
  })
})

it("uses the service environment for extraction and retained-file transfer", async () => {
  const { store } = await setup(Buffer.from(`readerneedle ${" ".repeat(1024 * 1024)}`), "txt")
  const deps = storedDeps(messenger, store, owner, { check: vi.fn(), record: vi.fn() })
  const small = attachmentsService({ ...deps, env: { MESSAGING_ATTACHMENT_MAX_MIB: "1" } })
  expect(await small.extract()).toMatchObject({ items: [{ status: "too-large" }], extracted: 0 })
  await expect(small.show({ chat: "7", message: "1" })).rejects.toThrow("exceeds 1 MiB")
  const large = attachmentsService({ ...deps, env: { MESSAGING_ATTACHMENT_MAX_MIB: "2" } })
  expect(await large.extract()).toMatchObject({ extracted: 1, failed: 0 })
  expect(await large.show({ chat: "7", message: "1", chunkBytes: 20 })).toMatchObject({ readBytes: 20 })
})
