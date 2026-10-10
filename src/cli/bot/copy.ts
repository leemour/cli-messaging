import { CliError } from "@wirecat/cli-core"
import type { Chat, Message, Provider } from "../../domain/models.js"
import { isBotProvider } from "../../search/query.js"
import type { AccountKey, IngestedVia, MessageStore, PersonFacts } from "../../store/index.js"
import { openStore } from "../../store/index.js"
import type { BotEvent } from "./port.js"

const CHAT_ID = /^-?\d+$/

/** The reason, never the path — a home directory is nobody else's business. */
const reasonOf = (error: unknown): string => {
  const code = (error as { code?: unknown })?.code
  if (typeof code === "string") return code
  return error instanceof Error ? error.name : "an unknown problem"
}

/**
 * **A store that fails never fails the command** — the messenger answered, and the answer is printed
 * either way; the reason goes to stderr. Answers whether it was saved, for `watch`, which must not
 * move its marker past what it failed to keep.
 */
const quietly = async (write: (store: MessageStore) => Promise<unknown>, warn: (message: string) => void) => {
  let store: MessageStore | undefined
  try {
    store = await openStore()
    await write(store)
    return true
  } catch (error) {
    warn(`the local copy was not updated: ${reasonOf(error)}`)
    return false
  } finally {
    await store?.close()
  }
}

/**
 * What a bot read, sent or received, kept in the shared store under its own provider and the bot's
 * id, so each bot sees only its own copy. Only a real chat is kept: `user:<id>` is a send address,
 * and stored it would make a chat that does not exist.
 */
export const botCopy = (provider: Provider) => {
  if (!isBotProvider(provider)) {
    throw new Error(
      `a bot's provider ends in -bot, so a search can tell it from a person's account — not "${provider}"`,
    )
  }
  const accountOf = (botId: string): AccountKey => ({ provider, account: botId })
  const storable = (message: Message) => CHAT_ID.test(message.chatId) && message.id !== "unknown"

  return {
    accountOf,

    keep: async (
      botId: string,
      messages: readonly Message[],
      via: IngestedVia,
      warn: (message: string) => void,
      senders: readonly PersonFacts[] = [],
    ): Promise<boolean> => {
      const byChat = new Map<string, Message[]>()
      for (const message of messages.filter(storable)) {
        byChat.set(message.chatId, [...(byChat.get(message.chatId) ?? []), message])
      }
      if (byChat.size === 0 && senders.length === 0) return true
      return quietly(async (store) => {
        for (const [chatId, chatMessages] of byChat) {
          await store.saveMessages(accountOf(botId), chatId, chatMessages, { via })
        }
        if (senders.length > 0) await store.savePeople(accountOf(botId), [...senders])
      }, warn)
    },

    /** Only a chat the messenger has just described in full: the store replaces a title it is not given. */
    keepChat: async (botId: string, chat: Chat, warn: (message: string) => void) => {
      if (CHAT_ID.test(chat.id)) await quietly((store) => store.saveChats(accountOf(botId), [chat]), warn)
    },

    /** Messages the bot deleted, kept as tombstones: reads and search stop returning them. */
    forget: async (botId: string, chatId: string, messageIds: string[], warn: (message: string) => void) => {
      if (!CHAT_ID.test(chatId) || messageIds.length === 0) return true
      return quietly((store) => store.markDeleted(accountOf(botId), messageIds, { chatId }), warn)
    },

    /**
     * Records each event that names its update, and answers which of them were handled before. A
     * store that fails answers none, so the batch is kept and printed as if new.
     */
    received: async (botId: string, events: readonly BotEvent[], warn: (message: string) => void) => {
      const updates = events.flatMap((event) => (event.update ? [{ ...event.update, event }] : []))
      let handled = new Set<string>()
      if (updates.length === 0) return handled
      await quietly(async (store) => {
        for (const { id, kind, event } of updates) {
          store.botUpdates.save(accountOf(botId), { externalId: id, kind, payload: event })
        }
        handled = store.botUpdates.handledOf(
          accountOf(botId),
          updates.map(({ id }) => id),
        )
      }, warn)
      return handled
    },

    /** Marks the updates of these events handled, or failed with `error`. */
    settle: async (
      botId: string,
      events: readonly BotEvent[],
      error: string | null,
      warn: (message: string) => void,
    ) => {
      const ids = events.flatMap((event) => (event.update ? [event.update.id] : []))
      if (ids.length === 0) return
      await quietly(async (store) => {
        for (const id of ids) {
          if (error === null) store.botUpdates.handled(accountOf(botId), id)
          else store.botUpdates.failed(accountOf(botId), id, error)
        }
      }, warn)
    },

    /** For a read the local copy answers: here the store is the answer, so a failure is the command's. */
    read: async <T>(read: (store: MessageStore) => Promise<T>): Promise<T> => {
      let store: MessageStore
      try {
        store = await openStore()
      } catch (error) {
        throw new CliError("configuration_error", `the local copy cannot be opened: ${reasonOf(error)}`)
      }
      try {
        return await read(store)
      } finally {
        await store.close()
      }
    },
  }
}

export type BotCopy = ReturnType<typeof botCopy>
