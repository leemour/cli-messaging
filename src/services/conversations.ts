import { CliError } from "@wirecat/cli-core"
import { cutChunks } from "../conversations/chunks.js"
import { type LinkInput, linkMessages, RULES_VERSION } from "../conversations/link.js"
import type { Id, Message, Page } from "../domain/models.js"
import type { AgentAnswer, ConversationSummary, LinkBatch, StoredLink } from "../store/store.js"
import { accountStore, type ServiceDeps } from "./deps.js"
import { chatIdIn } from "./messages.js"

/** A page of messages handed to the rules at a time; reading is quick, the rules hold a 50-message window. */
const READ_PAGE = 5_000

/** How far `links` follows a message's chosen parents back. */
const CHAIN = 50

export interface Built {
  chat: Id
  messages: number
  links: number
  conversations: number
  builtAt: string
  rulesVersion: number
}

export interface MessageLinks {
  chat: Id
  message: Id
  /** The message's own links; `chosen` is the one its conversation follows. */
  links: (StoredLink & { chosen: boolean })[]
  /** Its chosen parents back to where the conversation starts, nearest first. */
  chain: Id[]
}

/**
 * Conversations inside a chat, built from the store alone by rules (phase 3): replies, mentions and one
 * sender's messages in a row. Nothing is built on sync; a chat has conversations once `build` ran for it.
 */
export interface ConversationsService {
  build(chat: string, options?: { maxMessages?: number; check?: () => void }): Promise<Built>
  list(chat: string, window: { limit: number; since?: string }): Promise<Page<ConversationSummary>>
  /** By the conversation's id, or as the conversation a message is in. */
  show(
    target: { id: string } | { chat: string; message: Id },
  ): Promise<{ summary: ConversationSummary; messages: Message[] }>
  links(chat: string, message: Id): Promise<MessageLinks>
  /** What is left for the user's agent to answer, to tell the user before it starts (phase 4 plan A7). */
  batchStatus(chat: string, size: number): Promise<BatchStatus>
  /** The next window for the agent; `undefined` when every message is answered (A1–A4). */
  nextBatch(chat: string, size: number): Promise<LinkBatch | undefined>
  /** Stores the agent's answer to a batch, all or nothing (A5); `conversations build` then uses it. */
  addAnswers(batch: string, answer: AgentAnswer): Promise<{ chat: Id; stored: number }>
  /** Drops the agent's answers for a chat, or one model's (A10). */
  clearAnswers(chat: string, model?: string): Promise<{ chat: Id; cleared: number }>
}

export interface BatchStatus {
  chat: Id
  /** Messages with no messenger reply and no current agent answer. */
  messages: number
  characters: number
  /** About how many `batches next` it takes; windows hold context, so it is an estimate. */
  batches: number
  /** Characters ÷ 4: a rough count of tokens, not a price. */
  tokensEstimate: number
}

/** Messages to answer per batch, by default and at most: the agent's turn stays small (A1). */
export const BATCH_SIZE = { default: 50, min: 10, max: 200 }

export const conversationsService = (deps: ServiceDeps): ConversationsService => {
  const found = async (chat: string) => {
    const store = await accountStore(deps)
    return { store, chatId: await chatIdIn(deps.messenger, chat, store) }
  }

  const notBuilt = (chatId: Id) =>
    new CliError(
      "not_found",
      `chat ${chatId} has no conversations yet — \`${deps.messenger.app.command} conversations build --chat ${chatId}\``,
    )

  return {
    build: async (chat, { maxMessages, check } = {}) => {
      check?.()
      const { store, chatId } = await found(chat)
      const startedAt = Date.now()
      const inputs: LinkInput[] = []
      let after: string | undefined
      for (;;) {
        check?.()
        const page = await store.linkInputs(chatId, { limit: READ_PAGE, ...(after ? { after } : {}) })
        if (maxMessages !== undefined && inputs.length + page.items.length > maxMessages)
          throw new CliError("validation_error", "the chat exceeds the catch-up message budget")
        inputs.push(...page.items)
        if (page.next === null) break
        after = page.next
      }
      if (inputs.length === 0) {
        throw new CliError("not_found", `the store holds no messages of chat ${chatId} — fetch them first`)
      }
      check?.()
      const { links, conversations } = linkMessages(inputs, {
        check,
        handles: await store.senderHandles(chatId),
        answers: await store.agentAnswers(chatId),
      })
      const byId = new Map(inputs.map((input) => [input.id, input]))
      const chunks = conversations.map((ids) =>
        cutChunks(
          ids.flatMap((id) => {
            const input = byId.get(id)
            return input ? [{ id, sender: input.senderName ?? null, text: input.text }] : []
          }),
          undefined,
          check,
        ).map(({ firstId, lastId, hash, range }) => ({ firstId, lastId, hash, ...(range ? { range } : {}) })),
      )
      await store.replaceConversations(chatId, {
        check,
        startedAt,
        algorithmVersion: RULES_VERSION,
        links,
        conversations,
        chunks,
      })
      return {
        chat: chatId,
        messages: inputs.length,
        links: links.length,
        conversations: conversations.length,
        builtAt: new Date(startedAt).toISOString(),
        rulesVersion: RULES_VERSION,
      }
    },

    list: async (chat, { limit, since }) => {
      const { store, chatId } = await found(chat)
      if (!(await store.conversationState(chatId))?.builtAt) throw notBuilt(chatId)
      return store.conversations(chatId, { limit, ...(since === undefined ? {} : { after: since }) })
    },

    show: async (target) => {
      const store = await accountStore(deps)
      let id: string
      if ("id" in target) {
        id = target.id
      } else {
        const { chatId } = await found(target.chat)
        const of = await store.conversationOf(chatId, target.message)
        if (of === undefined) {
          if (!(await store.conversationState(chatId))?.builtAt) throw notBuilt(chatId)
          throw new CliError("not_found", `message ${target.message} is in no conversation of chat ${chatId}`)
        }
        id = of
      }
      const conversation = await store.conversation(id)
      if (!conversation) {
        throw new CliError("not_found", `no conversation ${id} — a rebuild gives new ids; \`conversations list\``)
      }
      return conversation
    },

    batchStatus: async (chat, size) => {
      const { store, chatId } = await found(chat)
      const { messages, characters } = await store.batchStatus(chatId)
      return {
        chat: chatId,
        messages,
        characters,
        batches: Math.ceil(messages / sized(size)),
        tokensEstimate: Math.round(characters / 4),
      }
    },

    nextBatch: async (chat, size) => {
      const { store, chatId } = await found(chat)
      return store.nextBatch(chatId, { size: sized(size) })
    },

    addAnswers: async (batch, answer) => {
      return (await accountStore(deps)).saveAnswers(batch, answer)
    },

    clearAnswers: async (chat, model) => {
      const { store, chatId } = await found(chat)
      return { chat: chatId, cleared: await store.clearAnswers(chatId, model) }
    },

    links: async (chat, message) => {
      const { store, chatId } = await found(chat)
      const chosenOf = (links: StoredLink[]) => links.find((link) => !link.stale)
      const own = await store.links(chatId, message)
      const chosen = chosenOf(own)
      const chain: Id[] = []
      for (let parent = chosen?.parentId ?? null; parent !== null && chain.length < CHAIN; ) {
        if (chain.includes(parent)) break
        chain.push(parent)
        parent = chosenOf(await store.links(chatId, parent))?.parentId ?? null
      }
      return { chat: chatId, message, links: own.map((link) => ({ ...link, chosen: link === chosen })), chain }
    },
  }
}

const sized = (size: number) => {
  if (!Number.isInteger(size) || size < BATCH_SIZE.min || size > BATCH_SIZE.max) {
    throw new CliError("validation_error", `--size takes ${BATCH_SIZE.min} to ${BATCH_SIZE.max} messages`)
  }
  return size
}
