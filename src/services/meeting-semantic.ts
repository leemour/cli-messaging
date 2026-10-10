import { CliError } from "@wirecat/cli-core"
import { formatMeetingReference } from "../domain/meeting-reference.js"
import type { MeetingVectors } from "../store/sqlite/meeting-vectors.js"
import type { MeetingEmbedder, MeetingEmbeddingModel } from "./meeting-model.js"

export interface MeetingSemanticOptions {
  limit?: number
  maxChunks?: number
  afterChunkId?: number
  maxRows?: number
  maxTextBytes?: number
  signal?: AbortSignal
}
export interface MeetingEmbeddingApplyOptions {
  maxChunks?: number
  afterHash?: string
  maxRows?: number
  maxTextBytes?: number
  maxVectorBytes?: number
  signal?: AbortSignal
}
const positive = (value: number, name: string, max: number): number => {
  if (!Number.isSafeInteger(value) || value < 1 || value > max)
    throw new CliError("validation_error", `Invalid ${name}`)
  return value
}
const cancel = (signal?: AbortSignal): void => {
  if (signal?.aborted) throw new CliError("cancelled", "Meeting semantic operation was cancelled")
}
const account = (accountId: number): number =>
  positive(accountId, "authorized meeting account", Number.MAX_SAFE_INTEGER)
const descriptor = (model: MeetingEmbeddingModel): MeetingEmbeddingModel => {
  if (
    !model ||
    typeof model.key !== "string" ||
    !model.key.trim() ||
    model.key.length > 1000 ||
    typeof model.model !== "string" ||
    !model.model.trim() ||
    !["local", "remote"].includes(model.kind)
  )
    throw new CliError("validation_error", "An explicit meeting embedding model is required")
  return { key: model.key, model: model.model, kind: model.kind, dims: positive(model.dims, "model dimensions", 8192) }
}
const textBudget = (options: { maxRows?: number; maxTextBytes?: number }) => ({
  maxRows: positive(options.maxRows ?? 10000, "transcript row budget", 100000),
  maxTextBytes: positive(options.maxTextBytes ?? 4 * 1024 * 1024, "transcript text byte budget", 64 * 1024 * 1024),
})
const validateVector = (vector: Float32Array | undefined, dims: number): Float32Array => {
  if (
    !(vector instanceof Float32Array) ||
    vector.length !== dims ||
    !vector.some((value) => value !== 0) ||
    vector.some((value) => !Number.isFinite(value))
  )
    throw new CliError("invalid_response", "Meeting model returned an invalid vector")
  return vector
}
/** Embeds only this explicit query; never rebuilds chunks or generates stored vectors. */
export const readMeetingSemantic = async (
  store: Pick<MeetingVectors, "nearest">,
  accountId: number,
  query: string,
  embedder: MeetingEmbedder,
  options: MeetingSemanticOptions = {},
) => {
  const accountIdSnapshot = account(accountId)
  const model = descriptor(embedder)
  if (typeof query !== "string" || !query.trim() || Buffer.byteLength(query, "utf8") > 64 * 1024)
    throw new CliError("validation_error", "Meeting semantic query requires 1–65536 UTF-8 bytes")
  const limit = positive(options.limit ?? 20, "semantic result limit", 1000)
  const maxChunks = positive(options.maxChunks ?? 1000, "semantic candidate budget", 100000)
  const afterChunkId =
    options.afterChunkId === undefined
      ? undefined
      : positive(options.afterChunkId, "semantic candidate cursor", Number.MAX_SAFE_INTEGER)
  const budget = textBudget(options)
  const signal = options.signal
  cancel(signal)
  const vectors = await embedder.embed([query], "query")
  cancel(signal)
  if (vectors.length !== 1) throw new CliError("invalid_response", "Meeting query model returned another vector count")
  const vector = validateVector(vectors[0], model.dims)
  const result = await store.nearest(model.key, vector, {
    accountId: accountIdSnapshot,
    limit,
    maxChunks,
    ...budget,
    ...(afterChunkId === undefined ? {} : { afterChunkId }),
    ...(signal ? { signal } : {}),
  })
  cancel(signal)
  const items = result.items.map((hit) => {
    positive(hit.meetingId, "semantic meeting ID", Number.MAX_SAFE_INTEGER)
    positive(hit.transcriptId, "semantic transcript ID", Number.MAX_SAFE_INTEGER)
    if (
      !Number.isSafeInteger(hit.firstPosition) ||
      hit.firstPosition < 0 ||
      !Number.isSafeInteger(hit.lastPosition) ||
      hit.lastPosition < hit.firstPosition ||
      !Number.isFinite(hit.score)
    )
      throw new CliError("invalid_response", "Meeting semantic hit contains invalid provenance")
    const ref = {
      type: "meeting" as const,
      accountId: accountIdSnapshot,
      meetingId: hit.meetingId,
      transcriptId: hit.transcriptId,
    }
    return {
      ...hit,
      reference: formatMeetingReference(ref),
      firstCueReference: formatMeetingReference({ ...ref, cuePosition: hit.firstPosition }),
      lastCueReference: formatMeetingReference({ ...ref, cuePosition: hit.lastPosition }),
    }
  })
  return { accountId: accountIdSnapshot, model, ...result, items }
}
/** Counts existing current chunks without opening a model or writing to the store. */
export const proposeMeetingEmbedding = async (
  store: Pick<MeetingVectors, "status">,
  accountId: number,
  selected: MeetingEmbeddingModel,
  options: { signal?: AbortSignal } = {},
) => {
  const accountIdSnapshot = account(accountId)
  const model = descriptor(selected)
  const signal = options.signal
  cancel(signal)
  const status = await store.status({ accountId: accountIdSnapshot, model: model.key, ...(signal ? { signal } : {}) })
  cancel(signal)
  return {
    accountId: accountIdSnapshot,
    model,
    status,
    applied: false as const,
    scope: "existing-current-chunks" as const,
    rebuildRequired: "explicit" as const,
  }
}
/** Explicit bounded generation; the store revalidates current ownership after model inference. */
export const applyMeetingEmbedding = async (
  store: Pick<MeetingVectors, "chunksToEmbed" | "saveCurrent">,
  accountId: number,
  embedder: MeetingEmbedder,
  options: MeetingEmbeddingApplyOptions = {},
) => {
  const accountIdSnapshot = account(accountId)
  const model = descriptor(embedder)
  const maxChunks = positive(options.maxChunks ?? 100, "embedding chunk budget", 1000)
  const budget = textBudget(options)
  const maxVectorBytes = positive(
    options.maxVectorBytes ?? 8 * 1024 * 1024,
    "vector payload byte budget",
    64 * 1024 * 1024,
  )
  const afterHash = options.afterHash
  if (afterHash !== undefined && !/^[0-9a-f]{64}$/.test(afterHash))
    throw new CliError("validation_error", "Invalid embedding chunk cursor")
  const signal = options.signal
  cancel(signal)
  const page = await store.chunksToEmbed(model.key, {
    accountId: accountIdSnapshot,
    limit: maxChunks,
    ...budget,
    ...(afterHash === undefined ? {} : { afterHash }),
    ...(signal ? { signal } : {}),
  })
  cancel(signal)
  if (page.items.length > maxChunks || page.items.length * model.dims * 4 > maxVectorBytes)
    throw new CliError("validation_error", "Embedding batch exceeds its chunk or vector payload budget")
  const items = page.items.map(({ hash, text }) => ({ hash, text }))
  if (
    items.some(({ hash, text }) => !/^[0-9a-f]{64}$/.test(hash) || typeof text !== "string") ||
    new Set(items.map(({ hash }) => hash)).size !== items.length
  )
    throw new CliError("invalid_response", "Meeting chunk page is invalid")
  if (items.reduce((bytes, item) => bytes + Buffer.byteLength(item.text, "utf8"), 0) > budget.maxTextBytes)
    throw new CliError("validation_error", "Embedding batch exceeds its text byte budget")
  if (!items.length)
    return {
      accountId: accountIdSnapshot,
      model,
      saved: 0,
      skipped: 0,
      hasMore: page.hasMore,
      ...(page.nextHash === undefined ? {} : { nextHash: page.nextHash }),
    }
  const vectors = await embedder.embed(
    items.map(({ text }) => text),
    "passage",
  )
  cancel(signal)
  if (vectors.length !== items.length)
    throw new CliError("invalid_response", "Meeting model returned another vector count")
  const rows = items.map(({ hash }, index) => ({ hash, vector: validateVector(vectors[index], model.dims) }))
  // Preserve the acknowledged write even if cancellation arrives after its atomic commit.
  const saved = await store.saveCurrent(model.key, model.dims, rows, {
    accountId: accountIdSnapshot,
    ...(signal ? { signal } : {}),
  })
  return {
    accountId: accountIdSnapshot,
    model,
    ...saved,
    hasMore: page.hasMore,
    ...(page.nextHash === undefined ? {} : { nextHash: page.nextHash }),
  }
}
