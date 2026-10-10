import { createWriteStream, mkdirSync } from "node:fs"
import { link, rm } from "node:fs/promises"
import { basename, join, resolve } from "node:path"
import { Readable, Transform } from "node:stream"
import { pipeline } from "node:stream/promises"
import { CliError } from "@wirecat/cli-core"
import type { RemoteFile } from "../cli/messenger/port.js"
import type { Id } from "../domain/models.js"
import { batchProgress } from "./batch.js"
import type { MessagesService } from "./messages.js"

export interface Saved {
  kind: string
  path: string
  bytes: number
  /** Only with `--all`: the file was already there from an earlier run, and was left as it was. */
  existing?: true
}

/**
 * The files are saved whatever happens here: a store that cannot take the paths costs only the later
 * `attachments extract`, so it warns and never fails the download.
 */
export const recordPaths = async (
  messages: Pick<MessagesService, "keepDownloaded">,
  chat: string,
  message: Id,
  files: readonly RemoteFile[],
  saved: readonly Saved[],
  warn: (message: string) => void,
  onFailure?: (error: unknown) => void,
): Promise<number> => {
  const downloaded = saved.map((one, index) => ({
    kind: one.kind,
    path: one.path,
    ...(files[index]?.name === undefined ? {} : { name: files[index]?.name }),
    ...(files[index]?.position === undefined ? {} : { position: files[index]?.position }),
  }))
  try {
    return await messages.keepDownloaded(chat, message, downloaded)
  } catch (error) {
    onFailure?.(error)
    warn(`not recorded in the local store where message ${message}'s files went: ${(error as Error).message}`)
    return 0
  }
}

/**
 * Every file of one message, as `--all` saves them — a taken name gets the message's prefix, never
 * overwrites — and where they went recorded in the store. For `attachments extract --download`.
 */
export const downloadMessage = async (
  messages: Pick<MessagesService, "download" | "keepDownloaded">,
  chat: string,
  message: Id,
  output: string,
  warn: (message: string) => void,
): Promise<Saved[]> => {
  const { files } = await messages.download(chat, message)
  mkdirSync(output, { recursive: true })
  const result = await saveFiles(messages, chat, message, files, output, { unique: true, warn })
  if (result.batch.failed > 0)
    throw new CliError("provider_error", "some attachments failed; completed downloads are retained", {
      batch: result.batch,
      saved: result.saved,
    })
  return result.saved
}

export const saveFiles = async (
  messages: Pick<MessagesService, "keepDownloaded">,
  chat: string,
  message: Id,
  files: readonly RemoteFile[],
  output: string,
  {
    unique = false,
    warn,
    onSaved,
    batch = batchProgress(),
  }: {
    unique?: boolean
    warn: (message: string) => void
    onSaved?: (saved: Saved) => void
    batch?: ReturnType<typeof batchProgress>
  },
) => {
  const saved: Saved[] = []
  const successful: RemoteFile[] = []
  for (const [index, file] of files.entries()) {
    if (batch.stopped) break
    try {
      const one = await save(file, output, `${message}-${index + 1}`, { unique })
      saved.push(one)
      successful.push(file)
      batch.ok()
      onSaved?.(one)
    } catch (error) {
      const issue = batch.fail(message, "download", error, (file.position ?? index) + 1)
      warn(
        `message ${message}, attachment ${(file.position ?? index) + 1}: ${issue.code} — ${issue.actions.map((action) => action.message).join(" ")}`,
      )
    }
  }
  await recordPaths(messages, chat, message, successful, saved, warn, (error) =>
    batch.fail(message, "record_downloads", error),
  )
  return { saved, batch: batch.result() }
}

const EXTENSIONS: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "video/mp4": "mp4",
  "video/webm": "webm",
  "audio/mpeg": "mp3",
  "audio/ogg": "ogg",
  "audio/mp4": "m4a",
  "application/pdf": "pdf",
}

/** Telegram sends a photo with no name and no type; it is always a JPEG. */
const BY_KIND: Record<string, string> = { photo: "jpg" }

/**
 * A name another person chose cannot climb out of the folder, cannot be a dot file we would then
 * hide, and carries no control or direction character to rewrite the terminal or disguise its extension.
 */
export const safeName = (name: string | undefined, platform = process.platform): string | undefined => {
  let plain =
    name === undefined
      ? ""
      : basename(name.replaceAll("\\", "/"))
          .replace(/[\p{Cc}​-‏‪-‮⁦-⁩]/gu, "")
          .replace(/^\.+/, "")
  if (platform === "win32") {
    plain = plain.replace(/[<>:"|?*]/g, "_").replace(/[. ]+$/, "")
    if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(plain)) return undefined
  }
  return plain === "" ? undefined : plain
}

/**
 * The bytes go to a temporary name first and are then hard-linked to the real one, which fails if the
 * name is taken — so an existing file survives, and an interrupted download leaves no half file under
 * the name somebody will open.
 *
 * `unique` is for a whole chat, where two messages often carry the same file name: a taken name gets the
 * message's own prefix, and when that is taken too the file was saved by an earlier run and is `existing`.
 */
export const save = async (
  file: RemoteFile,
  directory: string,
  fallbackName: string,
  { unique = false }: { unique?: boolean } = {},
): Promise<Saved> => {
  const own = safeName(file.name)
  const fileName = () => {
    const extension = EXTENSIONS[file.mime ?? ""] ?? BY_KIND[file.kind]
    return own ?? (extension ? `${fallbackName}.${extension}` : fallbackName)
  }
  const partial = join(directory, `.${fileName()}.${process.pid}.part`)
  let bytes = 0
  const counting = new Transform({
    transform(chunk: Uint8Array, _encoding, done) {
      bytes += chunk.length
      done(null, chunk)
    },
  })
  try {
    await pipeline(Readable.from(file.bytes()), counting, createWriteStream(partial, { flags: "wx", mode: 0o600 }))
    // Lazy HTTP downloads learn MIME while reading bytes.
    const name = fileName()
    const names = unique && own ? [name, `${fallbackName}-${own}`] : [name]
    for (const candidate of names) {
      const path = resolve(join(directory, candidate))
      const taken = await link(partial, path).then(
        () => false,
        (error: NodeJS.ErrnoException) => {
          if (error.code === "EEXIST") return true
          throw error
        },
      )
      if (!taken) return { kind: file.kind, path, bytes }
    }
    const path = resolve(join(directory, names.at(-1) ?? name))
    if (unique) return { kind: file.kind, path, bytes, existing: true }
    throw new CliError("validation_error", `${path} already exists — nothing was overwritten; choose --output-dir`)
  } finally {
    await rm(partial, { force: true })
  }
}
