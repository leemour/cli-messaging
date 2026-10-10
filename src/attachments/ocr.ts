import { CliError } from "@wirecat/cli-core"
import { imageSize } from "image-size"
import { isCliFailure } from "../cli/failures.js"
import { withRecovery } from "../cli/recovery.js"
import type { ModelImage } from "../models/index.js"
import { MAX_MODEL_IMAGE_BYTES } from "../models/types.js"
import { type Extraction, type LoadEngine, MAX_TEXT_CHARS } from "./extract.js"

export interface OcrPipeline {
  extractor: string
  transcribe: (image: ModelImage) => Promise<string>
}

const MAX_PAGES = 20
const MAX_PIXELS = 20_000_000

interface PdfPage {
  getViewport: (options: { scale: number }) => { width: number; height: number }
  getTextContent: () => Promise<{ items: { str?: string; hasEOL?: boolean }[] }>
  cleanup: () => void
}

interface PdfDocument {
  numPages: number
  getPage: (page: number) => Promise<PdfPage>
  loadingTask: { destroy: () => Promise<void> }
}

interface PdfEngine {
  createIsomorphicCanvasFactory: (load: () => Promise<unknown>) => Promise<unknown>
  getDocumentProxy: (bytes: Uint8Array, options: Record<string, unknown>) => Promise<PdfDocument>
  renderPageAsImage: (
    document: PdfDocument,
    page: number,
    options: { scale: number; canvasImport: () => Promise<unknown> },
  ) => Promise<ArrayBuffer>
}

const cancelled = (signal?: AbortSignal) => {
  if (signal?.aborted) throw new CliError("cancelled", "attachment OCR cancelled")
}

const imageOf = (bytes: Uint8Array): ModelImage | undefined => {
  if (bytes.byteLength > MAX_MODEL_IMAGE_BYTES) return undefined
  const { width, height, type } = imageSize(bytes)
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1)
    throw new Error("invalid image dimensions")
  if (width * height > MAX_PIXELS || width > 8000 || height > 8000) return undefined
  const mimeType = type === "jpg" ? "image/jpeg" : type === "png" ? "image/png" : type === "webp" ? "image/webp" : null
  if (mimeType === null) return undefined
  return { mimeType, data: Buffer.from(bytes).toString("base64") }
}

const checkedText = (text: string): string => {
  if (typeof text !== "string" || !text.trim() || text.length > MAX_TEXT_CHARS)
    throw new Error("empty or oversized OCR result")
  return text
}

export const ocrImage = async (bytes: Uint8Array, pipeline: OcrPipeline, signal?: AbortSignal): Promise<Extraction> => {
  cancelled(signal)
  try {
    const image = imageOf(bytes)
    if (image === undefined) return { status: "needs-agent", extractor: pipeline.extractor }
    const text = checkedText(await pipeline.transcribe(image))
    cancelled(signal)
    return { status: "extracted", text, extractor: pipeline.extractor, pages: 1, ocrPages: 1 }
  } catch (error) {
    cancelled(signal)
    return {
      status: "unreadable",
      extractor: pipeline.extractor,
      error: error instanceof CliError && error.code === "rate_limited" ? "rate_limited" : "ocr_failed",
      issue: withRecovery({
        code: isCliFailure(error) ? error.code : "provider_error",
        message: "OCR provider refused this item; retry or skip it",
        ...(isCliFailure(error) && typeof error.details?.retryAfterMs === "number"
          ? { retryAfterMs: error.details.retryAfterMs }
          : {}),
      }),
    }
  }
}

export const ocrPdf = async (
  bytes: Uint8Array,
  pipeline: OcrPipeline,
  load: LoadEngine,
  signal?: AbortSignal,
): Promise<Extraction> => {
  cancelled(signal)
  let unpdf: PdfEngine
  try {
    unpdf = (await load("unpdf")) as PdfEngine
  } catch {
    return { status: "engine-missing", engine: "unpdf" }
  }
  let document: PdfDocument | undefined
  let rendered: PdfDocument | undefined
  const close = () => {
    void document?.loadingTask.destroy().catch(() => {})
    void rendered?.loadingTask.destroy().catch(() => {})
  }
  try {
    // Inspect page text before loading the optional renderer; text-only PDFs stay local.
    document = await unpdf.getDocumentProxy(new Uint8Array(bytes), {
      isEvalSupported: false,
      verbosity: 0,
      maxImageSize: MAX_PIXELS,
    })
    signal?.addEventListener("abort", close, { once: true })
    cancelled(signal)
    if (!Number.isSafeInteger(document.numPages) || document.numPages < 1 || document.numPages > MAX_PAGES)
      return { status: "too-large" }
    const texts: string[] = []
    let ocrPages = 0
    let canvas: unknown
    try {
      for (let index = 1; index <= document.numPages; index += 1) {
        cancelled(signal)
        const page = await document.getPage(index)
        let text: string
        try {
          const content = await page.getTextContent()
          text = content.items
            .map((item) => `${item.str ?? ""}${item.hasEOL ? "\n" : " "}`)
            .join("")
            .trim()
          if (!text) {
            if (
              typeof unpdf.createIsomorphicCanvasFactory !== "function" ||
              typeof unpdf.renderPageAsImage !== "function"
            )
              return { status: "engine-missing", engine: "unpdf" }
            if (canvas === undefined) {
              try {
                canvas = await load("@napi-rs/canvas")
              } catch {
                return { status: "engine-missing", engine: "@napi-rs/canvas" }
              }
              const CanvasFactory = await unpdf.createIsomorphicCanvasFactory(async () => canvas)
              rendered = await unpdf.getDocumentProxy(new Uint8Array(bytes), {
                CanvasFactory,
                isEvalSupported: false,
                verbosity: 0,
                maxImageSize: MAX_PIXELS,
              })
            }
            const viewport = page.getViewport({ scale: 1 })
            if (![viewport.width, viewport.height].every((value) => Number.isFinite(value) && value > 0))
              throw new Error("invalid PDF dimensions")
            const scale = Math.min(2, 2000 / viewport.width, 2000 / viewport.height)
            const image = imageOf(
              new Uint8Array(
                await unpdf.renderPageAsImage(rendered as PdfDocument, index, {
                  scale,
                  canvasImport: async () => canvas,
                }),
              ),
            )
            if (!image) return { status: "too-large" }
            text = checkedText(await pipeline.transcribe(image))
            ocrPages += 1
          }
        } finally {
          page.cleanup()
        }
        cancelled(signal)
        texts.push(text)
        if (texts.reduce((sum, one) => sum + one.length + 2, 0) > MAX_TEXT_CHARS) return { status: "too-large" }
      }
      return {
        status: "extracted",
        text: texts.join("\n\n"),
        extractor: pipeline.extractor,
        pages: document.numPages,
        ocrPages,
      }
    } finally {
      await rendered?.loadingTask.destroy()
    }
  } catch (error) {
    cancelled(signal)
    return {
      status: "unreadable",
      extractor: pipeline.extractor,
      error: error instanceof CliError && error.code === "rate_limited" ? "rate_limited" : "ocr_failed",
      issue: withRecovery({
        code: isCliFailure(error) ? error.code : "provider_error",
        message: "OCR provider refused this item; retry or skip it",
        ...(isCliFailure(error) && typeof error.details?.retryAfterMs === "number"
          ? { retryAfterMs: error.details.retryAfterMs }
          : {}),
      }),
    }
  } finally {
    signal?.removeEventListener("abort", close)
    await document?.loadingTask.destroy()
  }
}
