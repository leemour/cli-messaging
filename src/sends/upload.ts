import { realpathSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { basename, dirname, extname, isAbsolute, relative, resolve, sep } from "node:path"
import { CliError, resolvePaths } from "@wirecat/cli-core"
import type { AppIdentity } from "../cli/app.js"
import { storePath } from "../store/path.js"

export type UploadKind = "photo" | "file" | "voice"

/** A file read for sending. Its name goes to the messenger and never to the journal. */
export interface Upload {
  kind: UploadKind
  name: string
  bytes: Uint8Array
  /** A `file` that goes as a file to download even where the messenger would play it — a video. */
  asFile?: true
}

const PHOTO = new Set([".jpg", ".jpeg", ".png", ".webp"])
const VOICE = new Set([".ogg", ".oga", ".opus"])

/** Protect known credential/state paths without refusing ordinary hidden developer folders. */
export const refusedPlace = (path: string, app: AppIdentity, env: NodeJS.ProcessEnv): boolean => {
  const own = Object.values(resolvePaths({ appName: app.appName, prefix: app.envPrefix, env }))
  // The store file and its -wal and -shm, not its folder: MESSAGING_STORE may sit in the home folder.
  const store = resolve(storePath(env))
  let ancestor = resolve(path)
  let real = ancestor
  // Downloads may create missing descendants of a symlinked directory.
  for (;;) {
    try {
      real = resolve(realpathSync(ancestor), relative(ancestor, resolve(path)))
      break
    } catch {
      const parent = dirname(ancestor)
      if (parent === ancestor) break
      ancestor = parent
    }
  }
  const credentialFolders = new Set([".ssh", ".gnupg", ".aws", ".secrets", "secrets"])
  const credentialFiles = new Set([".env", ".npmrc", ".pypirc", "credentials.yml.enc", "master.key"])
  return [resolve(path), real].some(
    (candidate) =>
      candidate
        .split(sep)
        .some(
          (part, index, parts) =>
            credentialFolders.has(part) ||
            credentialFiles.has(part) ||
            /^\.env\./.test(part) ||
            (part === ".config" && parts[index + 1] === "autostart"),
        ) ||
      own.some((dir) => inside(candidate, dir)) ||
      [store, `${store}-wal`, `${store}-shm`].includes(candidate),
  )
}

const inside = (path: string, dir: string): boolean => {
  const way = relative(resolve(dir), path)
  return way === "" || (!way.startsWith("..") && !isAbsolute(way))
}

export const readUpload = async (
  kind: UploadKind,
  path: string,
  { app, env = process.env, anyFile = false }: { app: AppIdentity; env?: NodeJS.ProcessEnv; anyFile?: boolean },
): Promise<Upload> => {
  if (kind === "photo" && !PHOTO.has(extname(path).toLowerCase())) {
    throw new CliError("validation_error", `a photo is a .jpg, .png or .webp — send ${path} as a file instead`)
  }
  if (kind === "voice" && !VOICE.has(extname(path).toLowerCase())) {
    throw new CliError("validation_error", `a voice message is Ogg Opus: .ogg, .oga or .opus — send ${path} as a file`)
  }
  if (!anyFile && refusedPlace(path, app, env)) {
    throw new CliError(
      "validation_error",
      `cannot send ${path}: known credential files, ${app.command}'s own folders and the message store ` +
        `are not sent — the owner adds --allow-any-file to \`${app.command} messages send\` if this file is meant to go`,
    )
  }
  try {
    return { kind, name: basename(path), bytes: await readFile(path) }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    const reason = code === "ENOENT" ? "no such file" : code === "EISDIR" ? "it is a folder" : "it cannot be read"
    throw new CliError("validation_error", `cannot send ${path}: ${reason}`)
  }
}

/**
 * What a send attaches, as `messages send` and its tool take it. A voice message goes alone, as the
 * messengers' own apps send one.
 */
const checkFilename = (filename: string, file: string | undefined): void => {
  if (file === undefined) throw new CliError("validation_error", "--filename names a --file; give one")
  if (filename.trim() === "" || /[/\\\0]/.test(filename) || filename.length > 255)
    throw new CliError("validation_error", "--filename is a name, not a path: no / or \\, at most 255 characters")
}

export const readAttachments = async (
  {
    photo,
    file,
    voice,
    asFile,
    filename,
    text,
  }: { photo?: string; file?: string; voice?: string; asFile?: boolean; filename?: string; text?: string },
  read: { app: AppIdentity; env?: NodeJS.ProcessEnv; anyFile?: boolean },
): Promise<Upload[]> => {
  if (voice !== undefined && (photo !== undefined || file !== undefined || (text ?? "").trim() !== "")) {
    throw new CliError("validation_error", "a voice message goes alone — no text, no file, no photo beside it")
  }
  if (asFile && file === undefined) throw new CliError("validation_error", "--as-file is about a --file; give one")
  if (filename !== undefined) checkFilename(filename, file)
  return [
    ...(photo === undefined ? [] : [await readUpload("photo", photo, read)]),
    ...(file === undefined
      ? []
      : [
          {
            ...(await readUpload("file", file, read)),
            ...(filename === undefined ? {} : { name: filename }),
            ...(asFile ? { asFile: true as const } : {}),
          },
        ]),
    ...(voice === undefined ? [] : [await readUpload("voice", voice, read)]),
  ]
}
