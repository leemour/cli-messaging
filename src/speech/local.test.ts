import { createHash } from "node:crypto"
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CliError } from "@wirecat/cli-core"
import { expect, it, vi } from "vitest"
import type { LocalSpeechBackend } from "./local.js"
import { localSpeechRecognitionModel, openLocalSpeechRecognizer } from "./local.js"

const defaultBackend = vi.hoisted(() => ({ opened: 0, freed: 0 }))
vi.mock("./recognize.js", async (original) => {
  const source = await original<typeof import("./recognize.js")>()
  return {
    ...source,
    openRecognizer: () => {
      defaultBackend.opened++
      return {
        recognize: () => "Alice Example default backend",
        free: () => {
          defaultBackend.freed++
        },
      }
    },
  }
})
vi.mock("./models.js", async (original) => {
  const models = await original<typeof import("./models.js")>()
  return {
    ...models,
    VAD: { ...models.VAD, bytes: 3 },
    speechModel: (id: string) =>
      id === "tiny-example"
        ? {
            id,
            title: "Invented tiny model",
            languages: "invented",
            featureDim: 64,
            files: [
              {
                name: "model.onnx",
                bytes: 7,
                sha256: createHash("sha256").update("weights").digest("hex"),
                url: "https://example.invalid/model",
              },
            ],
            config: () => ({}),
          }
        : models.speechModel(id),
  }
})
const installed = async () => {
  const root = await mkdtemp(join(tmpdir(), "messaging-test-local-speech-"))
  await mkdir(join(root, "tiny-example"))
  await writeFile(join(root, "tiny-example", "model.onnx"), "weights")
  await writeFile(join(root, "silero_vad.onnx"), "vad")
  return root
}
const backend = (text = "Alice Example recognizes a sample") => ({
  recognize: vi.fn((_pcm: Float32Array) => text),
  free: vi.fn(),
})
it("describes pinned models without filesystem, downloads or loading an engine", () => {
  const one = localSpeechRecognitionModel("parakeet-v3")
  expect(one).toMatchObject({ engine: "sherpa-onnx", model: "parakeet-v3", sampleRate: 16000, maxChunkSamples: 480000 })
  expect(one.version).toMatch(/^[a-f0-9]{64}$/)
  expect(localSpeechRecognitionModel("parakeet-v3")).toEqual(one)
  expect(localSpeechRecognitionModel("gigaam-v3").version).not.toBe(one.version)
  expect(() => localSpeechRecognitionModel("../unknown")).toThrow()
})
it("requires an explicit installed model and never asks a fetcher or engine to download one", async () => {
  const directory = await mkdtemp(join(tmpdir(), "messaging-test-missing-speech-"))
  const open = vi.fn(() => backend())
  await expect(openLocalSpeechRecognizer("tiny-example", { directory, open })).rejects.toMatchObject({
    code: "not_found",
  })
  expect(open).not.toHaveBeenCalled()
  await expect(openLocalSpeechRecognizer("tiny-example", { directory: "relative", open })).rejects.toMatchObject({
    code: "validation_error",
  })
  await expect(openLocalSpeechRecognizer("tiny-example", { directory, maxTextBytes: 0, open })).rejects.toMatchObject({
    code: "validation_error",
  })
})
it("reuses the existing recognizer with bounded, copied PCM and the existing lead-in silence", async () => {
  const directory = await installed()
  const native = backend("  Alice Example recognizes a sample  ")
  const open = vi.fn(() => native)
  const recognizer = await openLocalSpeechRecognizer("tiny-example", { directory, open })
  const samples = new Float32Array([0.25, -0.25])
  const pending = recognizer.recognize(samples)
  samples.fill(0.75)
  expect(await pending).toBe("Alice Example recognizes a sample")
  const heard = native.recognize.mock.calls[0]?.[0]
  expect(heard?.length).toBe(8002)
  expect(heard?.[8000]).toBe(0.25)
  expect(heard?.[8001]).toBe(-0.25)
  expect(open).toHaveBeenCalledWith(
    expect.objectContaining({ id: "tiny-example" }),
    expect.any(Function),
    join(directory, "silero_vad.onnx"),
  )
  await Promise.all([recognizer.close(), recognizer.close()])
  expect(native.free).toHaveBeenCalledTimes(1)
  await expect(recognizer.recognize(new Float32Array([0]))).rejects.toMatchObject({ code: "configuration_error" })
})
it("refuses concurrent windows and waits for active recognition before freeing its engine", async () => {
  const native = backend()
  const recognizer = await openLocalSpeechRecognizer("tiny-example", {
    directory: await installed(),
    open: () => native,
  })
  const pending = recognizer.recognize(new Float32Array([0]))
  await expect(recognizer.recognize(new Float32Array([0]))).rejects.toThrow("one window")
  const closed = recognizer.close()
  expect(native.free).not.toHaveBeenCalled()
  await pending
  await closed
  expect(native.free).toHaveBeenCalledTimes(1)
})
it.each([
  new Float32Array(),
  new Float32Array(480001),
  new Float32Array([Number.NaN]),
  new Float32Array([2]),
  [0] as unknown as Float32Array,
])("rejects invalid or excessive PCM before engine inference", async (samples) => {
  const native = backend()
  const recognizer = await openLocalSpeechRecognizer("tiny-example", {
    directory: await installed(),
    open: () => native,
  })
  try {
    await expect(recognizer.recognize(samples)).rejects.toMatchObject({ code: "validation_error" })
    expect(native.recognize).not.toHaveBeenCalled()
  } finally {
    await recognizer.close()
  }
})
it.each(["x".repeat(11), "é".repeat(6), "bad\0text", null])(
  "bounds model output and rejects invalid recognition results",
  async (result) => {
    const native: LocalSpeechBackend = { recognize: () => result as string, free: vi.fn() }
    const recognizer = await openLocalSpeechRecognizer("tiny-example", {
      directory: await installed(),
      maxTextBytes: 10,
      open: () => native,
    })
    try {
      await expect(recognizer.recognize(new Float32Array([0]))).rejects.toMatchObject({ code: "invalid_response" })
    } finally {
      await recognizer.close()
    }
  },
)
it("checks cancellation before opening and between synchronous windows without claiming mid-call interruption", async () => {
  const directory = await installed()
  const controller = new AbortController()
  const native = backend()
  controller.abort()
  await expect(
    openLocalSpeechRecognizer("tiny-example", { directory, signal: controller.signal, open: () => native }),
  ).rejects.toMatchObject({ code: "cancelled" })
  const scoped = new AbortController()
  const request = new AbortController()
  const model = await openLocalSpeechRecognizer("tiny-example", {
    directory,
    signal: scoped.signal,
    open: () => native,
  })
  request.abort(new CliError("timeout", "example deadline"))
  try {
    await expect(model.recognize(new Float32Array([0]), { signal: request.signal })).rejects.toMatchObject({
      code: "timeout",
    })
    expect(native.recognize).not.toHaveBeenCalled()
  } finally {
    await model.close()
  }
  const during = new AbortController()
  const active = await openLocalSpeechRecognizer("tiny-example", {
    directory,
    open: () => ({
      recognize: () => {
        during.abort()
        return "Alice Example sample"
      },
      free: native.free,
    }),
  })
  try {
    await expect(active.recognize(new Float32Array([0]), { signal: during.signal })).rejects.toMatchObject({
      code: "cancelled",
    })
  } finally {
    await active.close()
  }
})
it("a failed engine call settles before close and a closed engine is never retried automatically", async () => {
  const native = {
    recognize: vi.fn(() => {
      throw new Error("invented engine failure")
    }),
    free: vi.fn(),
  }
  const model = await openLocalSpeechRecognizer("tiny-example", { directory: await installed(), open: () => native })
  const pending = model.recognize(new Float32Array([0]))
  const closed = model.close()
  await expect(pending).rejects.toThrow("engine failure")
  await closed
  expect(native.recognize).toHaveBeenCalledTimes(1)
  expect(native.free).toHaveBeenCalledTimes(1)
})

it("uses the existing default engine seam and shared cache override without model installation", async () => {
  const root = await mkdtemp(join(tmpdir(), "messaging-test-speech-shared-cache-"))
  await mkdir(join(root, "models", "audio", "tiny-example"), { recursive: true })
  await writeFile(join(root, "models", "audio", "tiny-example", "model.onnx"), "weights")
  await writeFile(join(root, "models", "audio", "silero_vad.onnx"), "vad")
  defaultBackend.opened = 0
  defaultBackend.freed = 0
  const model = await openLocalSpeechRecognizer("tiny-example", { env: { CLI_COMMON_CACHE_DIR: root } })
  try {
    expect(await model.recognize(new Float32Array([0]))).toBe("Alice Example default backend")
  } finally {
    await model.close()
  }
  expect(defaultBackend.opened).toBe(1)
  expect(defaultBackend.freed).toBe(1)
})
it("honors cancellation during asynchronous engine preparation before opening the backend", async () => {
  const controller = new AbortController()
  const open = vi.fn(() => backend())
  const pending = openLocalSpeechRecognizer("tiny-example", {
    directory: await installed(),
    signal: controller.signal,
    open,
  })
  controller.abort(new DOMException("invented timeout", "TimeoutError"))
  await expect(pending).rejects.toMatchObject({ code: "timeout" })
  expect(open).not.toHaveBeenCalled()
})
