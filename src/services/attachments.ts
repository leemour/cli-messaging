import { createHash } from "node:crypto"
import { constants } from "node:fs"
import { open, readFile, stat } from "node:fs/promises"
import { CliError } from "@wirecat/cli-core"
import { directoryPaths } from "../attachments/directory.js"
import { documentExtractor, documentKind } from "../attachments/documents.js"
import {
  classify,
  type Engine,
  type Extraction,
  extractText,
  importEngine,
  type LoadEngine,
  MAX_TEXT_CHARS,
} from "../attachments/extract.js"
import { attachmentMaxBytes } from "../attachments/limits.js"
import { type OcrPipeline, ocrImage, ocrPdf } from "../attachments/ocr.js"
import { pdfPreview } from "../attachments/pdf-preview.js"
import { type ByteWindow, retainedBytes, transferMime, validateWindow } from "../attachments/transfer.js"
import { type ActionableError, withRecovery } from "../cli/recovery.js"
import { NOT_FILES } from "../domain/attachments.js"
import { formatLocator, isLocator, parseLocator } from "../domain/locator.js"
import type { Id } from "../domain/models.js"
import { refusedPlace } from "../sends/upload.js"
import type { AccountKey, AttachmentView, FileAttachment, MessageStore, TextOrigin } from "../store/store.js"
import { batchProgress } from "./batch.js"
import type { ServiceDeps } from "./deps.js"
import { storedChatId } from "./messages.js"

export type ExtractStatus = "extracted" | "needs-agent" | "unreadable" | "engine-missing" | "too-large" | "missing"

/** One file looked at. Never its text: the text stays in the local store. */
export interface ExtractItem {
  locator: string
  /** The attachment's place in the message, from 1. */
  attachment: number
  kind: string
  name: string | null
  status: ExtractStatus
  extractor?: string
  chars?: number
  localPath?: string
  pages?: number
  ocrPages?: number
  error?: string
  issue?: ActionableError
}

export interface ExtractRun {
  items: ExtractItem[]
  extracted: number
  needsAgent: number
  failed: number
  /** Kept text was not replaced: an unchanged source or protected agent text. */
  unchanged: number
  /** No saved file, and no `--download`. */
  notDownloaded: number
  /** Video, voice, an archive: nothing to read. */
  unsupported: number
  /** Every file was looked at; `false` when `limit` or a stop cut the run short. */
  complete: boolean
  /** Packages a format needed and this machine lacks; those files are read on a later run. */
  enginesMissing: Engine[]
  cursor?: string
  batch?: ReturnType<ReturnType<typeof batchProgress>["result"]>
}

export interface ExtractOptions {
  chat?: string
  message?: string
  paths?: readonly string[]
  fromDir?: string
  cursor?: string
  scanLimit?: number
  /** At most this many files read. */
  limit?: number
  /** Saves a message's files where none were saved, through `messages download`'s own code. */
  download?: (chatId: Id, messageId: Id) => Promise<void>
  onItem?: (item: ExtractItem) => void
  signal?: AbortSignal
  load?: LoadEngine
  ocr?: OcrPipeline
  concurrency?: number
}

/** One file attachment as `attachments list` shows it; never its text. */
export interface AttachmentItem {
  locator: string
  /** The attachment's place in the message, from 1. */
  attachment: number
  kind: string
  name: string | null
  localPath: string | null
  text: { origin: TextOrigin; extractor: string; chars: number; error: string | null } | null
}

export interface AttachmentTextSet {
  locator: string
  attachment: number
  origin: "agent"
  chars: number
  /** What the stored text was before, if any. */
  replaced: TextOrigin | null
}

export interface AttachmentBytes {
  locator: string
  attachment: number
  name: string | null
  mimeType: string
  totalBytes: number
  sha256: string
  offsetBytes: number
  readBytes: number
  nextOffsetBytes: number | null
  complete: boolean
  base64: string
  pdf?: { page: number; pageCount: number; sourceSha256: string; sourceBytes: number }
}

export interface AttachmentsService {
  show(
    target: { chat: string; message?: string; attachment?: number; page?: number; load?: LoadEngine } & ByteWindow,
  ): Promise<AttachmentBytes>
  /** Reads the text layer of saved files into the local store; prints and sends nothing. */
  extract(options?: ExtractOptions): Promise<ExtractRun>
  /** File attachments of stored messages and what is held of their text; one page more tells `hasMore`. */
  list(filter: { chat?: string; needsText?: boolean; limit: number; page?: number }): Promise<AttachmentItem[]>
  /** Keeps text an agent read from a file — a scan, a photo — replacing whatever was there. Sends nothing. */
  setText(target: { chat: string; message?: string; attachment?: number; text: string }): Promise<AttachmentTextSet>
}

const PAGE = 200

const outcome = async (
  file: FileAttachment,
  path: string,
  load: LoadEngine,
  signal?: AbortSignal,
  noFollow = false,
  ocr?: OcrPipeline,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{
  status: ExtractStatus | "unchanged" | "unsupported"
  extraction?: Extraction
  bytes?: number
  sha?: string
  issue?: ActionableError
}> => {
  const maxBytes = attachmentMaxBytes(env)
  const tooLarge = () => ({
    status: "too-large" as const,
    issue: withRecovery({
      code: "validation_error",
      message: `attachment exceeds ${maxBytes / 1024 / 1024} MiB; configure MESSAGING_ATTACHMENT_MAX_MIB`,
      setting: "MESSAGING_ATTACHMENT_MAX_MIB",
    }),
  })
  const size = await stat(path).then(
    (found) => (found.isFile() ? found.size : undefined),
    () => undefined,
  )
  if (size === undefined) return { status: "missing" }
  const hint = { kind: file.kind, name: file.name, mime: file.mime, path }
  const known = classify(hint)
  if (known === "unsupported") return { status: "unsupported" }
  if (size > maxBytes) return tooLarge()
  const handle = await open(path, constants.O_RDONLY | (noFollow ? constants.O_NOFOLLOW : 0))
  let bytes: Uint8Array
  try {
    const opened = await handle.stat()
    if (!opened.isFile()) return { status: "missing" }
    if (opened.size > maxBytes) return tooLarge()
    bytes = new Uint8Array(await readFile(handle, { signal }))
  } finally {
    await handle.close()
  }
  const sha = createHash("sha256").update(bytes).digest("hex")
  const isPdf = Buffer.from(bytes.subarray(0, 5)).toString() === "%PDF-"
  const ocrCandidate = ocr !== undefined && (known === "image" || isPdf)
  const localKind = documentKind(hint)
  if (
    file.read?.origin === "extracted" &&
    file.read.contentSha256 === sha &&
    (!localKind || file.read.extractor === documentExtractor(localKind)) &&
    (file.read.error === null || (!ocrCandidate && file.read.error === "no_text")) &&
    (!ocrCandidate || (file.read.extractor === ocr?.extractor && file.read.error === null))
  )
    return { status: "unchanged" }
  if (ocr && ocrCandidate) {
    const extraction = known === "image" ? await ocrImage(bytes, ocr, signal) : await ocrPdf(bytes, ocr, load, signal)
    return { status: extraction.status, extraction, bytes: size, sha }
  }
  if (known === "image")
    return { status: "needs-agent", extraction: { status: "needs-agent", extractor: "none" }, bytes: size, sha }
  const extraction = await extractText(bytes, hint, load, signal, env)
  return { status: extraction.status, extraction, bytes: size, sha }
}

const keep = async (
  store: MessageStore,
  file: FileAttachment,
  extraction: Extraction,
  bytes: number,
  sha: string | undefined,
) => {
  const base = { origin: "extracted" as const, contentSha256: sha, bytes }
  if (extraction.status === "extracted") {
    return store.keepAttachmentText(file.pk, { ...base, text: extraction.text, extractor: extraction.extractor })
  } else if (extraction.status === "unreadable") {
    return store.keepAttachmentText(file.pk, {
      ...base,
      text: "",
      extractor: extraction.extractor,
      error: extraction.error,
    })
  } else if (extraction.status === "needs-agent" && extraction.extractor) {
    // Kept, so the next run does not parse the same scan again; an agent's text replaces it.
    return store.keepAttachmentText(file.pk, { ...base, text: "", extractor: extraction.extractor, error: "no_text" })
  }
}

const itemOf = (account: AccountKey, view: AttachmentView): AttachmentItem => ({
  locator: formatLocator({ ...account, chat: view.chatId, message: view.messageId }),
  attachment: view.position + 1,
  kind: view.kind,
  name: view.name,
  localPath: view.localPath,
  text: view.text,
})

/** A chat and a message id, or a msg: locator alone — of this account. */
const messageOf = async (
  deps: ServiceDeps,
  store: MessageStore,
  account: AccountKey,
  chat: string,
  message: string | undefined,
): Promise<{ chatId: Id; messageId: Id }> => {
  if (isLocator(chat)) {
    if (message !== undefined) throw new CliError("validation_error", "a locator already names the message")
    const locator = parseLocator(chat)
    if (locator.provider !== account.provider || locator.account !== account.account)
      throw new CliError("validation_error", "that locator belongs to another account; select its profile first")
    return { chatId: locator.chat, messageId: locator.message }
  }
  if (message === undefined) throw new CliError("validation_error", "which message? give its id after the chat")
  return { chatId: await storedChatId(deps.messenger, chat, store, account), messageId: message.trim() }
}

export const attachmentsService = (deps: ServiceDeps): AttachmentsService => ({
  extract: async ({
    chat,
    message: onlyMessage,
    paths,
    fromDir,
    cursor,
    scanLimit: requestedScanLimit,
    limit: requestedLimit,
    download,
    onItem,
    signal,
    load = importEngine,
    ocr,
    concurrency = 1,
  } = {}) => {
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8 || (concurrency !== 1 && !ocr))
      throw new CliError("validation_error", "API OCR concurrency must be between 1 and 8 and needs OCR")
    attachmentMaxBytes(deps.env)
    const limit = requestedLimit ?? (ocr ? 100 : undefined)
    const scanLimit = requestedScanLimit ?? (ocr ? 500 : undefined)
    if (ocr && (limit === undefined || !Number.isSafeInteger(limit) || limit < 1 || limit > 500))
      throw new CliError("validation_error", "API OCR file limit must be between 1 and 500")
    if (fromDir !== undefined && (chat === undefined || download))
      throw new CliError("validation_error", "--from-dir needs --chat and cannot be combined with --download")
    if (onlyMessage !== undefined && chat === undefined)
      throw new CliError("validation_error", "message extraction needs a chat")
    if (cursor !== undefined && (!/^[1-9][0-9]*$/.test(cursor) || !Number.isSafeInteger(Number(cursor))))
      throw new CliError("validation_error", "invalid extraction cursor")
    deps.guard.check({ chatId: null, key: "attachments.extract" }, { reserve: false })
    const store = await deps.store()
    const account: AccountKey = await deps.account()
    const chatId = chat === undefined ? undefined : await storedChatId(deps.messenger, chat, store, account)
    const directory =
      fromDir === undefined
        ? undefined
        : await directoryPaths(store, account, chatId as string, fromDir, deps.messenger.app, deps.env ?? process.env)
    const selected = paths === undefined ? undefined : new Set(paths)
    const run: ExtractRun = {
      items: [],
      extracted: 0,
      needsAgent: 0,
      failed: 0,
      unchanged: 0,
      notDownloaded: 0,
      unsupported: 0,
      complete: true,
      enginesMissing: [],
    }
    const batch = batchProgress(deps.env)
    const fetched = new Set<string>()
    let read = 0
    let beforePk = cursor === undefined ? undefined : Number(cursor)
    let scanned = 0
    const pending: Promise<void>[] = []
    const finished = new Map<number, ExtractItem>()
    const processFile = async (file: FileAttachment, path: string) => {
      deps.guard.check({ chatId: file.chatId, key: "attachments.extract" }, { reserve: false })
      const {
        status,
        extraction,
        bytes,
        sha,
        issue: limitIssue,
      } = await outcome(file, path, load, signal, fromDir !== undefined, ocr, deps.env)
      if (status === "unchanged") {
        run.unchanged += 1
        return
      }
      if (status === "unsupported") {
        run.unsupported += 1
        return
      }
      if (signal?.aborted) {
        run.complete = false
        return
      }
      if (
        extraction &&
        bytes !== undefined &&
        (!ocr || status === "extracted") &&
        (status === "extracted" || file.read?.error !== null)
      ) {
        if ((await keep(store, file, extraction, bytes, sha)) === false) {
          run.unchanged += 1
          read += 1
          return
        }
      }
      if (status !== "missing" && status !== "too-large" && status !== "engine-missing") read += 1
      if (extraction?.status === "engine-missing" && !run.enginesMissing.includes(extraction.engine))
        run.enginesMissing.push(extraction.engine)
      if (status === "extracted") run.extracted += 1
      else if (status === "needs-agent") run.needsAgent += 1
      else if (status === "unreadable") run.failed += 1
      let issue: ActionableError | undefined
      if (["missing", "too-large", "engine-missing", "unreadable"].includes(status)) {
        issue = batch.fail(
          formatLocator({ ...account, chat: file.chatId, message: file.messageId }),
          "extract",
          limitIssue ??
            (extraction?.status === "unreadable" && extraction.issue
              ? extraction.issue
              : new CliError(
                  status === "missing" ? "not_found" : "validation_error",
                  status === "too-large"
                    ? "attachment exceeds an extraction, decompression or OCR size limit"
                    : `attachment ${status}; ${status === "engine-missing" ? "install the required optional reader package" : "retry or skip this item"}`,
                  { limitSource: ocr ? "provider" : "local" },
                )),
          file.position + 1,
        )
      } else batch.ok()
      const item: ExtractItem = {
        locator: formatLocator({ ...account, chat: file.chatId, message: file.messageId }),
        attachment: file.position + 1,
        kind: file.kind,
        name: file.name,
        status,
        ...(issue ? { issue } : {}),
        ...(status === "needs-agent" ? { localPath: path } : {}),
        ...(ocr && extraction?.status === "unreadable" ? { error: extraction.error } : {}),
        ...(extraction && "extractor" in extraction && extraction.extractor ? { extractor: extraction.extractor } : {}),
        ...(extraction?.status === "extracted"
          ? {
              chars: extraction.text.length,
              ...(extraction.pages === undefined ? {} : { pages: extraction.pages, ocrPages: extraction.ocrPages }),
            }
          : {}),
      }
      finished.set(file.pk, item)
      onItem?.(item)
    }
    const failedItem = (file: FileAttachment, stage: string, error: unknown) => {
      const issue = batch.fail(
        formatLocator({ ...account, chat: file.chatId, message: file.messageId }),
        stage,
        error,
        file.position + 1,
      )
      run.failed += 1
      const item: ExtractItem = {
        locator: formatLocator({ ...account, chat: file.chatId, message: file.messageId }),
        attachment: file.position + 1,
        kind: file.kind,
        name: file.name,
        status: "unreadable",
        error: issue.code,
        issue,
      }
      finished.set(file.pk, item)
      onItem?.(item)
    }
    try {
      walk: for (;;) {
        const page = await store.fileAttachments(account, {
          ...(chatId === undefined ? {} : { chatId }),
          ...(onlyMessage === undefined ? {} : { messageId: onlyMessage }),
          ...(beforePk === undefined ? {} : { beforePk }),
          limit: PAGE,
        })
        for (const file of page) {
          while (
            pending.length &&
            (pending.length >= concurrency || (limit !== undefined && read + pending.length >= limit))
          )
            await pending.shift()
          if (
            batch.stopped ||
            signal?.aborted ||
            (limit !== undefined && read >= limit) ||
            (scanLimit !== undefined && scanned >= scanLimit)
          ) {
            run.complete = false
            if (beforePk !== undefined) run.cursor = String(beforePk)
            break walk
          }
          beforePk = file.pk
          scanned += 1
          let path = directory === undefined ? file.localPath : (directory.get(file.pk) ?? null)
          if (directory && path)
            await store.keepDownloads(account, file.chatId, file.messageId, [
              { kind: file.kind, position: file.position, path },
            ])
          if (selected && (path === null || !selected.has(path))) continue
          const message = `${file.chatId}/${file.messageId}`
          if (path === null && download && !fetched.has(message)) {
            fetched.add(message)
            try {
              await download(file.chatId, file.messageId)
            } catch (error) {
              failedItem(file, "download", error)
            }
            path = await store.localPathOf(file.pk)
          }
          if (path === null) {
            run.notDownloaded += 1
            continue
          }
          const task = processFile(file, path).catch((error) => {
            failedItem(file, "extract", error)
          })
          void task.catch(() => {})
          pending.push(task)
        }
        if (page.length < PAGE) break
      }
      await Promise.all(pending)
    } finally {
      await Promise.allSettled(pending)
    }
    if (batch.failed > 0) {
      run.batch = batch.result()
      run.complete = false
    }
    run.items = [...finished.entries()].sort(([a], [b]) => b - a).map(([, item]) => item)
    return run
  },

  list: async ({ chat, needsText, limit, page = 1 }) => {
    const store = await deps.store()
    const account = await deps.account()
    const chatId = chat === undefined ? undefined : await storedChatId(deps.messenger, chat, store, account)
    const views = await store.attachments(account, {
      ...(chatId === undefined ? {} : { chatId }),
      ...(needsText ? { needsText } : {}),
      offset: (page - 1) * limit,
      limit: limit + 1,
    })
    return views.map((view) => itemOf(account, view))
  },

  show: async ({ chat, message, attachment, page, load, ...window }) => {
    validateWindow(window)
    if (page !== undefined && (!Number.isSafeInteger(page) || page < 1))
      throw new CliError("validation_error", "PDF page must be a position from 1")
    if (page !== undefined && (window.offsetBytes !== undefined || window.chunkBytes !== undefined))
      throw new CliError("validation_error", "PDF page cannot be combined with byte offset or chunk size")
    if (attachment !== undefined && (!Number.isSafeInteger(attachment) || attachment < 1))
      throw new CliError("validation_error", "attachment must be a position from 1")
    const store = await deps.store()
    const account = await deps.account()
    const { chatId, messageId } = await messageOf(deps, store, account, chat, message)
    const files = (await store.attachments(account, { chatId, messageId, limit: 1000 })).filter(
      ({ kind }) => !NOT_FILES.has(kind),
    )
    const chosen =
      attachment === undefined
        ? files.length === 1
          ? files[0]
          : undefined
        : files.find(({ position }) => position === attachment - 1)
    if (!chosen)
      throw new CliError(
        files.length === 0 ? "not_found" : "validation_error",
        "choose one stored file with --attachment and its position from 1",
      )
    if (chosen.localPath === null) throw new CliError("not_found", "download this attachment before transferring it")
    if (refusedPlace(chosen.localPath, deps.messenger.app, deps.env ?? process.env))
      throw new CliError("validation_error", "cannot transfer hidden files, the CLI's own files or the message store")
    const { head, capturedFile, ...bytes } = await retainedBytes(chosen.localPath, window, page !== undefined, deps.env)
    const mimeType = transferMime(head, null, chosen.name)
    let preview: Partial<AttachmentBytes> = {}
    if (page !== undefined) {
      if (mimeType !== "application/pdf" || !capturedFile)
        throw new CliError("validation_error", "page preview requires a retained PDF")
      const rendered = await pdfPreview(capturedFile, page, window.signal, load, deps.env)
      preview = {
        mimeType: "image/png",
        totalBytes: rendered.bytes.length,
        readBytes: rendered.bytes.length,
        offsetBytes: 0,
        nextOffsetBytes: null,
        complete: true,
        base64: rendered.bytes.toString("base64"),
        sha256: createHash("sha256").update(rendered.bytes).digest("hex"),
        pdf: {
          page: rendered.page,
          pageCount: rendered.pageCount,
          sourceSha256: bytes.sha256,
          sourceBytes: bytes.totalBytes,
        },
      }
    }
    return {
      locator: formatLocator({ ...account, chat: chatId, message: messageId }),
      attachment: chosen.position + 1,
      name: chosen.name,
      mimeType,
      ...bytes,
      ...preview,
    }
  },

  setText: async ({ chat, message, attachment, text }) => {
    if (text.trim() === "") throw new CliError("validation_error", "the text is empty — nothing to keep")
    if (text.length > MAX_TEXT_CHARS)
      throw new CliError(
        "validation_error",
        `the text is over ${MAX_TEXT_CHARS} characters — keep the part worth searching`,
      )
    const store = await deps.store()
    const account = await deps.account()
    const { chatId, messageId } = await messageOf(deps, store, account, chat, message)
    const files = (await store.attachments(account, { chatId, messageId, limit: 1000 })).filter(
      ({ kind }) => !NOT_FILES.has(kind),
    )
    if (files.length === 0)
      throw new CliError("not_found", `the local store holds no message ${messageId} with a file in chat ${chatId}`)
    const chosen =
      attachment === undefined
        ? files.length === 1
          ? files[0]
          : undefined
        : files.find(({ position }) => position === attachment - 1)
    if (!chosen) {
      throw new CliError(
        "validation_error",
        attachment === undefined
          ? `message ${messageId} has ${files.length} files — name one with --attachment (${files.map(({ position }) => position + 1).join(", ")})`
          : `message ${messageId} has no file number ${attachment} — it has ${files.map(({ position }) => position + 1).join(", ")}`,
      )
    }
    await store.keepAttachmentText(chosen.pk, { text, origin: "agent", extractor: "agent" })
    return {
      locator: formatLocator({ ...account, chat: chatId, message: messageId }),
      attachment: chosen.position + 1,
      origin: "agent",
      chars: text.length,
      replaced: chosen.text?.origin ?? null,
    }
  },
})
