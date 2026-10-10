import { setTimeout } from "node:timers/promises"
import { CliError } from "@wirecat/cli-core"
import { type Embedder, unit } from "./embed.js"
import type { TextModel } from "./models.js"

/**
 * An embedding model behind an OpenAI-shaped `/v1/embeddings` (phase 5 E11): OpenAI itself, or what
 * serves the same request — Gemini's compatibility URL, Jina, Ollama and LM Studio on this machine.
 * Facts: `docs/storage/research/2026-10-02-embedding-apis.md`.
 */
export interface RemoteModel {
  provider: string
  model: string
  dims: number
  baseUrl: string
  /** Sent as `dimensions` when it differs from the model's own size. */
  shorten: boolean
  /** USD per 1M input tokens, and the day the price page was read; nothing for a server of the user's own. */
  price?: { perMillion: number; read: string }
}

export const OPENAI_URL = "https://api.openai.com/v1"

/** OpenAI's models, from its pricing page as read on 2026-10-02. */
export const OPENAI_MODELS: Record<string, { dims: number; perMillion: number }> = {
  "text-embedding-3-small": { dims: 1536, perMillion: 0.02 },
  "text-embedding-3-large": { dims: 3072, perMillion: 0.13 },
}

export const DEFAULT_OPENAI_MODEL = "text-embedding-3-small"

/** OpenAI's limits per request (2,048 inputs, 300,000 tokens); a chunk is at most ~400 tokens. */
const PER_REQUEST = 256

const LOCAL = new Set(["localhost", "127.0.0.1", "[::1]", "::1"])

/** A server on this machine: nothing leaves it, so nothing is asked. */
export const isLocal = (baseUrl: string): boolean => LOCAL.has(new URL(baseUrl).hostname)

export const remoteModel = ({
  model = DEFAULT_OPENAI_MODEL,
  baseUrl,
  dims,
}: {
  model?: string
  baseUrl?: string
  dims?: number
}): RemoteModel => {
  const known = baseUrl === undefined ? OPENAI_MODELS[model] : undefined
  if (baseUrl === undefined && !known) {
    throw new CliError(
      "validation_error",
      `OpenAI has no embedding model ${model} here — one of: ${Object.keys(OPENAI_MODELS).join(", ")}; ` +
        "another server takes --base-url",
    )
  }
  const size = dims ?? known?.dims
  if (size === undefined) throw new CliError("validation_error", "with --base-url, say the vector size with --dims")
  return {
    provider: baseUrl === undefined ? "openai" : `url:${new URL(baseUrl).host}`,
    model,
    dims: size,
    baseUrl: baseUrl ?? OPENAI_URL,
    shorten: known !== undefined && size !== known.dims,
    ...(known ? { price: { perMillion: known.perMillion, read: "2026-10-02" } } : {}),
  }
}

/** The vector key of a remote model, beside `local:<model>:<dims>`. */
export const remoteKey = ({ provider, model, dims }: RemoteModel): string => `${provider}:${model}:${dims}`

export type Fetch = (url: string, init: RequestInit) => Promise<Response>

/** Up to `concurrency` requests at once; a 429 waits for `Retry-After`, a server error is tried again. */
export const openRemote = (
  remote: RemoteModel,
  apiKey: string | undefined,
  { concurrency = 4, fetch: post = fetch, tries = 5 }: { concurrency?: number; fetch?: Fetch; tries?: number } = {},
): Embedder => {
  const request = async (input: string[]): Promise<Float32Array[]> => {
    for (let attempt = 1; ; attempt++) {
      let response: Response
      try {
        response = await post(`${remote.baseUrl.replace(/\/$/, "")}/embeddings`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
          },
          body: JSON.stringify({
            model: remote.model,
            input,
            encoding_format: "float",
            ...(remote.shorten ? { dimensions: remote.dims } : {}),
          }),
        })
      } catch {
        if (attempt >= tries) throw new CliError("network_error", `${remote.provider} could not be reached`)
        await setTimeout(1000 * attempt)
        continue
      }
      if (response.ok) {
        const body = (await response.json()) as { data?: { index: number; embedding: number[] }[] }
        const data = [...(body.data ?? [])].sort((a, b) => a.index - b.index)
        if (data.length !== input.length || data.some(({ embedding }) => embedding.length !== remote.dims)) {
          throw new CliError(
            "invalid_response",
            `${remote.provider} answered with vectors of another number or size than ${input.length} × ${remote.dims}`,
          )
        }
        return data.map(({ embedding }) => unit(Float32Array.from(embedding)))
      }
      const code = await errorCode(response)
      if (response.status === 401 || response.status === 403) {
        throw new CliError(
          "authentication_error",
          `${remote.provider} refused the key (HTTP ${response.status}${code}) — set it again with \`models text key set\``,
        )
      }
      const again = response.status === 429 || response.status >= 500
      if (!again || attempt >= tries) {
        throw new CliError(
          response.status === 429 ? "rate_limited" : "provider_error",
          `${remote.provider} answered HTTP ${response.status}${code}`,
        )
      }
      const wait = Number(response.headers.get("retry-after"))
      await setTimeout(Number.isFinite(wait) && wait > 0 ? wait * 1000 : 1000 * 2 ** attempt)
    }
  }

  return {
    model: { id: remote.model, dims: remote.dims } as TextModel,
    embed: async (texts) => {
      const parts: string[][] = []
      for (let start = 0; start < texts.length; start += PER_REQUEST)
        parts.push(texts.slice(start, start + PER_REQUEST))
      const results: Float32Array[][] = new Array(parts.length)
      let next = 0
      await Promise.all(
        Array.from({ length: Math.min(concurrency, parts.length) }, async () => {
          for (let index = next++; index < parts.length; index = next++)
            results[index] = await request(parts[index] as string[])
        }),
      )
      return results.flat()
    },
    close: async () => {},
  }
}

/** The provider's error code, never its message: a message can quote the request. */
const errorCode = async (response: Response): Promise<string> => {
  try {
    const body = (await response.json()) as { error?: { code?: unknown; type?: unknown } }
    const code = body.error?.code ?? body.error?.type
    return typeof code === "string" && /^[\w.-]{1,64}$/.test(code) ? `, ${code}` : ""
  } catch {
    return ""
  }
}
