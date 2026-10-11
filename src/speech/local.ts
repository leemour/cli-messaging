import { createHash } from "node:crypto"
import { isAbsolute } from "node:path"
import { CliError } from "@wirecat/cli-core"
import { isInstalled, modelPath, modelsDirectory, vadPath } from "./install.js"
import { type SpeechModel, speechModel, VAD } from "./models.js"

export interface LocalSpeechRecognitionModel {
  engine: "sherpa-onnx"
  model: string
  version: string
  sampleRate: 16000
  maxChunkSamples: 480000
}
export interface LocalSpeechBackend {
  recognize(pcm: Float32Array): string
  free(): void
}
export interface LocalSpeechRecognizer extends LocalSpeechRecognitionModel {
  recognize(pcm: Float32Array, options?: { signal?: AbortSignal }): Promise<string>
  close(): Promise<void>
}
export interface LocalSpeechRecognizerOptions {
  directory?: string
  env?: NodeJS.ProcessEnv
  signal?: AbortSignal
  maxTextBytes?: number
  open?: (model: SpeechModel, path: (name: string) => string, vad: string) => LocalSpeechBackend
}
const cancelled = (signal?: AbortSignal) => {
  if (!signal?.aborted) return
  if (signal.reason instanceof CliError) throw signal.reason
  const timeout = signal.reason instanceof Error && signal.reason.name === "TimeoutError"
  throw new CliError(timeout ? "timeout" : "cancelled", "local speech recognition was interrupted")
}
/** A pinned registry descriptor; no model files, credentials or network are accessed. */
export const localSpeechRecognitionModel = (id: string): Readonly<LocalSpeechRecognitionModel> => {
  const model = speechModel(id)
  const version = createHash("sha256")
    .update(
      JSON.stringify({
        format: "pcm-window-v1",
        files: model.files.map((file) => [file.name, file.sha256]),
        vad: VAD.sha256,
        featureDim: model.featureDim,
      }),
    )
    .digest("hex")
  return Object.freeze({ engine: "sherpa-onnx", model: model.id, version, sampleRate: 16000, maxChunkSamples: 480000 })
}
/** Existing installed models only. Synchronous inference cancels between bounded windows. */
export const openLocalSpeechRecognizer = async (
  id: string,
  input: LocalSpeechRecognizerOptions = {},
): Promise<LocalSpeechRecognizer> => {
  const options = { ...input }
  const description = localSpeechRecognitionModel(id)
  const model = speechModel(description.model)
  const directory = options.directory ?? modelsDirectory(options.env)
  const maxTextBytes = options.maxTextBytes ?? 65536
  if (
    typeof directory !== "string" ||
    !isAbsolute(directory) ||
    /[\0\r\n]/.test(directory) ||
    !Number.isSafeInteger(maxTextBytes) ||
    maxTextBytes < 1 ||
    maxTextBytes > 4 * 1024 ** 2
  )
    throw new CliError("validation_error", "local speech requires an absolute model directory and bounded output bytes")
  cancelled(options.signal)
  if (!isInstalled(model, directory))
    throw new CliError(
      "not_found",
      `speech model ${description.model} is not installed; download it explicitly with a WireCat messenger's models audio download command`,
    )
  const { openRecognizer, toModelRate } = await import("./recognize.js")
  cancelled(options.signal)
  const engine = (options.open ?? openRecognizer)(model, modelPath(directory, model), vadPath(directory))
  let closing = false
  let active: Promise<string> | undefined
  let closed: Promise<void> | undefined
  return {
    ...description,
    async recognize(pcm, request = {}) {
      if (closing) throw new CliError("configuration_error", "local speech recognizer is closed")
      if (active) throw new CliError("configuration_error", "local speech recognizer accepts one window at a time")
      const signal =
        options.signal && request.signal
          ? AbortSignal.any([options.signal, request.signal])
          : (options.signal ?? request.signal)
      cancelled(signal)
      if (!(pcm instanceof Float32Array) || pcm.length < 1 || pcm.length > description.maxChunkSamples)
        throw new CliError("validation_error", "speech recognition requires at most 30 seconds of mono 16 kHz PCM")
      const samples = new Float32Array(pcm)
      if (samples.some((value) => !Number.isFinite(value) || Math.abs(value) > 1))
        throw new CliError("validation_error", "speech PCM samples must be finite and normalized")
      active = Promise.resolve().then(() => {
        cancelled(signal)
        const text = engine.recognize(toModelRate(samples, description.sampleRate))
        cancelled(signal)
        if (
          typeof text !== "string" ||
          text.includes("\0") ||
          text.length > maxTextBytes ||
          new TextEncoder().encode(text).byteLength > maxTextBytes
        )
          throw new CliError("invalid_response", "local speech output exceeds its text budget or is invalid")
        return text.trim()
      })
      try {
        return await active
      } finally {
        active = undefined
      }
    },
    close() {
      closing = true
      closed ??= (async () => {
        await active?.catch(() => undefined)
        engine.free()
      })()
      return closed
    },
  }
}
