import { createTaskService, type TaskKind, type TaskStore } from "@wirecat/cli-tasks"
import { formatLocator } from "../domain/locator.js"
import type { Id, Message, ReviewChat } from "../domain/models.js"
import type { AccountKey, MessageStore } from "../store/store.js"
import { questions } from "./questions.js"

export interface RuleResult {
  added: number
  closed: number
}

export const taskAccount = ({ provider, account }: AccountKey): string => `${provider}:${account}`

/**
 * Opens a task for each question nobody answered and each message that mentions the owner, and closes
 * one when the owner answered it — over every message a review read, before `--unanswered` narrows it.
 * Run twice over the same window it changes nothing: the service returns the task a source already has.
 * Only the owner's answers count: the store knows no admins, and a review without `--unanswered` asks
 * for none. A mention is one the messenger marks by id; an `@handle` is not seen.
 */
export const applyTaskRules = async (
  review: { chats: Pick<ReviewChat, "id" | "messages">[] },
  { store, account, now }: { store: TaskStore; account: AccountKey; now?: () => Date },
): Promise<RuleResult> => {
  const tasks = createTaskService({ store, ...(now ? { now } : {}) })
  const owner = taskAccount(account)
  const result: RuleResult = { added: 0, closed: 0 }
  const sourceOf = (message: Message) =>
    formatLocator({ provider: account.provider, account: account.account, chat: message.chatId, message: message.id })

  const open = async (message: Message, group: Id, kind: TaskKind) => {
    const { created } = await tasks.add({
      source: sourceOf(message),
      sourceKind: "message",
      account: owner,
      group,
      kind,
      origin: "rule",
    })
    if (created) result.added += 1
  }
  const close = async (message: Message, kind: TaskKind, answer?: Message) => {
    for (const task of await store.findBySource(owner, sourceOf(message))) {
      if (task.kind !== kind || task.state !== "open") continue
      await tasks.close(task.id, { as: "done", by: "rule" })
      if (answer) await store.answer(task.id, { resolution: "answered by the owner", by: sourceOf(answer) })
      result.closed += 1
    }
  }

  for (const chat of review.chats) {
    for (const { question, answer } of questions(chat.messages, { answerers: new Set() })) {
      if (answer) await close(question, "question", answer)
      else await open(question, chat.id, "question")
    }
    for (const [index, message] of chat.messages.entries()) {
      if (message.outgoing || !message.mentions?.includes(account.account)) continue
      if (ownerAnswered(chat.messages, index)) await close(message, "mention")
      else await open(message, chat.id, "mention")
    }
  }
  return result
}

/** How far back `serve` looks when a message arrives: enough to see whether it answers a recent question. */
export const ARRIVAL_WINDOW = 50

/** `serve`'s rule pass: the new message with the chat's stored messages before it, as a review would read them. */
export const applyTaskRulesOnArrival = async (
  store: MessageStore,
  account: AccountKey,
  message: Message,
): Promise<RuleResult> => {
  const page = await store.messages(account, message.chatId, { limit: ARRIVAL_WINDOW })
  const messages = [...page.items.filter((one) => one.id !== message.id), message].sort(
    (a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp),
  )
  return applyTaskRules({ chats: [{ id: message.chatId, messages }] }, { store: store.tasks, account })
}

/**
 * A reply rule's `task` action: one `request` task pointing at the message. The service gives back
 * the task a source already has, so a message arriving twice opens one.
 */
export const openRequestTask = async (store: MessageStore, account: AccountKey, message: Message): Promise<boolean> => {
  const { created } = await createTaskService({ store: store.tasks }).add({
    source: formatLocator({
      provider: account.provider,
      account: account.account,
      chat: message.chatId,
      message: message.id,
    }),
    sourceKind: "message",
    account: taskAccount(account),
    group: message.chatId,
    kind: "request",
    origin: "rule",
  })
  return created
}

/** The owner replied to the message, or to anything its sender said, later in the chat. */
const ownerAnswered = (messages: Message[], index: number): boolean => {
  const message = messages[index]
  if (!message) return false
  const senders = new Map(messages.map((one) => [one.id, one.senderId]))
  return messages.slice(index + 1).some((one) => {
    if (one.outgoing !== true) return false
    const to = one.replyTo?.id ?? one.replyToId
    if (to === message.id) return true
    const repliedSender = one.replyTo?.senderId ?? (to === undefined ? undefined : senders.get(to))
    return repliedSender != null && repliedSender === message.senderId
  })
}
