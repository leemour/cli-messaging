import { randomUUID } from "node:crypto"
import { CliError } from "@wirecat/cli-core"
import type { AppIdentity } from "../cli/app.js"
import type { Settings } from "../cli/settings.js"
import type { Id } from "../domain/models.js"
import { FloodMemory, floodPathFor } from "./flood.js"
import {
  type AccountAction,
  type ChatAction,
  type SendEntry,
  SendJournal,
  type SendKind,
  sendsPathFor,
} from "./journal.js"
import {
  keyForWrite,
  type Level,
  levelFor,
  type Permission,
  type PermissionKey,
  permissionFor,
  skipFlagFor,
} from "./permissions.js"
import { RecipientList, recipientsPathFor } from "./recipients.js"

const HOUR_MS = 60 * 60 * 1000

/** One write, as the guard is asked about it. `personIds` are checked and never journaled. */
export interface GuardRequest {
  /** `null` for a chat that does not exist yet — joining or creating one — or for the account itself: no list can name either. */
  chatId: Id | null
  kind?: SendKind
  action?: ChatAction | AccountAction
  /** Messages a deletion names, or people a chat change adds. */
  count?: number
  sendId?: string
  sendAs?: Id
  operationId?: string
  scheduledFor?: string
  notify?: boolean
  personIds?: Id[]
  forEveryone?: boolean
  /** The command path, where the kind alone does not say it — a poll's vote is not a reaction's. */
  key?: PermissionKey
}

/**
 * Asked when a write's level is `ask`: resolves when the owner said yes — a flag, or an answer at
 * the terminal — and rejects with `confirmation_required` or `cancelled` otherwise.
 */
export type Asker = (key: PermissionKey, request: GuardRequest) => Promise<void>

/** What `MaxClient.messages.send` asks before it sends, and tells after — on every outcome. */
export interface SendGuard {
  /**
   * Refuses, or lets the write through. One that counts toward the limit is also given a place in
   * the journal under a lock, unless `reserve` is false — over a background server, the server holds it.
   */
  check(request: GuardRequest, options?: { reserve?: boolean }): void
  /**
   * The question a write at level `ask` needs, before `check`: `check` refuses such a write unless
   * this request was answered yes, so a caller that skips it is refused rather than let through.
   */
  ask?(request: GuardRequest): Promise<void>
  record(entry: Omit<SendEntry, "at" | "profile">): void
}

export interface SendGuardOptions {
  profile: string
  /** The program's word, for the hints that say what to type; the recipient list's when not given. */
  command?: string
  readOnly: boolean
  /** Named in the refusal, so the owner can find what decided it. */
  readOnlyFrom: string
  /** `undefined` allows every action; a list only those (`CLI-37`). */
  allow?: readonly Permission[]
  allowFrom?: string
  /** The command that changes `allow`, when the CLI's configuration has more places than profiles and defaults. */
  allowFix?: string
  /**
   * The levels by command path, defaults included. Without it, `readOnly` and `allow` alone decide
   * and nothing asks — the guard a CLI built before levels existed.
   */
  permissions?: Readonly<Record<PermissionKey, Level>> | (() => Readonly<Record<PermissionKey, Level>>)
  permissionSources?: Readonly<Record<PermissionKey, string>>
  permissionDefaults?: Readonly<Record<PermissionKey, Level>>
  permissionFix?: (request: GuardRequest, key: PermissionKey) => string
  ask?: Asker
  sendsPerHour: number
  journal: SendJournal
  recipients: RecipientList
  /** Where a messenger's "this account may not write" is remembered; without it nothing is held. */
  flood?: FloodMemory
  warn: (message: string) => void
  now?: () => Date
}

type Counted = Pick<SendEntry, "kind" | "action" | "notify" | "count" | "people">

/**
 * What puts something in front of somebody (max-cli `NEED-168`, widened by `NEED-282`). A message, a
 * forward, an edit, a pin that notifies, a new group and people added to one all do. A reaction,
 * a quiet pin or a change of title wakes nobody. A deletion wakes nobody either, but many at once
 * is what a ban for automation looks like. An accepted join request adds a person, as `members.add` does.
 * Joining chats and importing phone numbers in bulk wake nobody either, but are what spam accounts do first.
 */
const countsTowardLimit = ({ kind = "message", action, notify }: Counted) =>
  kind === "message" ||
  kind === "forward" ||
  kind === "edit" ||
  kind === "delete" ||
  (kind === "pin" && notify === true) ||
  action === "create" ||
  action === "members.add" ||
  action === "requests.accept" ||
  action === "join" ||
  action === "contact-import"

/**
 * Each deleted message, each person added to a group or let in by a request, and each imported number
 * counts as one.
 */
const weightOf = ({ kind, action, count, people }: Counted): number =>
  kind === "delete"
    ? (count ?? 1)
    : action === "create" || action === "members.add" || action === "requests.accept" || action === "contact-import"
      ? Math.max(1, people ?? count ?? 1)
      : 1

/** A scheduled message counts in the hour the provider sends it. */
const timeOf = (entry: Pick<SendEntry, "at" | "scheduledFor">): number => Date.parse(entry.scheduledFor ?? entry.at)

/**
 * These stop a model that was talked into sending by a message it read. They do **not** stop an
 * agent that edits the configuration itself — that needs a boundary outside this process
 * (`docs/security.md`).
 */
export const sendGuard = ({
  profile,
  recipients,
  command = recipients.command,
  readOnly,
  readOnlyFrom,
  allow,
  allowFrom = "default",
  allowFix,
  permissions,
  permissionSources = {},
  permissionDefaults,
  permissionFix,
  ask = refuseToAsk,
  sendsPerHour,
  journal,
  flood,
  warn,
  now = () => new Date(),
}: SendGuardOptions): SendGuard => {
  const currentPermissions = () => (typeof permissions === "function" ? permissions() : permissions)
  let reservation: string | undefined
  const answered = new WeakSet<GuardRequest>()

  const permitted = (request: GuardRequest) => {
    const { chatId, kind = "message", action, personIds } = request
    const levels = currentPermissions()
    if (levels === undefined) {
      if (readOnly) {
        throw new CliError(
          "permission_error",
          `profile ${profile} is read-only (readOnly, from the ${readOnlyFrom}) — it cannot send, react, change chats or change the account`,
        )
      }
      const permission = permissionFor(kind, action)
      if (allow && !allow.includes(permission)) {
        const fix =
          allowFix ??
          (allowFrom === "config defaults"
            ? `${command} config set --defaults allow`
            : `${command} ${profile} config set allow`)
        throw new CliError(
          "permission_error",
          `profile ${profile} does not allow ${permission} (allow: ${allow.join(", ") || "nothing"} — from the ${allowFrom}); ` +
            `to allow it: ${fix} ${[...allow, permission].join(",")}`,
          { permission },
        )
      }
    } else {
      const key = request.key ?? keyForWrite(kind, action)
      const { level, key: named } = levelFor(levels, key, permissionDefaults)
      if (level === "deny" || level === "readonly") {
        const fix = permissionFix?.(request, key) ?? `${command} ${profile} config set permissions.${key} allow`
        throw new CliError(
          "permission_error",
          `profile ${profile} does not let ${key} write (permissions.${named} is ${level}, from the ` +
            `${permissionSources[named ?? ""] ?? "default"}); to allow it: ${fix}`,
          { permission: key },
        )
      }
      if (level === "ask" && !answered.has(request)) {
        throw new CliError("confirmation_required", `${key} asks before it acts, and it was not asked`)
      }
    }

    const allowed = recipients.read()
    if (chatId !== null && allowed && !allowed.some((chat) => chat.id === chatId)) {
      throw new CliError(
        "confirmation_required",
        `chat ${chatId} is not on the recipient list of profile ${profile} — ` +
          `the owner adds it with \`${command} ${profile} recipients add ${chatId}\``,
        { chatId },
      )
    }
    // Adding somebody to a group writes to them as surely as a message does.
    const strangers = allowed ? (personIds ?? []).filter((id) => !allowed.some((chat) => chat.partnerId === id)) : []
    if (strangers.length > 0) {
      throw new CliError(
        "confirmation_required",
        `${strangers.join(", ")} ${strangers.length === 1 ? "is" : "are"} not on the recipient list of profile ${profile} — ` +
          `the owner adds the one-to-one chat with each person (\`${command} ${profile} recipients add <chat>\`); ` +
          "a chat added to the list earlier is added again to be recognised",
        { personIds: strangers },
      )
    }
  }

  const withinLimit = (request: GuardRequest, entries: SendEntry[]) => {
    const { chatId, sendId } = request
    const asked = { ...request, people: request.personIds?.length ?? request.count }
    const count = weightOf(asked)
    if (count > sendsPerHour) {
      throw new CliError(
        "rate_limited",
        `${count} at once is more than the hourly limit of profile ${profile} (sendsPerHour ${sendsPerHour}) — ` +
          "do fewer at a time",
      )
    }

    const at = request.scheduledFor ? Date.parse(request.scheduledFor) : now().getTime()
    const counted = entries
      .filter(countsTowardLimit)
      .filter(
        (entry) => entry.outcome === "sent" || entry.outcome === "outcome_unknown" || entry.outcome === "reserved",
      )
      .filter((entry) => Math.abs(timeOf(entry) - at) < HOUR_MS)
    // A retry of a send whose outcome was unknown repeats its send id in the same chat, and the
    // provider delivers one message for both. Only that: an id that was sent, or another chat, is a new send.
    const unsure = (entry: SendEntry) => entry.outcome === "outcome_unknown"
    const same = (a: SendEntry, b: { chatId: Id | null; sendId?: string }) =>
      a.sendId !== undefined && a.sendId === b.sendId && a.chatId === b.chatId
    const last = [...counted].reverse().find((entry) => same(entry, { chatId, sendId }))
    if (sendId !== undefined && last && unsure(last)) {
      if (last.sendAs !== request.sendAs) {
        throw new CliError(
          "validation_error",
          "this send id was tried under another identity; repeat it with the same --send-as, or it may post twice",
          { sendId, retryable: false },
        )
      }
      return false
    }
    const recent = counted
      .filter((entry, index) => !(unsure(entry) && counted.slice(index + 1).some((later) => same(later, entry))))
      .map((entry) => ({ time: timeOf(entry), weight: weightOf(entry) }))
      .sort((a, b) => a.time - b.time)
    const used = recent.reduce((sum, { weight }) => sum + weight, 0)
    if (used + count > sendsPerHour) {
      // The limit may have been lowered below what the last hour already holds: it opens when
      // enough of it has aged out, not when the oldest has.
      let freed = 0
      const opening = recent.find(({ weight }) => {
        freed += weight
        return used - freed + count <= sendsPerHour
      })
      const nextMs = (opening?.time ?? 0) + HOUR_MS
      const next = new Date(nextMs).toISOString()
      throw new CliError(
        "rate_limited",
        `profile ${profile} has sent ${used} messages in the hour around ${new Date(at).toISOString()}, and its limit is ` +
          `${sendsPerHour} (sendsPerHour) — the next send is possible at ${next}`,
        { retryAfterMs: nextMs - now().getTime(), retryAt: next },
      )
    }
    return true
  }

  return {
    ask: async (request) => {
      const levels = currentPermissions()
      if (levels === undefined) return
      const key = request.key ?? keyForWrite(request.kind ?? "message", request.action)
      if (levelFor(levels, key, permissionDefaults).level !== "ask") return
      await ask(key, request)
      answered.add(request)
    },

    check: (request, { reserve = true } = {}) => {
      permitted(request)
      const asked = { ...request, people: request.personIds?.length ?? request.count }
      const creatingTopic = request.kind === "chat" && request.action === "topic-create"
      if (!countsTowardLimit(asked) && !creatingTopic) return
      const block = flood?.sendBlock()
      if (block) {
        throw new CliError(
          "permission_error",
          `profile ${profile} holds its writes until ${block.until}: ${block.hint} — reads still work; ` +
            `do not retry: the owner checks the account with \`${command} ${profile} doctor --online\`, and lifts the ` +
            `hold with \`${command} ${profile} flood clear\` once it is over`,
          { sendBlock: block, standing: { state: block.state, hint: block.hint } },
        )
      }
      const checked = (entries: SendEntry[]) => {
        if (!creatingTopic) return withinLimit(request, entries)
        if (request.sendId === undefined) throw new CliError("validation_error", "a topic creation needs an attempt id")
        if (
          entries.some(
            (entry) =>
              entry.action === "topic-create" &&
              entry.sendId === request.sendId &&
              ["sent", "outcome_unknown", "reserved"].includes(entry.outcome),
          )
        ) {
          throw new CliError(
            "validation_error",
            "this topic creation was already attempted; check topics list and do not repeat an unknown creation",
            { sendId: request.sendId, retryable: false },
          )
        }
        return true
      }
      if (!reserve) {
        checked(journal.entries())
        return
      }
      journal.locked(() => {
        if (!checked(journal.entries())) return
        const id = randomUUID()
        const { chatId, kind, action, sendId, operationId, scheduledFor, notify } = request
        journal.append({
          at: now().toISOString(),
          profile,
          chatId,
          outcome: "reserved",
          reservation: id,
          ...(kind ? { kind } : {}),
          ...(action ? { action } : {}),
          ...(asked.people === undefined ? {} : kind === "delete" ? { count: asked.people } : { people: asked.people }),
          ...(sendId === undefined ? {} : { sendId }),
          ...(operationId === undefined ? {} : { operationId }),
          ...(scheduledFor ? { scheduledFor } : {}),
          ...(notify === undefined ? {} : { notify }),
        })
        reservation = id
      })
    },

    // After a send, a failure to write here must not become the command's answer: the message is
    // already with a person, and an error would invite the caller to send it again.
    record: (entry) => {
      const { personIds: _, ...kept } = entry as typeof entry & { personIds?: Id[] }
      const settles = entry.outcome === "refused" ? undefined : reservation
      reservation = undefined
      try {
        journal.append({ at: now().toISOString(), profile, ...kept, ...(settles ? { reservation: settles } : {}) })
      } catch (error) {
        warn(`this send is not in the send journal: ${error instanceof Error ? error.message : String(error)}`)
      }
    },
  }
}

const refuseToAsk: Asker = async (key) => {
  throw new CliError(
    "confirmation_required",
    `${key} asks before it acts (its permission level is ask), and nobody is here to answer — ` +
      `add ${skipFlagFor(key)} to go ahead`,
  )
}

/**
 * The guard a profile's configuration asks for — the command's, and a background server's for every
 * write it forwards. Built per request there, so `config set readOnly true` needs no restart.
 */
export const guardFor = (
  app: AppIdentity,
  settings: Settings,
  warn: (message: string) => void,
  env: NodeJS.ProcessEnv = process.env,
  ask?: Asker,
): SendGuard =>
  sendGuard({
    profile: settings.profile,
    command: app.command,
    readOnly: settings.readOnly,
    readOnlyFrom: settings.sources.readOnly ?? "default",
    ...(settings.allow ? { allow: settings.allow, allowFrom: settings.sources.allow ?? "default" } : {}),
    permissions: () => settings.permissions,
    permissionSources: settings.permissionSources,
    ...(ask ? { ask } : {}),
    sendsPerHour: settings.sendsPerHour,
    journal: new SendJournal(sendsPathFor(app, settings.profile, env)),
    recipients: new RecipientList(recipientsPathFor(app, settings.profile, env), app.command),
    flood: new FloodMemory(floodPathFor(app, settings.profile, env)),
    warn,
  })

/**
 * Over a background server, the server journals what it forwards, with the outcome it saw; the command
 * writes only the refusals of its own check, which never reached the server.
 */
export const sharedJournal = (guard: SendGuard, wire: { readonly journals: boolean } | undefined): SendGuard =>
  wire
    ? {
        // The check comes before the connection, when `journals` cannot tell yet; the server
        // reserves under its own lock, and a command that falls back to its own socket goes unreserved.
        check: (request) => guard.check(request, { reserve: false }),
        ...(guard.ask ? { ask: guard.ask } : {}),
        record: (entry) => {
          if (entry.outcome === "refused" || !wire.journals) guard.record(entry)
        },
      }
    : guard
