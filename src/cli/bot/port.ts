import type { Command } from "commander"
import type { MarkdownFormatting, TextSpan } from "../../domain/formatting.js"
import type { Markup } from "../../domain/markdown.js"
import type {
  AdminRight,
  Chat,
  ChatKind,
  GroupMember,
  Id,
  Member,
  Message,
  MessageEvent,
  Provider,
} from "../../domain/models.js"
import type { RunBotCommand } from "../../mcp/bot/server.js"
import type { BotTool } from "../../mcp/bot/tools.js"
import type { GuardRequest } from "../../sends/guard.js"
import type { Upload } from "../../sends/upload.js"
import type { PersonFacts, StoredHit } from "../../store/index.js"
import type { AppIdentity } from "../app.js"
import type { Fetching } from "../messenger/context.js"
import type { MessagePins, MessengerCore } from "../messenger/port.js"
import type { EventSink } from "../runs/events.js"
import type { GlobalFlags, ResolveOptions, Settings } from "../settings.js"
import type { ChatRegistry } from "./registry.js"
import type { BotTokenStore } from "./token.js"

/**
 * A chat as a bot command names it, resolved: a chat id, or `user:<id>` for the dialog with a person —
 * MAX's Bot API writes to a person by user id, and Telegram's chat id for a dialog is the person's id.
 */
export type BotChatRef = string

/** How one bot message goes. A bot send is never repeated — neither Bot API makes a repeat safe — so it has no send id. */
export interface BotSendOptions {
  /** A message id in the same chat. */
  replyTo?: Id
  silent?: boolean
  /** Spans of `text`, from `--md`. */
  markup?: Markup[]
  formatting?: TextSpan[]
  /** `text` is the messenger's HTML. */
  html?: boolean
  attachments?: Upload[]
}

/** Sending, changing and deleting the bot's messages. */
export interface BotMessaging {
  send(chat: BotChatRef, text: string, options: BotSendOptions): Promise<Message>
  edit(
    chat: BotChatRef,
    messageId: Id,
    text: string,
    options: { markup?: Markup[]; formatting?: TextSpan[]; html?: boolean },
  ): Promise<Message>
  delete(chat: BotChatRef, messageIds: Id[]): Promise<void>
}

/** Reading from the messenger, where its Bot API allows it — MAX's does, Telegram's does not. */
export interface BotHistory {
  /** The newest `limit`, oldest first. */
  history(chat: BotChatRef, window: { limit: number }): Promise<Message[]>
  message(chat: BotChatRef, messageId: Id): Promise<Message>
  /** Everything sent at `since` (ms) or later, oldest first, up to `limit`; `more` when there was more. */
  historySince(chat: BotChatRef, since: number, limit: number): Promise<{ messages: Message[]; more: boolean }>
  /** One page back from `before` (or from now), newest first: what `bot store fetch` walks. */
  historyBefore(
    chat: BotChatRef,
    window: { limit: number; before?: string },
  ): Promise<{ items: Message[]; hasMore: boolean }>
}

/** Who wrote what the adapter read, with what a `Message` has no field for. */
export interface BotPeople {
  /** The senders of the messages decoded since the last call — their handle and whether each is a bot — for the local copy. */
  senders(): PersonFacts[]
}

/** What a bot shows in a chat while it works. */
export const BOT_ACTIONS = ["typing", "photo", "video", "voice", "file"] as const
export type BotAction = (typeof BOT_ACTIONS)[number]

/** One chat the bot is in. */
export interface BotChatTools {
  chat(chat: BotChatRef): Promise<Chat>
  /** Only an admin of the chat can bring the bot back. */
  leave(chat: BotChatRef): Promise<void>
  action(chat: BotChatRef, action: BotAction): Promise<void>
}

/** An admin of a chat, and what they may do. */
export interface BotChatAdmin extends Member {
  role: "owner" | "admin"
  /** In the shared words; a right the messenger has and these words lack is left out. */
  rights: AdminRight[]
  /** The title shown beside their name, when they have one. */
  title: string | null
}

/** Who runs a chat the bot is an admin in. */
export interface BotChatAdmins {
  admins(chat: BotChatRef): Promise<BotChatAdmin[]>
  /** A right this messenger lacks is refused, never dropped. */
  addAdmin(chat: BotChatRef, person: Id, rights: AdminRight[], options: { title?: string }): Promise<void>
  /** They stay a member. */
  removeAdmin(chat: BotChatRef, person: Id): Promise<void>
}

/** Taking people out of a chat the bot is an admin in. */
export interface BotChatMembers {
  /** Their messages stay; `block` also keeps them from coming back by the chat's link. */
  removeMember(chat: BotChatRef, person: Id, options: { block: boolean }): Promise<void>
}

/** One command in the menu people see when they type `/`. */
export interface BotMenuEntry {
  /** Without the `/`. */
  name: string
  description: string | null
}

/** The bot's command menu. */
export interface BotMenu {
  menu(): Promise<BotMenuEntry[]>
  /** Replaces the whole menu; an empty list clears it. */
  setMenu(entries: BotMenuEntry[]): Promise<void>
}

/** Where a pressed button was, as `bot watch` kept it. */
export interface BotPress {
  chatId: Id
  messageId: Id
}

/** Answering a button someone pressed under the bot's message. */
export interface BotCallbacks {
  /**
   * `notification` is shown to the person who pressed; `text` replaces the message the button was
   * on. `press` is where that was, when `bot watch` kept it — a messenger that cannot find the
   * message from the callback id alone needs it for `text`.
   */
  answer(callbackId: string, answer: { notification?: string; text?: string; press?: BotPress }): Promise<void>
}

/** An address the messenger pushes this bot's updates to. */
export interface BotWebhook {
  url: string
  /** The update types it gets, in the messenger's words; `null` is all of them. */
  types: string[] | null
}

/** While a webhook is set, the messenger gives polling nothing. */
export interface BotWebhooks {
  webhooks(): Promise<BotWebhook[]>
  setWebhook(url: string, options: { types?: string[]; secret?: string }): Promise<void>
  deleteWebhook(url: string): Promise<void>
}

/** What happened in the bot's chats besides messages: a button, people coming and going, a start. */
export type BotNotice =
  | {
      event: "callback"
      callbackId: string
      chatId: Id | null
      messageId: Id | null
      from: Member | null
      data: string
    }
  /** `at` is when it happened, ISO 8601, where the messenger says — `watch` may print it long after. */
  | { event: "joined" | "left" | "added" | "removed"; chatId: Id; person: Member | null; at?: string }
  | { event: "started"; chatId: Id | null; person: Member | null }
  /** An update this adapter does not decode, under the messenger's own type name. */
  | { event: "other"; type: string; chatId: Id | null }

/** The messenger's own id for the update an event came in, so `bot watch` can recognise a redelivery. */
export interface BotUpdateRef {
  id: string
  /** The update's type, in the messenger's words. */
  kind: string
}

/** One update as `bot watch` prints it; without `update`, a redelivery is printed and kept again. */
export type BotEvent = (MessageEvent | BotNotice) & { update?: BotUpdateRef }

export interface BotUpdatesPage {
  events: BotEvent[]
  /** Where the next call starts; the same as given when nothing came. Opaque to the caller. */
  cursor: string | undefined
}

/** Taking the bot's updates by polling. A call waits up to `waitSeconds` for the first one. */
export interface BotUpdates {
  updates(
    cursor: string | undefined,
    options: { types?: string[]; waitSeconds: number; signal: AbortSignal },
  ): Promise<BotUpdatesPage>
}

/**
 * The part of the personal core a bot can do, and the groups its Bot API has. A bot never gets
 * `chats` from this type: neither Bot API lists a bot's chats.
 */
export type BotAdapter = Pick<MessengerCore, "me" | "close"> &
  Partial<MarkdownFormatting> &
  Partial<BotNativeApi> &
  Partial<BotMessaging> &
  Partial<BotHistory> &
  Partial<MessagePins> &
  Partial<BotChatTools> &
  Partial<BotChatAdmins> &
  Partial<BotChatMembers> &
  Partial<BotMenu> &
  Partial<BotCallbacks> &
  Partial<BotWebhooks> &
  Partial<BotUpdates> &
  Partial<BotPeople>

export interface BotNativeApi {
  api(
    method: string,
    input: {
      body?: string
      files: readonly { field: string; name: string; bytes: Uint8Array }[]
      secrets: readonly string[]
    },
    options: { reads: boolean; timeoutMs?: number },
  ): Promise<unknown>
}

export interface BotConnectOptions {
  stop?: AbortSignal
  events?: EventSink
  /** Only `bot store fetch` asks for a history reader; other commands stay on the Bot API. */
  history?: { from?: string; pauseMs: number }
  /** Register a connection before its login can block, so the command deadline can close it. */
  track?: (client: Pick<BotAdapter, "close">) => void
}

/** What one messenger CLI hands the shared bot commands. */
export interface BotMessenger {
  app: AppIdentity
  /** How the store tells this messenger's bots from its personal accounts: it ends in `-bot` — `max-bot`, `telegram-bot`. */
  provider: Provider
  /** The messenger's own name, as its users write it — `MAX`, `Telegram`. */
  name?: string
  /** The admin rights `--can` offers; every shared one when unset. */
  adminRights?: readonly AdminRight[]
  /** Whether `bot webhooks set --add` keeps the other addresses; a messenger with one address has no `--add`. */
  manyWebhooks?: boolean
  /** Mount shared bot me; consumers with an existing response migrate explicitly. */
  identity?: boolean
  /**
   * Called by `bot watch` with each batch, after the copy took it and before it is printed. A throw
   * holds the cursor, so the batch comes again — keep what it writes safe to write twice.
   */
  keepUpdates?: (command: Command, profile: string, events: readonly BotEvent[]) => void
  /** Who joined a chat at `since` (ms) or later, from what `keepUpdates` kept; `undefined` when nothing was ever kept. */
  joinsSince?: (command: Command, profile: string, chatId: Id, since: number) => GroupMember[] | undefined
  /** Called with `kind: "bot"`. */
  resolveSettings: (flags: GlobalFlags, options?: ResolveOptions) => Settings
  /**
   * A client for this token. `stop` ends a command that runs until told to, and its request in
   * flight; `events` is the run's, for each request's trace line and record.
   */
  connect: (command: Command, token: string, options?: BotConnectOptions) => Promise<BotAdapter>
  /** Where the token lives; the shared `BotTokenStore` when unset. A CLI's tests put their own here. */
  tokenStore?: (command: Command, profile: string) => BotTokenStore
  /** The chats the bot has seen; the shared `ChatRegistry` when unset. */
  registry?: (command: Command, profile: string) => ChatRegistry
  /** A secret typed at a hidden prompt or piped on stdin; the shared `readSecret` when unset. */
  readSecret?: (command: Command, prompt: string) => Promise<string>
  /** What kind of chat a stored message came from; without it a positive id is a dialog, a negative one a group. */
  chatKindOf?: (hit: StoredHit) => ChatKind
  /** How its history pages, for `bot store fetch`, which is mounted only when this is set. */
  fetching?: Fetching & { from?: string }
  permissionFix?: (settings: Settings, request: GuardRequest) => string
  /** `bot mcp`, mounted only when this is set. */
  mcp?: BotMcp
}

export interface BotMcp {
  /** The CLI's own `run`, loaded when the server starts: this package cannot import the CLI's program. */
  program: () => Promise<RunBotCommand>
  /** The CLI's own tools, for the commands that are still its own. */
  tools?: readonly BotTool[]
  /** The CLI's SKILL.md, served as `<command>://skill`. */
  skill?: URL
}
