import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import * as engineModule from "../embeddings/embed.js"
import { textModel } from "../embeddings/models.js"
import { createMeetingRemoteModel, meetingEmbeddingModel, openMeetingEmbedder } from "./meeting-model.js"

afterEach(() => vi.restoreAllMocks())
const remote = () => ({
  remote: createMeetingRemoteModel({ model: "synthetic", baseUrl: "https://example.invalid/v1", dims: 3 }),
})
const answer = (data: unknown = [{ index: 0, embedding: [1, 0, 0] }]) => new Response(JSON.stringify({ data }))
describe("explicit meeting embedding model", () => {
  it("describes local and remote choices without touching providers or model files", () => {
    expect(meetingEmbeddingModel("e5-small")).toEqual({
      key: "local:e5-small:384",
      dims: 384,
      kind: "local",
      model: "e5-small",
    })
    expect(meetingEmbeddingModel(remote())).toEqual({
      key: "url:example.invalid:synthetic:3",
      dims: 3,
      kind: "remote",
      model: "synthetic",
    })
  })
  it.each([
    "file:///tmp/model",
    "https://user:secret@example.invalid/v1",
    "https://example.invalid/v1?key=secret",
    "https://example.invalid/v1#secret",
  ])("refuses unsafe endpoints %s", (baseUrl) => {
    expect(() => createMeetingRemoteModel({ model: "synthetic", baseUrl, dims: 3 })).toThrow()
  })
  it("requires an explicit choice, bounded dimensions and safe model identifiers", () => {
    expect(() => meetingEmbeddingModel(undefined as never)).toThrow()
    expect(() =>
      createMeetingRemoteModel({ model: "synthetic", baseUrl: "https://example.invalid", dims: 8193 }),
    ).toThrow()
    expect(() =>
      createMeetingRemoteModel({ model: "secret\nvalue", baseUrl: "https://example.invalid", dims: 3 }),
    ).toThrow()
  })
  it("refuses absent local model files without downloading", async () => {
    const fetch = vi.fn(() => Promise.reject(new Error("No network")))
    await expect(
      openMeetingEmbedder("e5-small", { directory: mkdtempSync(join(tmpdir(), "zm-test-meeting-model-")), fetch }),
    ).rejects.toMatchObject({ code: "configuration_error" })
    expect(fetch).not.toHaveBeenCalled()
  })
  it("reuses the remote engine with one request, manual redirects and no implicit key lookup", async () => {
    const fetch = vi.fn(async (_url: string, _init: RequestInit) => answer())
    const model = await openMeetingEmbedder(remote(), { fetch, env: {} })
    expect(await model.embed(["Alice Example agrees"], "query")).toEqual([new Float32Array([1, 0, 0])])
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({ redirect: "manual", method: "POST" })
    expect(fetch.mock.calls[0]?.[1].headers).not.toHaveProperty("authorization")
    await model.close()
    await expect(model.embed(["test"], "query")).rejects.toMatchObject({ code: "configuration_error" })
  })
  it("refuses OpenAI without an explicitly supplied key and never reveals a provider error body", async () => {
    await expect(openMeetingEmbedder({ remote: createMeetingRemoteModel({}) }, { env: {} })).rejects.toMatchObject({
      code: "authentication_error",
    })
    const fetch = vi.fn(async () => new Response("owner key or transcript in body", { status: 401 }))
    const model = await openMeetingEmbedder(remote(), { fetch })
    await expect(model.embed(["synthetic"], "passage")).rejects.toMatchObject({ code: "authentication_error" })
    expect(fetch).toHaveBeenCalledTimes(1)
    await model.close()
  })
  it.each([302, 429, 503])("never redirects or retries HTTP %i", async (status) => {
    const fetch = vi.fn(async () => new Response("secret", { status }))
    const model = await openMeetingEmbedder(remote(), { fetch })
    await expect(model.embed(["synthetic"], "passage")).rejects.toMatchObject({
      code: status === 302 ? "invalid_response" : status === 429 ? "rate_limited" : "provider_error",
    })
    expect(fetch).toHaveBeenCalledTimes(1)
    await model.close()
  })
  it("rejects input and vector payload budgets before fetching", async () => {
    const fetch = vi.fn(async () => answer())
    const model = await openMeetingEmbedder(remote(), { fetch, maxInputBytes: 8 })
    await expect(model.embed(["Alice Example"], "passage")).rejects.toMatchObject({ code: "validation_error" })
    expect(fetch).not.toHaveBeenCalled()
    await model.close()
  })
  it("streams only bounded response bytes and cancels its reader", async () => {
    const cancel = vi.fn()
    const fetch = vi.fn(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(100))
            },
            cancel,
          }),
        ),
    )
    const model = await openMeetingEmbedder(remote(), { fetch, maxResponseBytes: 32 })
    await expect(model.embed(["x"], "query")).rejects.toMatchObject({ code: "invalid_response" })
    expect(cancel).toHaveBeenCalledTimes(1)
    await model.close()
  })
  it.each([
    [{ index: 0, embedding: [1e300, 0, 0] }],
    [{ index: 0, embedding: ["1", 0, 0] }],
    [{ index: 1, embedding: [1, 0, 0] }],
    [{ index: 0, embedding: [1, 0] }],
  ])("rejects invalid provider vector data %#", async (data) => {
    const model = await openMeetingEmbedder(remote(), { fetch: async () => answer(data) })
    await expect(model.embed(["x"], "query")).rejects.toMatchObject({ code: "invalid_response" })
    await model.close()
  })
  it("cancels a blocked response reader without waiting for provider completion", async () => {
    const controller = new AbortController()
    const cancelled = vi.fn()
    let ready: () => void = () => {}
    const started = new Promise<void>((resolve) => {
      ready = resolve
    })
    const model = await openMeetingEmbedder(remote(), {
      signal: controller.signal,
      fetch: async () => {
        ready()
        return new Response(new ReadableStream({ cancel: cancelled }))
      },
    })
    const pending = model.embed(["x"], "query")
    await started
    await Promise.resolve()
    controller.abort()
    await expect(pending).rejects.toMatchObject({ code: "cancelled" })
    await model.close()
  })
})

it("waits for active local inference before closing its engine exactly once", async () => {
  const order: string[] = []
  let finish: (value: Float32Array[]) => void = () => {}
  const inference = new Promise<Float32Array[]>((resolve) => {
    finish = resolve
  })
  const close = vi.fn(async () => {
    order.push("close")
  })
  vi.spyOn(engineModule, "isTextModelInstalled").mockReturnValue(true)
  vi.spyOn(engineModule, "openEmbedder").mockResolvedValue({
    model: textModel("e5-small"),
    embed: async () => {
      order.push("inference")
      return inference
    },
    close,
  })
  const model = await openMeetingEmbedder("e5-small", {
    directory: mkdtempSync(join(tmpdir(), "zm-test-model-close-")),
  })
  const embedding = model.embed(["Alice Example"], "query")
  const firstClose = model.close()
  const secondClose = model.close()
  await Promise.resolve()
  expect(close).not.toHaveBeenCalled()
  expect(order).toEqual(["inference"])
  finish([new Float32Array(Array.from({ length: 384 }, (_, index) => (index === 0 ? 1 : 0)))])
  await embedding
  await Promise.all([firstClose, secondClose])
  expect(order).toEqual(["inference", "close"])
  expect(close).toHaveBeenCalledTimes(1)
})

it("rejects zero vectors before semantic scoring", async () => {
  const model = await openMeetingEmbedder(remote(), { fetch: async () => answer([{ index: 0, embedding: [0, 0, 0] }]) })
  await expect(model.embed(["Alice Example"], "query")).rejects.toMatchObject({ code: "invalid_response" })
  await model.close()
})

it("keeps a cancelled local inference alive until it settles before cleanup", async () => {
  let finish: (value: Float32Array[]) => void = () => {}
  const inference = new Promise<Float32Array[]>((resolve) => {
    finish = resolve
  })
  const close = vi.fn(async () => {})
  const controller = new AbortController()
  vi.spyOn(engineModule, "isTextModelInstalled").mockReturnValue(true)
  vi.spyOn(engineModule, "openEmbedder").mockResolvedValue({
    model: textModel("e5-small"),
    embed: async () => inference,
    close,
  })
  const model = await openMeetingEmbedder("e5-small", {
    directory: mkdtempSync(join(tmpdir(), "zm-test-model-abort-close-")),
    signal: controller.signal,
  })
  const embedding = model.embed(["Alice Example"], "query")
  const rejected = expect(embedding).rejects.toMatchObject({ code: "cancelled" })
  controller.abort()
  const cleanup = model.close()
  await Promise.resolve()
  expect(close).not.toHaveBeenCalled()
  finish([new Float32Array(Array.from({ length: 384 }, (_, index) => (index === 0 ? 1 : 0)))])
  await rejected
  await cleanup
  expect(close).toHaveBeenCalledTimes(1)
})
