import { describe, expect, it } from "vitest"
import { openRemote, remoteKey, remoteModel } from "./remote.js"

type Call = {
  url: string
  headers: Record<string, string>
  body: { model: string; input: string[]; dimensions?: number }
}

/** A stand-in for OpenAI: each text's vector is [its length, 0, …], answered in reverse order. */
const standIn = (dims: number, script: ((call: Call) => Response | undefined)[] = []) => {
  const calls: Call[] = []
  const fetch = async (url: string, init: RequestInit) => {
    const call = { url, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) }
    calls.push(call)
    const scripted = script.shift()?.(call)
    if (scripted) return scripted
    const data = call.body.input.map((text: string, index: number) => ({
      index,
      embedding: [text.length, ...new Array(dims - 1).fill(0)],
    }))
    return new Response(JSON.stringify({ data: data.reverse() }), { status: 200 })
  }
  return { calls, fetch }
}

describe("openRemote", () => {
  it("uses normal fetch redirect handling for configured gateways", async () => {
    const remote = remoteModel({})
    const fetch = async (_url: string, init: RequestInit) => {
      expect(init.redirect).toBeUndefined()
      return new Response(JSON.stringify({ data: [{ index: 0, embedding: new Array(1536).fill(1) }] }))
    }
    expect(await openRemote(remote, "synthetic-key", { fetch }).embed(["synthetic text"], "passage")).toHaveLength(1)
  })

  it("**sends OpenAI's request shape** with the key, and gives the vectors back in order, length one", async () => {
    const remote = remoteModel({})
    const { calls, fetch } = standIn(1536)
    const vectors = await openRemote(remote, "sk-test", { fetch }).embed(["ab", "abc"], "passage")

    expect(calls[0]?.url).toBe("https://api.openai.com/v1/embeddings")
    expect(calls[0]?.headers.authorization).toBe("Bearer sk-test")
    expect(calls[0]?.body).toEqual({ model: "text-embedding-3-small", input: ["ab", "abc"], encoding_format: "float" })
    expect(vectors.map((vector) => vector[0])).toEqual([1, 1])
    expect(remoteKey(remote)).toBe("openai:text-embedding-3-small:1536")
  })

  it("asks a shorter OpenAI vector with `dimensions`, and a server of its own by --base-url and --dims", async () => {
    const short = standIn(256)
    await openRemote(remoteModel({ dims: 256 }), "k", { fetch: short.fetch }).embed(["x"], "query")
    expect(short.calls[0]?.body.dimensions).toBe(256)

    const local = standIn(768)
    const remote = remoteModel({ model: "nomic-embed-text", baseUrl: "http://localhost:11434/v1", dims: 768 })
    await openRemote(remote, undefined, { fetch: local.fetch }).embed(["x"], "query")
    expect(local.calls[0]?.url).toBe("http://localhost:11434/v1/embeddings")
    expect(local.calls[0]?.headers.authorization).toBeUndefined()
    expect(remoteKey(remote)).toBe("url:localhost:11434:nomic-embed-text:768")
    expect(() => remoteModel({ baseUrl: "http://localhost:11434/v1", model: "m" })).toThrow("--dims")
    expect(() => remoteModel({ model: "ada-3000" })).toThrow("OpenAI has no embedding model ada-3000")
  })

  it("**splits into requests of 256** and runs them side by side", async () => {
    const { calls, fetch } = standIn(1536)
    const texts = Array.from({ length: 600 }, (_, index) => "x".repeat(index + 1))
    const vectors = await openRemote(remoteModel({}), "k", { fetch, concurrency: 2 }).embed(texts, "passage")
    expect(calls.map(({ body }) => body.input.length)).toEqual([256, 256, 88])
    expect(vectors).toHaveLength(600)
  })

  it("waits out a 429 and goes on; a refused key stops, and no error carries the key or the text", async () => {
    const limited = standIn(1536, [() => new Response("{}", { status: 429, headers: { "retry-after": "0.01" } })])
    expect(
      await openRemote(remoteModel({}), "k", { fetch: limited.fetch }).embed(["secret text"], "passage"),
    ).toHaveLength(1)
    expect(limited.calls).toHaveLength(2)

    const refused = standIn(1536, [
      () =>
        new Response(JSON.stringify({ error: { code: "invalid_api_key", message: "sk-test secret text" } }), {
          status: 401,
        }),
    ])
    const error = await openRemote(remoteModel({}), "sk-test", { fetch: refused.fetch })
      .embed(["secret text"], "passage")
      .catch((caught: Error) => caught)
    expect(String(error)).toContain("invalid_api_key")
    expect(String(error)).not.toContain("sk-test")
    expect(String(error)).not.toContain("secret text")
  })

  it("refuses vectors of another size than the model's", async () => {
    const { fetch } = standIn(10)
    await expect(openRemote(remoteModel({}), "k", { fetch }).embed(["x"], "passage")).rejects.toThrow("1 × 1536")
  })
})
