import { CliError, singleLine } from "@wirecat/cli-core"
import { formatLocator, parseLocator } from "./locator.js"

/**
 * One typed form for every kind of thing a link, a tag or an argument can name. The prefix makes a
 * wrong kind fail loudly instead of matching another row. Parts that are ids of someone else's system
 * are percent-encoded, as in a message locator, so no id can add a part.
 */
export type Reference =
  | { type: "message"; provider: string; account: string; chat: string; message: string }
  | { type: "chat"; provider: string; account: string; chat: string }
  | { type: "contact"; provider: string; id: string }
  | { type: SimpleReference; id: string }
  /** A notes folder, or one subfolder of it: `path` is inside the folder, `null` the folder itself. */
  | { type: "folder"; id: string; path: string | null }

/**
 * Things named by their store id (a task also by its key or the task package's id). `entity` is the name
 * before organizations and projects: it still parses, so an old file's reference resolves as not found.
 */
export const SIMPLE_REFERENCES = [
  "note",
  "document",
  "person",
  "organization",
  "project",
  "task",
  "memory",
  "decision",
  "bot",
  "entity",
] as const
export type SimpleReference = (typeof SIMPLE_REFERENCES)[number]

const parts = (rest: string, count: number, reference: string, shape: string) => {
  const split = rest.split("/")
  if (split.length !== count || split.some((part) => part === ""))
    throw new CliError("validation_error", `"${singleLine(reference)}" is not a reference — expected ${shape}`)
  return split.map(decodeURIComponent)
}

export const formatReference = (reference: Reference): string => {
  switch (reference.type) {
    case "message":
      return formatLocator(reference)
    case "chat":
      return `chat:${[reference.provider, reference.account, reference.chat].map(encodeURIComponent).join("/")}`
    case "contact":
      return `contact:${[reference.provider, reference.id].map(encodeURIComponent).join("/")}`
    case "folder":
      return reference.path === null
        ? `folder:${encodeURIComponent(reference.id)}`
        : `folder:${encodeURIComponent(reference.id)}/${encodeURIComponent(reference.path)}`
    default:
      return `${reference.type}:${reference.id}`
  }
}

export const parseReference = (text: string): Reference => {
  const reference = text.trim()
  const colon = reference.indexOf(":")
  const prefix = colon < 0 ? "" : reference.slice(0, colon)
  const rest = reference.slice(colon + 1)
  switch (prefix) {
    case "msg":
      return { type: "message", ...parseLocator(reference) }
    case "chat": {
      const [provider, account, chat] = parts(rest, 3, reference, "chat:<provider>/<account>/<chat>") as [
        string,
        string,
        string,
      ]
      return { type: "chat", provider, account, chat }
    }
    case "contact": {
      const [provider, id] = parts(rest, 2, reference, "contact:<provider>/<id>") as [string, string]
      return { type: "contact", provider, id }
    }
    case "folder": {
      const slash = rest.indexOf("/")
      const id = decodeURIComponent(slash < 0 ? rest : rest.slice(0, slash))
      const path = slash < 0 ? null : folderPath(decodeURIComponent(rest.slice(slash + 1)))
      if (!id.trim() || path === "")
        throw new CliError(
          "validation_error",
          `"${singleLine(reference)}" is not a reference — expected folder:<id>[/<path>]`,
        )
      return { type: "folder", id, path }
    }
    default:
      if ((SIMPLE_REFERENCES as readonly string[]).includes(prefix)) {
        if (!rest.trim()) throw new CliError("validation_error", `"${singleLine(reference)}" names no ${prefix}`)
        return { type: prefix as SimpleReference, id: rest }
      }
      throw new CliError(
        "validation_error",
        `"${singleLine(reference)}" is not a reference — expected msg:, chat:, contact:, folder:, ${SIMPLE_REFERENCES.filter((one) => one !== "entity").join(":, ")}:`,
      )
  }
}

/** A subfolder spelled one way: no leading, trailing or doubled slash, and `.` for the folder itself. */
const folderPath = (path: string): string | null => {
  const clean = path
    .split("/")
    .filter((part) => part !== "" && part !== ".")
    .join("/")
  return clean === "" ? (path.trim() === "" ? "" : null) : clean
}

/** The stored spelling of a reference, so two spellings of one thing compare equal. */
export const canonicalReference = (text: string): string => formatReference(parseReference(text))

// Meeting evidence is intentionally separate until every polymorphic store target supports it.
export {
  canonicalMeetingReference,
  formatMeetingReference,
  type MeetingReference,
  parseMeetingReference,
} from "./meeting-reference.js"
