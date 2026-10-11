import { lstat, readdir, realpath } from "node:fs/promises"
import { basename, join, relative, sep } from "node:path"
import { CliError } from "@wirecat/cli-core"
import type { AppIdentity } from "../cli/app.js"
import { NOT_FILES } from "../domain/attachments.js"
import { refusedPlace } from "../sends/upload.js"
import type { AccountStore } from "../store/account-store.js"
import type { AttachmentView } from "../store/store.js"

const MAX_FILES = 10_000

export const directoryPaths = async (
  store: AccountStore,
  chat: string,
  directory: string,
  app: AppIdentity,
  env: NodeJS.ProcessEnv,
) => {
  if (refusedPlace(directory, app, env))
    throw new CliError(
      "validation_error",
      "--from-dir cannot read credential folders, the CLI's own folders or the message store",
    )
  const root = await realpath(directory).catch(() => {
    throw new CliError("validation_error", "--from-dir must name an existing directory")
  })
  const names = await readdir(root).catch(() => {
    throw new CliError("validation_error", "--from-dir must name a readable directory")
  })
  if (names.length > MAX_FILES)
    throw new CliError("validation_error", "--from-dir holds too many files; use a smaller directory")
  const files = new Map<string, string>()
  for (const name of names) {
    const path = join(root, name)
    const info = await lstat(path)
    if (info.isSymbolicLink()) throw new CliError("validation_error", "--from-dir cannot read symbolic links")
    if (!info.isFile()) continue
    const canonical = await realpath(path)
    if (refusedPlace(canonical, app, env))
      throw new CliError(
        "validation_error",
        "--from-dir cannot read credential files, the CLI's own files or the message store",
      )
    const inside = relative(root, canonical)
    if (inside === ".." || inside.startsWith(`..${sep}`))
      throw new CliError("validation_error", "a file escapes --from-dir")
    files.set(name, canonical)
  }
  const held = await store.attachments({ chatId: chat, limit: MAX_FILES + 1 })
  if (held.length > MAX_FILES)
    throw new CliError(
      "validation_error",
      "this chat holds too many attachments for directory matching; use recorded download paths",
    )
  const groups = new Map<string, AttachmentView[]>()
  const counts = new Map<string, number>()
  for (const file of held.filter(({ kind }) => !NOT_FILES.has(kind))) {
    const group = groups.get(file.messageId) ?? []
    group.push(file)
    groups.set(file.messageId, group)
    if (file.name) counts.set(basename(file.name), (counts.get(basename(file.name)) ?? 0) + 1)
  }
  const choices = new Map<number, string | null>()
  for (const group of groups.values()) {
    group.sort((a, b) => a.position - b.position)
    const candidates = group.map((file, index) => {
      const prefix = `${file.messageId}-${index + 1}`
      return [...files]
        .filter(
          ([name]) =>
            name === prefix ||
            name.startsWith(`${prefix}.`) ||
            (file.name !== null && name === `${prefix}-${basename(file.name)}`),
        )
        .map(([, path]) => path)
    })
    // An incomplete ordinal set could have come from an adapter that omitted a file.
    if (candidates.some((paths) => paths.length > 1))
      throw new CliError("validation_error", "more than one directory file matches a download ordinal")
    const complete = candidates.every((paths) => paths.length === 1)
    group.forEach((file, index) => {
      const own = file.name === null ? undefined : basename(file.name)
      const named = own && counts.get(own) === 1 ? files.get(own) : undefined
      const canonical = complete ? candidates[index]?.[0] : undefined
      if (
        (named && canonical && named !== canonical) ||
        (!complete && own && files.has(own) && (counts.get(own) ?? 0) > 1)
      )
        throw new CliError(
          "validation_error",
          "directory file names are ambiguous; use complete message-prefixed downloads",
        )
      choices.set(file.pk, canonical ?? named ?? null)
    })
  }
  const uses = new Map<string, number>()
  for (const path of choices.values()) if (path) uses.set(path, (uses.get(path) ?? 0) + 1)
  if ([...uses.values()].some((count) => count > 1))
    throw new CliError("validation_error", "a directory file matches more than one attachment")
  return choices
}
