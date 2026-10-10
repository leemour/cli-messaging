import { PNG } from "pngjs"
import { describe, expect, it, vi } from "vitest"
import { pdf } from "../testing/files.js"
import { type Engine, importEngine, type LoadEngine } from "./extract.js"
import { type OcrPipeline, ocrImage, ocrPdf } from "./ocr.js"

const image = () => PNG.sync.write(new PNG({ width: 2, height: 2 }))
const pipeline = (text = "invoice 42"): OcrPipeline => ({
  extractor: "ocr:v1:fixture",
  transcribe: vi.fn(async () => text),
})
const missing: LoadEngine = async (name) => {
  throw Object.assign(new Error(`missing ${name}`), { code: "ERR_MODULE_NOT_FOUND" })
}

const fakePdf = (
  texts: string[],
  overrides: { render?: () => Promise<ArrayBuffer>; destroy?: () => Promise<void> } = {},
) => {
  const destroy = vi.fn(overrides.destroy ?? (async () => {}))
  const render = vi.fn(
    overrides.render ??
      (async () => {
        const bytes = image()
        return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
      }),
  )
  const load: LoadEngine = async (name) =>
    name === "@napi-rs/canvas"
      ? {}
      : {
          createIsomorphicCanvasFactory: async () => ({}),
          renderPageAsImage: render,
          getDocumentProxy: async () => ({
            numPages: texts.length,
            loadingTask: { destroy },
            getPage: async (number: number) => ({
              getViewport: () => ({ width: 600, height: 800 }),
              getTextContent: async () => ({ items: texts[number - 1] ? [{ str: texts[number - 1] }] : [] }),
              cleanup: () => {},
            }),
          }),
        }
  return { load, render, destroy }
}

describe("bounded attachment OCR", () => {
  it("reads text with an older engine but requests an upgrade before scanned-PDF OCR", async () => {
    for (const [text, status] of [
      ["local text", "extracted"],
      ["", "engine-missing"],
    ] as const) {
      const fixture = fakePdf([text])
      const load: LoadEngine = async (name) => {
        const engine = (await fixture.load(name)) as Record<string, unknown>
        return { ...engine, createIsomorphicCanvasFactory: undefined, renderPageAsImage: undefined }
      }
      const model = pipeline()
      expect(await ocrPdf(pdf(), model, load)).toMatchObject({ status })
      expect(model.transcribe).not.toHaveBeenCalled()
    }
  })
  it("transcribes a local PNG and preserves literal returned text", async () => {
    const model = pipeline("Счёт 42\nTotal 10")
    const result = await ocrImage(image(), model)
    expect(result).toMatchObject({ status: "extracted", text: "Счёт 42\nTotal 10", pages: 1, ocrPages: 1 })
    expect(model.transcribe).toHaveBeenCalledWith(expect.objectContaining({ mimeType: "image/png" }))
  })

  it("leaves oversized dimensions and unsupported image formats to the agent without calling", async () => {
    const bytes = image()
    bytes.writeUInt32BE(9000, 16)
    const model = pipeline()
    expect(await ocrImage(bytes, model)).toMatchObject({ status: "needs-agent" })
    const gif = Buffer.from("GIF89a\x02\x00\x02\x00", "binary")
    expect(await ocrImage(gif, model)).toMatchObject({ status: "needs-agent" })
    expect(model.transcribe).not.toHaveBeenCalled()
  })

  it.each(["", " ", "x".repeat(2_000_001)])("never stores an empty or oversized OCR result", async (text) => {
    expect(await ocrImage(image(), pipeline(text))).toMatchObject({ status: "unreadable", error: "ocr_failed" })
  })

  it("sanitizes provider errors and cancels without accepting a late result", async () => {
    const model = {
      extractor: "ocr:v1:fixture",
      transcribe: async () => {
        throw new Error("synthetic private document content")
      },
    }
    expect(await ocrImage(image(), model)).toMatchObject({
      status: "unreadable",
      extractor: model.extractor,
      error: "ocr_failed",
    })
    const controller = new AbortController()
    const cancelledModel = {
      extractor: model.extractor,
      transcribe: async () => {
        controller.abort()
        return "late result"
      },
    }
    await expect(ocrImage(image(), cancelledModel, controller.signal)).rejects.toMatchObject({ code: "cancelled" })
  })

  it("keeps useful PDF text local and calls OCR only for blank text-layer pages in order", async () => {
    const fixture = fakePdf(["first local page", "", "last local page"])
    const model = pipeline("middle scanned page")
    expect(await ocrPdf(pdf(), model, fixture.load)).toMatchObject({
      status: "extracted",
      text: "first local page\n\nmiddle scanned page\n\nlast local page",
      pages: 3,
      ocrPages: 1,
    })
    expect(model.transcribe).toHaveBeenCalledTimes(1)
    expect(fixture.render).toHaveBeenCalledWith(expect.any(Object), 2, expect.objectContaining({ scale: 2 }))
    expect(fixture.destroy).toHaveBeenCalledTimes(2)
  })

  it("reads actual PDF text without requiring a canvas or a model call", async () => {
    const model = pipeline()
    const load: LoadEngine = async (name) => {
      if (name === "@napi-rs/canvas") throw new Error("must not load canvas for text")
      return importEngine(name)
    }
    const result = await ocrPdf(pdf("invoice local"), model, load)
    expect(result).toMatchObject({ status: "extracted", text: "invoice local", ocrPages: 0 })
    expect(model.transcribe).not.toHaveBeenCalled()
  })

  it("renders an actual synthetic PDF through the optional local canvas engine", async () => {
    const model = pipeline()
    const result = await ocrPdf(pdf(undefined, true), model, importEngine)
    expect(result).toMatchObject({ status: "extracted", text: "invoice 42", ocrPages: 1 })
    expect(model.transcribe).toHaveBeenCalledWith(expect.objectContaining({ mimeType: "image/png" }))
  })

  it("reports missing engines and page limits without sending partial documents", async () => {
    expect(await ocrPdf(pdf(), pipeline(), missing)).toMatchObject({ status: "engine-missing", engine: "unpdf" })
    const fixture = fakePdf([""])
    const load: LoadEngine = (name: Engine) => (name === "@napi-rs/canvas" ? missing(name) : fixture.load(name))
    expect(await ocrPdf(pdf(), pipeline(), load)).toMatchObject({ status: "engine-missing", engine: "@napi-rs/canvas" })
    const many = fakePdf(Array(21).fill(""))
    const model = pipeline()
    expect(await ocrPdf(pdf(), model, many.load)).toMatchObject({ status: "too-large" })
    expect(model.transcribe).not.toHaveBeenCalled()
    expect(many.destroy).toHaveBeenCalled()
  })

  it("discards the document when a later page fails and destroys both proxies", async () => {
    const fixture = fakePdf(["", ""])
    let calls = 0
    const model = {
      extractor: "ocr:v1:fixture",
      transcribe: async () => {
        if (++calls === 2) throw new Error("provider failed")
        return "first page"
      },
    }
    expect(await ocrPdf(pdf(), model, fixture.load)).toMatchObject({
      status: "unreadable",
      extractor: model.extractor,
      error: "ocr_failed",
    })
    expect(fixture.destroy).toHaveBeenCalledTimes(2)
  })
})
