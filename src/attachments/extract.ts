import { readFileSync } from "node:fs"
import { dirname, extname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { CliError, isCliError } from "@wirecat/cli-core"
import { ReaderLimit, readContainer } from "./container.js"
import { type CellSpan, delimitedSpans } from "./csv-spans.js"
import { documentKind, readDocument } from "./documents.js"
import { decodeText } from "./encoding.js"
import { MAX_FILE_BYTES, MAX_TEXT_CHARS } from "./limits.js"

export { MAX_FILE_BYTES, MAX_TEXT_CHARS } from "./limits.js"

/** The optional packages that read formats; none is installed with this package (owner, NEED-629 A). */
export type Engine = "unpdf" | "mammoth" | "@napi-rs/canvas"

/** Loads an optional package; a test hands in its own to play a machine without it. */
export type LoadEngine = (name: Engine) => Promise<unknown>

export type Extraction =
  | {
      status: "extracted"
      text: string
      extractor: string
      pages?: number
      ocrPages?: number
      spans?: { page: number; start: number; end: number }[]
      cells?: CellSpan[]
      truncated?: boolean
    }
  /** No text layer: a scan, a photo. An agent reads it and writes the text back. */
  | { status: "needs-agent"; extractor?: string }
  | { status: "unreadable"; extractor: string; error: string }
  | { status: "unsupported" }
  | { status: "engine-missing"; engine: Engine }
  | { status: "too-large" }

export interface FileHint {
  kind: string
  name: string | null
  mime: string | null
  path: string
}

const PLAIN = new Set([".txt", ".md", ".markdown", ".csv", ".tsv", ".json", ".log"])
const IMAGES = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif", ".heic", ".tif", ".tiff", ".bmp"])
const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"

export const importEngine: LoadEngine = (name) => import(name)

const isMissing = (error: unknown, name: Engine) =>
  (error as NodeJS.ErrnoException)?.code === "ERR_MODULE_NOT_FOUND" && String((error as Error).message).includes(name)

/** `name@version` from the package's own manifest, found beside the module that loaded. */
const versionOf = (name: Engine): string => {
  try {
    let directory = dirname(fileURLToPath(import.meta.resolve(name)))
    for (let depth = 0; depth < 6; depth += 1) {
      try {
        const manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8")) as {
          name?: string
          version?: string
        }
        if (manifest.name === name && manifest.version) return `${name}@${manifest.version}`
      } catch {}
      directory = dirname(directory)
    }
  } catch {}
  return name
}

const startsWith = (bytes: Uint8Array, magic: string) =>
  bytes.length >= magic.length && [...magic].every((char, index) => bytes[index] === char.charCodeAt(0))

const extensionOf = ({ name, path }: FileHint) => extname(name ?? path).toLowerCase()

const capped = (text: string) => (text.length > MAX_TEXT_CHARS ? text.slice(0, MAX_TEXT_CHARS) : text)

const plain = (bytes: Uint8Array): Extraction => {
  const result = decodeText(bytes)
  if ("error" in result) return { status: "unreadable", extractor: "plain:v2", error: result.error }
  return {
    status: "extracted",
    text: capped(result.text),
    extractor: result.encoding === "utf-8" ? "plain" : `plain:v2:${result.encoding}`,
  }
}

interface Mammoth {
  extractRawText(input: { buffer: Buffer }): Promise<{ value: string }>
}

interface PdfDocument {
  numPages: number
  loadingTask: { destroy(): Promise<void> }
}

interface Unpdf {
  getDocumentProxy(data: Uint8Array, options: Record<string, unknown>): Promise<PdfDocument>
  extractText(
    pdf: PdfDocument,
    options: { mergePages: boolean },
  ): Promise<{ text: string | string[]; totalPages?: number }>
}

const withEngine = async <T>(
  load: LoadEngine,
  name: Engine,
  read: (engine: T, extractor: string) => Promise<Extraction>,
): Promise<Extraction> => {
  let engine: T
  try {
    const loaded = (await load(name)) as T & { default?: T }
    engine = name === "mammoth" && loaded.default ? loaded.default : loaded
  } catch (error) {
    if (isMissing(error, name)) return { status: "engine-missing", engine: name }
    throw error
  }
  const extractor = name === "mammoth" ? `docx:${versionOf(name)}` : `pdf:${versionOf(name)}`
  try {
    return await read(engine, extractor)
  } catch (error) {
    if (error instanceof ReaderLimit) return { status: "too-large" }
    if (isCliError(error) && error.code === "cancelled") throw error
    // The engine's message may quote the file; only the fact that it failed is kept.
    return { status: "unreadable", extractor, error: "unreadable" }
  }
}

/**
 * Only an exact text layer: plain text, a Word document, a PDF that carries its text. A photo, a scan
 * or a PDF of pictures is an agent's to read (owner, NEED-546: no OCR in the tool).
 */
export const extractText = async (
  bytes: Uint8Array,
  hint: FileHint,
  load: LoadEngine,
  signal?: AbortSignal,
): Promise<Extraction> => {
  if (bytes.byteLength > MAX_FILE_BYTES) return { status: "too-large" }
  const extension = extensionOf(hint)
  const kind = documentKind(hint)
  if (kind) return readDocument(bytes, kind, signal)
  if (startsWith(bytes, "%PDF-")) {
    return withEngine<Unpdf>(load, "unpdf", async (unpdf, extractor) => {
      const bounded = signal ?? new AbortController().signal
      let pdf: PdfDocument | undefined
      let closed = false
      const close = () => {
        if (pdf && !closed) {
          closed = true
          void pdf.loadingTask.destroy().catch(() => {})
        }
      }
      let abort = () => {}
      const aborted = new Promise<never>((_, reject) => {
        abort = () => {
          close()
          reject(new CliError("cancelled", "PDF text extraction stopped"))
        }
        bounded.addEventListener("abort", abort, { once: true })
        if (bounded.aborted) abort()
      })
      try {
        const reading = async () => {
          bounded.throwIfAborted()
          pdf = await unpdf.getDocumentProxy(new Uint8Array(bytes), {
            isEvalSupported: false,
            verbosity: 0,
            maxImageSize: 20_000_000,
          })
          if (bounded.aborted) {
            close()
            bounded.throwIfAborted()
          }
          if (!Number.isSafeInteger(pdf.numPages) || pdf.numPages < 1) throw new ReaderLimit()
          return unpdf.extractText(pdf, { mergePages: false })
        }
        const result = await Promise.race([reading(), aborted])
        const pages = Array.isArray(result.text) ? result.text : [result.text]
        const text = pages.join("\n\n")
        let at = 0
        const spans = pages.map((page, index) => {
          const span = { page: index + 1, start: at, end: at + page.length }
          at += page.length + 2
          return span
        })
        return text.trim() === ""
          ? { status: "needs-agent", extractor }
          : {
              status: "extracted",
              text: capped(text),
              extractor,
              pages: result.totalPages ?? pages.length,
              spans,
              ...(text.length > MAX_TEXT_CHARS ? { truncated: true } : {}),
            }
      } finally {
        bounded.removeEventListener("abort", abort)
        close()
      }
    })
  }
  if (startsWith(bytes, "PK\u0003\u0004") && (extension === ".docx" || hint.mime === DOCX)) {
    return withEngine<Mammoth>(load, "mammoth", async (mammoth, extractor) => {
      await readContainer(bytes, signal)
      const { value } = await mammoth.extractRawText({ buffer: Buffer.from(bytes) })
      return value.trim() === ""
        ? { status: "needs-agent", extractor }
        : { status: "extracted", text: capped(value), extractor }
    })
  }
  if (PLAIN.has(extension) || hint.mime?.startsWith("text/") || hint.mime === "application/json") {
    const result = plain(bytes)
    if (result.status !== "extracted" || ![".csv", ".tsv"].includes(extension)) return result
    try {
      const spans = delimitedSpans(result.text, extension === ".csv" ? "," : "\t")
      return { ...result, cells: spans.cells, ...(spans.truncated ? { truncated: true } : {}) }
    } catch {
      return { status: "unreadable", extractor: "plain", error: "malformed_delimited_text" }
    }
  }
  if (hint.kind === "photo" || hint.mime?.startsWith("image/") || IMAGES.has(extension))
    return { status: "needs-agent" }
  return { status: "unsupported" }
}

const SILENT_KINDS = new Set(["voice", "audio", "video", "video_note", "sticker", "animation", "gif"])
const SILENT = new Set([".ogg", ".oga", ".opus", ".mp3", ".m4a", ".wav", ".mp4", ".mov", ".webm", ".mkv", ".tgs"])

/**
 * What a file is, from its kind, type and name alone, so a photo or a video is never read only to be
 * set aside. `undefined`: its bytes decide.
 */
export const classify = (hint: FileHint): "image" | "unsupported" | undefined => {
  const extension = extensionOf(hint)
  if (hint.kind === "photo" || hint.mime?.startsWith("image/") || IMAGES.has(extension)) return "image"
  if (
    SILENT_KINDS.has(hint.kind) ||
    hint.mime?.startsWith("audio/") ||
    hint.mime?.startsWith("video/") ||
    SILENT.has(extension)
  )
    return "unsupported"
  return undefined
}

/** The one note a run gives for a format it skipped, naming what to install. */
export const engineHint = (engine: Engine, command: string): string =>
  `${engine === "unpdf" ? "PDF" : engine === "mammoth" ? "Word" : "Scanned PDF OCR"} files need the optional package ${engine}, installed where ${command} is ` +
  `(for a global npm install: npm install -g ${engine}); they are read on the next run`

export const tooLarge = (bytes: number): boolean => bytes > MAX_FILE_BYTES
