import { CliError } from "@wirecat/cli-core"
import type { Command } from "commander"
import { servingProfiles } from "../../background/lock.js"
import type { AdminRight, Chat, GroupSettings, Id, Provider } from "../../domain/models.js"
import { FloodMemory, floodPathFor } from "../../sends/flood.js"
import { guardFor, type SendGuard } from "../../sends/guard.js"
import { DEFAULT_PACE, type PaceRate, Pacer, pacePathFor } from "../../sends/pace.js"
import {
  assertStatsPermissionsCurrent,
  levelFor,
  type PermissionKey,
  readKeysForCommand,
} from "../../sends/permissions.js"
import { OFFLINE, type Override, type ServiceDeps, type Services, servicesFor } from "../../services/index.js"
import type { OpenRecognizer } from "../../speech/transcribe.js"
import { type AccountKey, type DeletionScope, type MessageStore, openStore } from "../../store/store.js"
import type { AppIdentity } from "../app.js"
import { type BaseContext, baseContext, environmentOf } from "../context.js"
import { knownPermissionKeys, type PermissionKeyOf, unknownPermissionKeys } from "../permission-keys.js"
import type { EventSink } from "../runs/events.js"
import type { GlobalFlags, ResolveOptions, Settings } from "../settings.js"
import { recalledAccount, rememberAccount } from "./accounts.js"
import { terminalAsker } from "./ask.js"
import { flooded } from "./flooded.js"
import { observed } from "./observed.js"
import type { MessengerAdapter } from "./port.js"
import { stored } from "./stored.js"

/** `listen` opens a connection that receives updates — only `watch` asks; the rest stay quiet. */
export interface ConnectOptions {
  listen?: boolean
  /** Fetch what arrived while nothing listened — `serve` only; `watch` starts from now. */
  catchUp?: boolean
  /** The run's diagnostics, for a messenger that reports its own wire below the adapter's calls. */
  events?: EventSink
}

export interface Fetching {
  beforeInclusive?: boolean
  /** Messages per history request. */
  page: number
  /** The most one history request returns, where the messenger is known to cap it; a larger `--page-size` is refused. */
  maxPageSize?: number
  /** The least wait between requests, as `--pause` takes it. */
  pause: string
  /** Each wait drawn between `pause` and twice that, as a person scrolls rather than a clock. */
  jitter?: boolean
  /** `store fetch` takes this many pages' worth of messages when `--limit` is not given. */
  maxPages: number
  /**
   * What a held stretch is keyed by: the message id, or its send time where ids pass 2^53 and do
   * not count messages (MAX). By time, `before` reaches the adapter as an ISO time.
   */
  orderBy?: "id" | "time"
}

/** What one messenger CLI hands the shared commands. Everything else about it stays in its own code. */
/** `messages send --spoiler` and `--caption-above`. */
export type MediaOption = "spoiler" | "captionAbove" | "fileName"

export interface Messenger {
  counterFields?: readonly import("../../domain/counters.js").CounterField[]
  app: AppIdentity
  provider: Provider
  /** The messenger's own name, as its users write it — `Telegram`, `MAX`. Defaults to the command. */
  name?: string
  /** How fast one profile may ask the messenger, across processes, unless `requestsPerMinute` says otherwise. */
  pace?: PaceRate
  resolveSettings: (flags: GlobalFlags, options?: ResolveOptions) => Settings
  /**
   * Opens a connection for the command's profile, or throws a typed error saying how to log in.
   * Called inside `--timeout`; the context tracks and closes what it returns.
   */
  connect: (command: Command, context: BaseContext, options?: ConnectOptions) => Promise<MessengerAdapter>
  /** The help for a `<chat>` argument, in this messenger's words. */
  chatArgument: string
  /** The group settings this messenger has, as `chats update` offers them; every one when unset. */
  groupSettings?: readonly (keyof GroupSettings)[]
  /**
   * The send options for attachments this messenger honours; none when unset, so an adapter that does not
   * know a newer option is never handed one to drop.
   */
  mediaOptions?: readonly MediaOption[]
  /** Whether `polls create` makes quizzes (`--quiz --correct --solution`); no when unset. */
  pollQuiz?: boolean
  /** How many seconds after sending a poll may close by itself — `polls create --close-time`; none when unset. */
  pollCloseSeconds?: readonly [min: number, max: number]
  /** Whether `polls voters` lists who voted for what; no when unset. */
  pollVoters?: boolean
  /** Whether `topics show` reads one forum topic; no when unset. */
  topicShow?: boolean
  /** Whether `messages forward --topic` forwards into a forum topic; no when unset. */
  forwardTopic?: boolean
  /** Whether folders take kinds of chat, skip muted, read or archived ones, exclude and pin chats; no when unset. */
  folderRules?: boolean
  /** Whether the messenger reads HTML in `--html`; no when unset. */
  html?: boolean
  /** Whether folder ordering is available; yes when unset. */
  folderOrder?: boolean
  /** Whether `chats update --photo` sets a group's photo; no when unset. */
  groupPhoto?: boolean
  /** Whether `chats media` lists a chat's media from the server; no when unset. */
  chatMedia?: boolean
  /** Whether `account privacy show` and `set` read and change the account's privacy; no when unset. */
  privacy?: boolean
  /** Whether `chats mute` and `unmute` exist; no when unset. */
  chatMute?: boolean
  /** Whether `chats delete` and `chats clear` exist; no when unset. */
  chatDeletion?: boolean
  /** Whether `messages press`, `chats start` and `chats app` exist — a bot met on the personal account; no when unset. */
  personalBots?: boolean
  /** Whether `messages send --sticker` sends a sticker; no when unset. `stickers list` is a group a CLI adds itself. */
  stickers?: boolean
  /** Whether shared folders can be joined; yes when unset. */
  folderJoin?: boolean
  /** Whether invite links can be listed; yes when unset. */
  inviteLinkList?: boolean
  /** Whether one invite link can be revoked; yes when unset. */
  inviteLinkRevoke?: boolean
  /** Whether one invite link can be changed — `chats link update`; no when unset. */
  inviteLinkUpdate?: boolean
  /** Whether the messenger says when an account was made — the moderation rule `newAccount`; yes when unset. */
  knowsAccountAge?: boolean
  /**
   * This messenger's invite links, which `chats moderate` judges under `invites`. Telegram's and MAX's
   * are built in for now.
   */
  inviteLinks?: RegExp
  /** Whether people added can be shown the messages from before they came — `members add --history`; yes when unset. */
  addsWithHistory?: boolean
  /** The admin rights this messenger has, as `admins add --can` offers them; every one when unset. */
  adminRights?: readonly AdminRight[]
  /** The chat `me` names, when the messenger has a notes-to-self chat. */
  savedChatId?: (account: AccountKey) => Id
  /** The other person in a one-to-one chat, when the chat says who — a recipient list matches on it. */
  partnerOf?: (chat: Chat) => Id | undefined
  /**
   * Whether a stored chat may hold a message the messenger deleted without naming its chat. When
   * unset, the store applies Telegram's rule.
   */
  deletedWithoutChat?: DeletionScope
  /** How `store fetch` reads this messenger's history, where Telegram's defaults do not fit it. */
  fetching?: Fetching
  /**
   * Where `chats`, `messages list|context` and `contacts` read from. `store` is for a messenger that
   * pushes its history instead of answering for it: those reads answer from the local store, which
   * `serve` keeps filled, and never connect; writes still do. `server` when unset.
   */
  history?: "server" | "store"
  /** Whether the messenger computes a chat's statistics for its admins — `stats chats official`; no when unset. */
  officialStats?: boolean
  /**
   * Whether `search messages --backend` is offered: the adapter has `searchMessages`. `chat` when its server
   * searches one chat at a time, so only a query that names one chat asks it. No when unset.
   */
  serverSearch?: boolean | "chat"
  /** Whether this CLI's background service fetches tracked rosters daily; true when unset. */
  tracksMembers?: boolean
  /** Speech model ids, most suitable first, for `messages transcribe --local`; the first is the default. */
  speechModels?: readonly string[]
  /** Replaces shared use cases for this messenger; its commands and MCP tools both get the replacement. */
  services?: Override
  /**
   * The send guard for a command, when the messenger's is not the profile's plain one — max-cli's
   * background server journals what it forwards, so a command over it records only its refusals.
   */
  guard?: (command: Command, settings: Settings, warn: (message: string) => void) => SendGuard
  /** The permission key of one of this CLI's own commands, when `keyForCommand` does not know it. */
  permissionKey?: PermissionKeyOf
  /** The CLI's SKILL.md, which the MCP server also serves as `<command>://skill`. */
  skill?: URL
  /** What only this messenger can say about itself for `doctor`, read from disk — never a secret. */
  diagnose?: (command: Command, context: BaseContext) => Promise<Record<string, unknown>>
}

export type ReadConnection = <T>(work: (adapter: MessengerAdapter) => Promise<T>) => Promise<T>

export interface MessengerContext extends BaseContext {
  profile: string
  stdin: NodeJS.ReadableStream & { isTTY?: boolean }
  /** The local speech recognizer, where a test hands one in. */
  recognizer?: OpenRecognizer
  /** Read-only, the allow-list, the recipient list and the hourly limit — asked before every write, told after. */
  guard: SendGuard
  /**
   * Connects inside `--timeout`, and closes on every path. What the reads answer is saved to the
   * message store, and each call is a run event.
   */
  withMessenger: <T>(work: (messenger: MessengerAdapter) => Promise<T>, options?: ConnectOptions) => Promise<T>
  /** Answers from the message store alone, for `--offline`. Never connects and needs no credentials. */
  withStore: <T>(
    work: (store: MessageStore, account: AccountKey) => Promise<T>,
    options?: { name?: string },
  ) => Promise<T>
  /** The shared use cases, over a connection and a store each opened only if a service asks for it. */
  withServices: <T>(
    work: (services: Services, connect?: ReadConnection) => Promise<T>,
    options?: { name?: string },
  ) => Promise<T>
}

/** Long enough for a local write; a store that hangs must not keep the process alive. */
const SAVES_WAIT_MS = 5_000

/** Whether every save finished within `ms`. Saves never reject: `stored` turns a failure into a warning. */
const settled = async (pending: Set<Promise<void>>, ms: number): Promise<boolean> => {
  if (pending.size === 0) return true
  let timer: NodeJS.Timeout | undefined
  const late = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), ms)
  })
  try {
    return await Promise.race([Promise.all([...pending]).then(() => true as const), late])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * A connection as every shared reader sees it: its account remembered, each call a run event, what
 * the reads answer saved to the store. `close` closes the connection and the store it opened. One
 * function, so a command and an MCP tool call save and record exactly alike.
 */
export const connected = (
  connection: MessengerAdapter,
  {
    app,
    provider,
    name,
    deletedWithoutChat,
    pace,
  }: Pick<Messenger, "app" | "provider" | "name" | "deletedWithoutChat" | "pace">,
  { settings, env, renderer }: Pick<BaseContext, "settings" | "env" | "renderer">,
  events: EventSink,
): { adapter: MessengerAdapter; close: () => Promise<void> } => {
  const self = connection.self()
  if (self !== null) rememberAccount(app, settings.profile, self, env)
  const memory = new FloodMemory(floodPathFor(app, settings.profile, env))
  const rate = {
    ...DEFAULT_PACE,
    ...pace,
    ...(settings.requestsPerMinute === undefined ? {} : { perMinute: settings.requestsPerMinute }),
  }
  const pacer = new Pacer(pacePathFor(app, settings.profile, env), rate)
  const adapter = observed(
    flooded(connection, memory, { name: name ?? app.command, warn: renderer.warn, pacer }),
    events,
  )
  let store: Promise<MessageStore | undefined> | undefined
  const pending = new Set<Promise<void>>()
  return {
    adapter:
      self === null
        ? adapter
        : stored(adapter, {
            account: { provider, account: self },
            store: () => {
              store ??= openStore({ env, command: app.command })
              return store
            },
            warn: renderer.warn,
            events,
            pending,
            ...(deletedWithoutChat ? { deletedWithoutChat } : {}),
          }),
    close: async () => {
      try {
        await connection.close()
      } finally {
        try {
          if (!(await settled(pending, SAVES_WAIT_MS))) {
            events({ event: "warning", code: "store_not_written", operation: "close" })
            renderer.warn("not saved to the local store: the last messages were still being written at exit")
          }
        } finally {
          if (store) await (await store.catch(() => undefined))?.close()
        }
      }
    },
  }
}

const unrecorded = (messenger: Messenger, profile: string): CliError =>
  new CliError(
    "not_found",
    messenger.history === "store"
      ? `nothing recorded for profile "${profile}" yet — run \`${messenger.app.command} serve\` or ` +
          `\`${messenger.app.command} watch\` once to fill the local store`
      : `nothing recorded for profile "${profile}" yet — run the command once without --offline`,
  )

/** NEED-506 A: without it, an agent cannot tell a quiet chat from a store nothing keeps up to date. */
const warnUnserved = async (
  messenger: Messenger,
  profile: string,
  { env, renderer }: Pick<BaseContext, "env" | "renderer">,
  store: MessageStore,
) => {
  if (servingProfiles(messenger.app, env).includes(profile)) return
  const account = recalledAccount(messenger.app, messenger.provider, profile, env)
  if (!account) return
  const newest = (await store.chatStats(account))
    .map((one) => one.newestAt)
    .reduce<string | null>((latest, at) => (at !== null && (latest === null || at > latest) ? at : latest), null)
  renderer.warn(
    `no \`${messenger.app.command} serve\` keeps profile "${profile}" up to date — ` +
      (newest === null ? "the local store holds no messages yet" : `the newest stored message is from ${newest}`),
  )
}

/** The words of a command below the program, `["messages", "list"]` — the profile word is not one of them. */
const pathOf = (command: Command): string[] => {
  const words: string[] = []
  for (let at: Command | null = command; at?.parent; at = at.parent) words.unshift(at.name())
  return words
}

/** `deny` stops a read too, before anything connects: what the profile may not see is never fetched. */
const refuseDenied = (command: Command, settings: Settings) => {
  assertStatsPermissionsCurrent(pathOf(command), settings.permissions)
  for (const key of readKeysForCommand(pathOf(command))) {
    const { level, key: named } = levelFor(settings.permissions, key)
    if (level !== "deny") continue
    throw new CliError(
      "permission_error",
      `profile ${settings.profile} denies ${key} (permissions.${named} is deny, from the ` +
        `${settings.permissionSources[named ?? ""] ?? "default"})`,
      { permission: key },
    )
  }
}

/**
 * A write to the local store alone. `deny` already stopped the command (`messengerContext`); `readonly`
 * stops this write too. There is no question to put to the owner here, so `ask` refuses rather than
 * writing unasked.
 */
export const refuseLocalWrite = (context: MessengerContext, command: string, permission: PermissionKey): void => {
  const { settings } = context
  const { level, key } = levelFor(settings.permissions, permission)
  if (level === "allow") return
  throw new CliError(
    level === "ask" ? "confirmation_required" : "permission_error",
    `profile ${settings.profile} does not let ${permission} write (permissions.${key} is ${level}, from the ` +
      `${settings.permissionSources[key ?? ""] ?? "default"}); to allow it: ` +
      `${command} ${settings.profile} config set permissions.${permission} allow`,
    { permission },
  )
}

export const messengerContext = (command: Command, messenger: Messenger): MessengerContext => {
  const { app, provider } = messenger
  const base = baseContext(command, messenger.resolveSettings)
  const { profile } = base.settings
  refuseDenied(command, base.settings)
  for (const key of unknownPermissionKeys(
    base.settings.permissions,
    knownPermissionKeys(command, messenger.permissionKey),
  )) {
    base.renderer.warn(`permissions.${key} names no command and does nothing — \`config unset permissions.${key}\``)
  }
  const guard =
    messenger.guard?.(command, base.settings, base.renderer.warn) ??
    guardFor(app, base.settings, base.renderer.warn, base.env, terminalAsker(command))

  return {
    ...base,
    profile,
    stdin: environmentOf(command).stdin ?? process.stdin,
    ...(environmentOf(command).recognizer ? { recognizer: environmentOf(command).recognizer } : {}),
    guard,
    withMessenger: (work, options = {}) =>
      base.run(
        async (events) => {
          if (base.settings.offline) throw new CliError("validation_error", OFFLINE)
          const connection = await messenger.connect(command, base, { ...options, events })
          base.track(connection)
          const { adapter, close } = connected(connection, messenger, base, events)
          try {
            return await work(adapter)
          } finally {
            await close()
          }
        },
        { unbounded: options.listen === true },
      ),
    withStore: (work, { name } = {}) =>
      base.run(
        async () => {
          const account = recalledAccount(app, provider, profile, base.env)
          if (!account) throw unrecorded(messenger, profile)
          const store = await openStore({ env: base.env, command: app.command })
          try {
            return await work(store, account)
          } finally {
            await store.close()
          }
        },
        name === undefined ? {} : { name },
      ),
    withServices: (work, { name } = {}) =>
      base.run(
        async (events) => {
          let held: ReturnType<typeof connected> | undefined
          let store: Promise<MessageStore> | undefined
          let released: Promise<void> | undefined
          const releaseConnection = () => (released ??= held?.close() ?? Promise.resolve())
          const deps: ServiceDeps = {
            messenger,
            profile,
            env: base.env,
            offline: base.settings.offline,
            reads: messenger.history ?? "server",
            // Turning recording off by name (--no-record, or record: false) keeps no search history either.
            history: base.settings.keepFailedRuns,
            searchCatchUp: base.settings.searchCatchUp,
            guard,
            connection: async () => {
              if (base.settings.offline) throw new CliError("validation_error", OFFLINE)
              if (released) throw new CliError("validation_error", "the read connection has already been released")
              if (!held) {
                const connection = await messenger.connect(command, base, { events })
                if (released) {
                  await connection.close()
                  throw new CliError("validation_error", "the read connection has already been released")
                }
                base.track(connection)
                held = connected(connection, messenger, base, events)
              }
              return held.adapter
            },
            account: async () => {
              const account = recalledAccount(app, provider, profile, base.env)
              if (!account) throw unrecorded(messenger, profile)
              return account
            },
            store: () => {
              store ??= openStore({ env: base.env, command: app.command }).then(async (opened) => {
                if (messenger.history === "store") await warnUnserved(messenger, profile, base, opened)
                return opened
              })
              return store
            },
          }
          try {
            return await work(servicesFor(deps), async (read) => {
              try {
                return await read(await deps.connection())
              } finally {
                await releaseConnection()
              }
            })
          } finally {
            try {
              await releaseConnection()
            } finally {
              if (store) await (await store.catch(() => undefined))?.close()
            }
          }
        },
        name === undefined ? {} : { name },
      ),
  }
}
