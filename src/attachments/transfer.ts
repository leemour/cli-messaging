import { createHash } from "node:crypto"
import { constants } from "node:fs"
import { lstat, open } from "node:fs/promises"
import { CliError } from "@wirecat/cli-core"
import { attachmentMaxBytes } from "./limits.js"

export const MAX_CHUNK_BYTES = 1024 * 1024
export interface ByteWindow {
  offsetBytes?: number
  chunkBytes?: number
  ifSha256?: string
  signal?: AbortSignal
}
export const validateWindow = ({ offsetBytes = 0, chunkBytes = 524288, ifSha256 }: ByteWindow) => {
  if (
    !Number.isSafeInteger(offsetBytes) ||
    offsetBytes < 0 ||
    !Number.isSafeInteger(chunkBytes) ||
    chunkBytes < 1 ||
    chunkBytes > MAX_CHUNK_BYTES ||
    (ifSha256 !== undefined && !/^[a-f0-9]{64}$/i.test(ifSha256))
  )
    throw new CliError(
      "validation_error",
      "use a nonnegative byte offset, a chunk of 1–1048576 bytes and a SHA-256 hash",
    )
  return { offsetBytes, chunkBytes }
}

/** Hash and capture the requested bytes in one bounded pass; never return a filesystem path. */
export const retainedBytes = async (
  path: string,
  options: ByteWindow,
  captureFile = false,
  env: NodeJS.ProcessEnv = process.env,
) => {
  const maxBytes = attachmentMaxBytes(env)
  const { offsetBytes, chunkBytes } = validateWindow(options)
  const cancelled = () => {
    if (options.signal?.aborted) throw new CliError("cancelled", "file transfer cancelled")
  }
  cancelled()
  try {
    const before = await lstat(path)
    if (!before.isFile() || before.isSymbolicLink())
      throw new CliError("validation_error", "the retained attachment must be a regular file")
    if (before.size > maxBytes)
      throw new CliError(
        "validation_error",
        `the retained attachment exceeds ${maxBytes / 1024 / 1024} MiB; configure MESSAGING_ATTACHMENT_MAX_MIB`,
      )
    if (offsetBytes > before.size)
      throw new CliError("validation_error", "the byte offset is past the end of this attachment")
    const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
    try {
      const opened = await handle.stat()
      if (!opened.isFile() || opened.ino !== before.ino || opened.dev !== before.dev || opened.size !== before.size)
        throw new CliError("validation_error", "the retained attachment changed; restart its transfer")
      const bytes = Buffer.alloc(Math.min(chunkBytes, opened.size - offsetBytes))
      const capturedFile = captureFile ? Buffer.alloc(opened.size) : undefined
      const head = Buffer.alloc(32)
      const hash = createHash("sha256")
      let seen = 0
      let copied = 0
      const scratch = Buffer.alloc(65536)
      while (true) {
        cancelled()
        const { bytesRead } = await handle.read(scratch, 0, scratch.length, seen)
        if (bytesRead === 0) break
        const chunk = scratch.subarray(0, bytesRead)
        if (seen + chunk.length > maxBytes || seen + chunk.length > opened.size)
          throw new CliError("validation_error", "the retained attachment changed; restart its transfer")
        hash.update(chunk)
        if (capturedFile) chunk.copy(capturedFile, seen)
        if (seen < head.length) chunk.copy(head, seen, 0, Math.min(chunk.length, head.length - seen))
        const start = Math.max(0, offsetBytes - seen)
        const end = Math.min(chunk.length, offsetBytes + bytes.length - seen)
        if (end > start) copied += chunk.copy(bytes, seen + start - offsetBytes, start, end)
        seen += chunk.length
      }
      cancelled()
      const after = await handle.stat()
      if (
        seen !== opened.size ||
        copied !== bytes.length ||
        after.size !== opened.size ||
        after.mtimeMs !== opened.mtimeMs ||
        after.ctimeMs !== opened.ctimeMs
      )
        throw new CliError("validation_error", "the retained attachment changed; restart its transfer")
      const sha256 = hash.digest("hex")
      if (options.ifSha256 !== undefined && options.ifSha256.toLowerCase() !== sha256)
        throw new CliError("validation_error", "the attachment SHA-256 changed; restart its transfer")
      return {
        totalBytes: seen,
        sha256,
        offsetBytes,
        readBytes: bytes.length,
        nextOffsetBytes: offsetBytes + bytes.length < seen ? offsetBytes + bytes.length : null,
        complete: offsetBytes === 0 && bytes.length === seen,
        base64: bytes.toString("base64"),
        head,
        capturedFile,
      }
    } finally {
      await handle.close()
    }
  } catch (error) {
    if (error instanceof CliError) throw error
    cancelled()
    throw new CliError("not_found", "the retained attachment cannot be read; download it again")
  }
}

export const transferMime = (head: Buffer, hint: string | null, name: string | null = null): string => {
  if (head.subarray(0, 5).toString() === "%PDF-") return "application/pdf"
  if (head.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png"
  if (head[0] === 255 && head[1] === 216 && head[2] === 255) return "image/jpeg"
  if (head.subarray(0, 4).toString() === "RIFF" && head.subarray(8, 12).toString() === "WEBP") return "image/webp"
  const extension = name?.split(".").pop()?.toLowerCase()
  const known: Record<string, string> = {
    txt: "text/plain",
    csv: "text/csv",
    json: "application/json",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    epub: "application/epub+zip",
  }
  if (hint === null && extension !== undefined && known[extension] !== undefined) return known[extension]
  return hint !== null && /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(hint) ? hint : "application/octet-stream"
}
