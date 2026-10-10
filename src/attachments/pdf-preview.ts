import { CliError } from "@wirecat/cli-core"
import { imageSize } from "image-size"
import { importEngine, type LoadEngine } from "./extract.js"
import { MAX_CHUNK_BYTES } from "./transfer.js"

interface Document {
  numPages: number
  getPage: (page: number) => Promise<{
    getViewport: (options: { scale: number }) => { width: number; height: number }
    cleanup: () => void
  }>
  loadingTask: { destroy: () => Promise<void> }
}

interface Engine {
  createIsomorphicCanvasFactory: (load: () => Promise<unknown>) => Promise<unknown>
  getDocumentProxy: (bytes: Uint8Array, options: Record<string, unknown>) => Promise<Document>
  renderPageAsImage: (
    document: Document,
    page: number,
    options: { scale: number; canvasImport: () => Promise<unknown> },
  ) => Promise<ArrayBuffer>
}

export const pdfPreview = async (
  bytes: Uint8Array,
  page: number,
  signal?: AbortSignal,
  load: LoadEngine = importEngine,
) => {
  const cancelled = () => {
    if (signal?.aborted) throw new CliError("cancelled", "PDF preview cancelled")
  }
  cancelled()
  if (!Number.isSafeInteger(page) || page < 1)
    throw new CliError("validation_error", "PDF page must be a position from 1")
  const optional = async (name: "unpdf" | "@napi-rs/canvas") => {
    try {
      return await load(name)
    } catch {
      throw new CliError("validation_error", `PDF page previews need the optional package ${name}`)
    }
  }
  const engine = (await optional("unpdf")) as Engine
  if (typeof engine.createIsomorphicCanvasFactory !== "function" || typeof engine.renderPageAsImage !== "function")
    throw new CliError("validation_error", "PDF page previews need unpdf with rendering support (1.8.1 or later)")
  const canvas = await optional("@napi-rs/canvas")
  cancelled()
  let document: Document | undefined
  let closed: Promise<void> | undefined
  const close = () => {
    if (document && !closed) closed = document.loadingTask.destroy().catch(() => {})
  }
  try {
    const CanvasFactory = await engine.createIsomorphicCanvasFactory(async () => canvas)
    document = await engine.getDocumentProxy(new Uint8Array(bytes), {
      CanvasFactory,
      isEvalSupported: false,
      verbosity: 0,
      maxImageSize: 20_000_000,
    })
    signal?.addEventListener("abort", close, { once: true })
    cancelled()
    if (!Number.isSafeInteger(document.numPages) || document.numPages < 1)
      throw new CliError("validation_error", "PDF page count must be a positive integer")
    if (page > document.numPages) throw new CliError("validation_error", "PDF page is past the end of the document")
    const selected = await document.getPage(page)
    let image: Buffer
    try {
      const viewport = selected.getViewport({ scale: 1 })
      if (![viewport.width, viewport.height].every((value) => Number.isFinite(value) && value > 0))
        throw new Error("invalid dimensions")
      image = Buffer.from(
        await engine.renderPageAsImage(document, page, {
          scale: Math.min(2, 2000 / viewport.width, 2000 / viewport.height),
          canvasImport: async () => canvas,
        }),
      )
    } finally {
      selected.cleanup()
    }
    cancelled()
    if (image.byteLength > MAX_CHUNK_BYTES) throw new CliError("validation_error", "PDF preview exceeds 1 MiB")
    const { width, height, type } = imageSize(image)
    if (type !== "png" || width < 1 || height < 1 || width > 2000 || height > 2000)
      throw new CliError("validation_error", "PDF preview has unsupported image dimensions or format")
    return { bytes: image, page, pageCount: document.numPages }
  } catch (error) {
    cancelled()
    if (error instanceof CliError) throw error
    throw new CliError("validation_error", "the retained PDF cannot be rendered")
  } finally {
    signal?.removeEventListener("abort", close)
    close()
    await closed
  }
}
