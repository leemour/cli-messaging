import { CliError } from "@wirecat/cli-core"
import {
  type Embedder,
  isTextModelInstalled,
  type Kind,
  openEmbedder,
  textModelsDirectory,
} from "../embeddings/embed.js"
import { textModel } from "../embeddings/models.js"
import { type Fetch, OPENAI_URL, openRemote, type RemoteModel, remoteKey, remoteModel } from "../embeddings/remote.js"
import { type ModelChoice, vectorModelKey } from "./embeddings.js"

export interface MeetingEmbeddingModel {
  key: string
  dims: number
  kind: "local" | "remote"
  model: string
}
export interface MeetingEmbedder extends MeetingEmbeddingModel {
  embed(texts: string[], kind: Kind): Promise<Float32Array[]>
  close(): Promise<void>
}
export interface MeetingEmbedderOptions {
  env?: NodeJS.ProcessEnv
  directory?: string
  threads?: number
  signal?: AbortSignal
  fetch?: Fetch
  maxInputBytes?: number
  maxResponseBytes?: number
}
const integer = (value: number, name: string, max: number): number => {
  if (!Number.isSafeInteger(value) || value < 1 || value > max)
    throw new CliError("validation_error", `Invalid ${name}`)
  return value
}
const cancelled = (signal?: AbortSignal): void => {
  if (signal?.aborted) throw new CliError("cancelled", "Meeting embedding was cancelled")
}
const validatedRemote = (remote: RemoteModel): RemoteModel => {
  let url: URL
  try {
    url = new URL(remote.baseUrl)
  } catch {
    throw new CliError("validation_error", "Invalid embedding endpoint")
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash)
    throw new CliError("validation_error", "Embedding endpoint requires HTTP/S without credentials, query or fragment")
  if (typeof remote.model !== "string" || !/^[\w./:-]{1,200}$/.test(remote.model))
    throw new CliError("validation_error", "Invalid embedding model name")
  const dims = integer(remote.dims, "embedding dimensions", 8192)
  const baseUrl = remote.baseUrl.replace(/\/+$/, "")
  const result = remoteModel({ model: remote.model, dims, ...(baseUrl === OPENAI_URL ? {} : { baseUrl }) })
  return result
}
/** Validates a descriptor without reading keys or model files or opening a model. */
export const meetingEmbeddingModel = (choice: ModelChoice): MeetingEmbeddingModel => {
  if (typeof choice === "string") {
    const model = textModel(choice)
    return { key: vectorModelKey(model), dims: model.dims, kind: "local", model: model.id }
  }
  if (!choice || typeof choice !== "object" || !choice.remote)
    throw new CliError("validation_error", "An explicit embedding model is required")
  const remote = validatedRemote(choice.remote)
  if (choice.concurrency !== undefined && choice.concurrency !== 1)
    throw new CliError("validation_error", "Meeting embedding supports one remote request worker")
  return { key: remoteKey(remote), dims: remote.dims, kind: "remote", model: remote.model }
}
export const createMeetingRemoteModel = (input: Parameters<typeof remoteModel>[0]): RemoteModel => {
  try {
    return validatedRemote(remoteModel(input))
  } catch (error) {
    if (error instanceof CliError) throw error
    throw new CliError("validation_error", "Invalid embedding endpoint")
  }
}
const withAbort = async <T>(pending: Promise<T>, signal?: AbortSignal): Promise<T> => {
  cancelled(signal)
  if (!signal) return pending
  let onAbort: () => void = () => {}
  const interrupted = new Promise<never>((_, reject) => {
    onAbort = () => reject(new CliError("cancelled", "Meeting embedding was cancelled"))
    signal.addEventListener("abort", onAbort, { once: true })
  })
  try {
    return await Promise.race([pending, interrupted])
  } finally {
    signal.removeEventListener("abort", onAbort)
  }
}
const boundedResponse = async (response: Response, maxBytes: number, signal?: AbortSignal): Promise<unknown> => {
  const length = response.headers.get("content-length")
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > maxBytes)) {
    void response.body?.cancel().catch(() => {})
    throw new CliError("invalid_response", "Embedding response exceeds the byte budget")
  }
  if (!response.body) throw new CliError("invalid_response", "Embedding response has no body")
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let bytes = 0
  try {
    for (;;) {
      cancelled(signal)
      const part = await withAbort(reader.read(), signal)
      cancelled(signal)
      if (part.done) break
      bytes += part.value.byteLength
      if (bytes > maxBytes) throw new CliError("invalid_response", "Embedding response exceeds the byte budget")
      chunks.push(part.value)
    }
    const body = Buffer.concat(chunks, bytes).toString("utf8")
    try {
      return JSON.parse(body)
    } catch {
      throw new CliError("invalid_response", "Embedding response is not JSON")
    }
  } finally {
    void reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}
/** Explicit opening only; installed local models and the existing remote engine are reused. */
export const openMeetingEmbedder = async (
  choice: ModelChoice,
  options: MeetingEmbedderOptions = {},
): Promise<MeetingEmbedder> => {
  const descriptor = meetingEmbeddingModel(choice)
  const { signal } = options
  cancelled(signal)
  const maxInputBytes = integer(options.maxInputBytes ?? 1024 * 1024, "input byte budget", 16 * 1024 * 1024)
  const maxResponseBytes = integer(
    options.maxResponseBytes ?? 8 * 1024 * 1024,
    "response byte budget",
    64 * 1024 * 1024,
  )
  if (options.threads !== undefined) integer(options.threads, "embedding threads", 128)
  let engine: Embedder
  let remoteFailure: unknown
  if (typeof choice === "string") {
    const model = textModel(choice)
    const directory = options.directory ?? textModelsDirectory(options.env)
    if (!isTextModelInstalled(model, directory))
      throw new CliError("configuration_error", "The explicit local embedding model is not installed")
    engine = await openEmbedder(model, directory, {
      ...(options.threads === undefined ? {} : { threads: options.threads }),
    })
  } else {
    const remote = validatedRemote(choice.remote)
    const key =
      choice.apiKey ?? (remote.provider === "openai" ? (options.env ?? process.env).OPENAI_API_KEY : undefined)
    if (remote.provider === "openai" && !key)
      throw new CliError("authentication_error", "The explicit remote embedding model requires an API key")
    const post = options.fetch ?? fetch
    const guarded: Fetch = async (url, init) => {
      try {
        cancelled(signal)
        const responseTask = post(url, { ...init, redirect: "manual", ...(signal ? { signal } : {}) }).then(
          (response) => {
            if (signal?.aborted) {
              void response.body?.cancel().catch(() => {})
              cancelled(signal)
            }
            return response
          },
        )
        const response = await withAbort(responseTask, signal)
        if (signal?.aborted) {
          void response.body?.cancel().catch(() => {})
          cancelled(signal)
        }
        if (response.status >= 300 && response.status < 400) {
          void response.body?.cancel().catch(() => {})
          throw new CliError("invalid_response", "Embedding redirects are refused")
        }
        if (!response.ok) {
          void response.body?.cancel().catch(() => {})
          return new Response("{}", { status: response.status })
        }
        const body = await boundedResponse(response, maxResponseBytes, signal)
        if (
          !body ||
          typeof body !== "object" ||
          !("data" in body) ||
          !Array.isArray(body.data) ||
          body.data.length > 256
        )
          throw new CliError("invalid_response", "Embedding response lacks vector data")
        for (const entry of body.data) {
          if (
            !entry ||
            typeof entry !== "object" ||
            !Number.isSafeInteger(entry.index) ||
            entry.index < 0 ||
            !Array.isArray(entry.embedding) ||
            entry.embedding.length !== remote.dims ||
            entry.embedding.some(
              (value: unknown) =>
                typeof value !== "number" || !Number.isFinite(value) || !Number.isFinite(Math.fround(value)),
            )
          )
            throw new CliError("invalid_response", "Embedding response contains invalid vectors")
        }
        const indices = body.data.map((entry) => entry.index).sort((a, b) => a - b)
        if (indices.some((index, position) => index !== position))
          throw new CliError("invalid_response", "Embedding response contains invalid vector indices")
        return new Response(
          JSON.stringify({ data: body.data.map((entry) => ({ index: entry.index, embedding: entry.embedding })) }),
          { status: response.status },
        )
      } catch (error) {
        remoteFailure = error
        throw error
      }
    }
    engine = openRemote(remote, key, { concurrency: 1, fetch: guarded, tries: 1 })
  }
  if (signal?.aborted) {
    await engine.close()
    cancelled(signal)
  }
  let closed = false
  let running = false
  let active: Promise<void> | null = null
  let closing: Promise<void> | null = null
  return {
    ...descriptor,
    async embed(texts, kind) {
      cancelled(signal)
      if (closed) throw new CliError("configuration_error", "Meeting embedder is closed")
      if (
        !Array.isArray(texts) ||
        texts.length > 1000 ||
        texts.some((text) => typeof text !== "string") ||
        !["query", "passage"].includes(kind)
      )
        throw new CliError("validation_error", "Invalid meeting embedding inputs")
      if (
        Buffer.byteLength(JSON.stringify(texts), "utf8") > maxInputBytes ||
        texts.length * descriptor.dims * 4 > maxResponseBytes
      )
        throw new CliError("validation_error", "Meeting embedding input or vector payload exceeds its byte budget")
      if (running) throw new CliError("validation_error", "A meeting embedding request is already running")
      running = true
      let settled: () => void = () => {}
      active = new Promise<void>((resolve) => {
        settled = resolve
      })
      remoteFailure = undefined
      try {
        const vectors = await engine.embed([...texts], kind)
        cancelled(signal)
        if (
          vectors.length !== texts.length ||
          vectors.some(
            (vector) =>
              vector.length !== descriptor.dims ||
              !vector.some((value) => value !== 0) ||
              [...vector].some((value) => !Number.isFinite(value)),
          )
        )
          throw new CliError("invalid_response", "Meeting embedder returned invalid vectors")
        return vectors
      } catch (error) {
        cancelled(signal)
        if (remoteFailure instanceof CliError) throw remoteFailure
        if (error instanceof CliError) throw error
        throw new CliError("provider_error", "Meeting embedding failed")
      } finally {
        running = false
        settled()
        active = null
      }
    },
    async close() {
      if (!closing) {
        closed = true
        closing = (async () => {
          await active
          await engine.close()
        })()
      }
      await closing
    },
  }
}
