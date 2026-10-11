import { parseLocator } from "../domain/locator.js"
import type { Chat, Message, Page } from "../domain/models.js"
import { messageOfEmail } from "../store/sqlite/emails.js"
import type { ScoredHit } from "../store/sqlite/words.js"
import type { AccountKey, MessageStore } from "../store/store.js"

const THREADS_PAGE = 500

const threadsOf = async (store: MessageStore, key: AccountKey): Promise<Chat[]> => {
  const account = await store.storedAccount(key).catch(() => undefined)
  if (!account) return []
  const chats: Chat[] = []
  for (let offset = 0; ; offset += THREADS_PAGE) {
    const threads = await store.mail.threads({ accountId: account.id, limit: THREADS_PAGE, offset })
    chats.push(
      ...threads.map((thread) => ({
        id: thread.externalId,
        title: thread.subject,
        kind: "group" as const,
        unreadCount: null,
        lastMessageAt: thread.lastEmailAt === null ? null : new Date(thread.lastEmailAt).toISOString(),
        participantsCount: null,
      })),
    )
    if (threads.length < THREADS_PAGE) return chats
  }
}

/**
 * The store, with each mail account's email threads among its chats, so `--chat` and `chat:` name a thread
 * by id or subject as they name a chat. A thread that is also an older import's chat is listed once.
 */
export const withMailThreads = (store: MessageStore): MessageStore =>
  new Proxy(store, {
    get(target, key, receiver) {
      if (key !== "chats") return Reflect.get(target, key, receiver)
      return async (account: AccountKey, window: Parameters<MessageStore["chats"]>[1]): Promise<Page<Chat>> => {
        const held = await target.chats(account, window)
        if (window.limit !== undefined || window.offset !== undefined) return held
        const known = new Set(held.items.map(({ id }) => id))
        const threads = (await threadsOf(target, account)).filter(({ id }) => !known.has(id))
        return { ...held, items: [...held.items, ...threads] }
      }
    },
  })

const before = (newest: boolean) => (a: ScoredHit, b: ScoredHit) => {
  if (!newest) {
    if ((a.exact ?? false) !== (b.exact ?? false)) return a.exact ? -1 : 1
    if (a.score !== b.score) return a.score === null ? 1 : b.score === null ? -1 : b.score - a.score
  }
  return b.timestamp.localeCompare(a.timestamp)
}

/**
 * One page from mail stored as messages and mail in its own tables, in the order one search gives. An email
 * imported again into the mail tables keeps its locator, so its older message copy is dropped.
 */
export const mergeMail = (
  messages: Page<ScoredHit>,
  mail: Page<ScoredHit>,
  limit: number,
  newest = false,
): Page<ScoredHit> => {
  const moved = new Set(mail.items.map(({ locator }) => locator))
  const items = [...messages.items.filter(({ locator }) => !moved.has(locator)), ...mail.items].sort(before(newest))
  return {
    items: items.slice(0, limit),
    hasMore: messages.hasMore || mail.hasMore || items.length > limit,
  }
}

/**
 * The emails around a hit from the mail tables, oldest first, the hit marked as `anchor`; `undefined` when the
 * hit is mail an older import stored as messages, whose context the store's `around` reads.
 */
export const mailAround = async (
  store: MessageStore,
  hit: { locator: string; chatId: string; id: string },
  count: number,
): Promise<(Message & { anchor?: true })[] | undefined> => {
  const { provider, account } = parseLocator(hit.locator)
  const stored = await store.storedAccount({ provider, account }).catch(() => undefined)
  if (!stored) return undefined
  const emails = (await store.mail.emails({ accountId: stored.id, threadExternalId: hit.chatId })).reverse()
  const at = emails.findIndex(({ externalId }) => externalId === hit.id)
  if (at < 0) return undefined
  return emails
    .slice(Math.max(0, at - count), at + count + 1)
    .map((email) =>
      email.externalId === hit.id
        ? { ...messageOfEmail(email, hit.chatId), anchor: true as const }
        : messageOfEmail(email, hit.chatId),
    )
}
