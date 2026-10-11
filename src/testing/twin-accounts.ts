import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { sampleMeeting } from "@wirecat/cli-meetings/testing"
import type { Message } from "../domain/models.js"
import { type AccountKey, type MessageStore, openStore } from "../store/store.js"

/**
 * Two accounts of one provider that hold the same chat, message, mail, document and meeting ids, each
 * with text only it has: whatever comes back with `bravo` in it, read as alpha, came from the wrong account.
 * One provider on purpose — a filter on the provider alone cannot hide a leak.
 */
export const TWINS = ["alpha", "bravo"] as const
export type Twin = (typeof TWINS)[number]

export const twinAccount = (twin: Twin): AccountKey => ({ provider: "synthetic", account: TWIN_IDS[twin] })
export const twinMail = (twin: Twin): AccountKey => ({ provider: "email", account: TWIN_IDS[twin] })
export const twinMeetings = (twin: Twin): AccountKey => ({ provider: "meet", account: TWIN_IDS[twin] })

const TWIN_IDS: Record<Twin, string> = { alpha: "500", bravo: "600" }

/** Shared by both accounts' texts, so one query finds both. */
export const SHARED_WORD = "lantern"
export const CHAT = "7"
export const SENDER = "700"
export const THREAD = "thread-1"
export const EMAIL = "<m1@example.com>"
export const DOCUMENT_PATH = "same.md"

const message = (twin: Twin, id: string, text: string, extra: Partial<Message> = {}): Message => ({
  id,
  chatId: CHAT,
  senderId: SENDER,
  senderName: "Alice Example",
  timestamp: `2026-10-01T00:00:0${id}.000Z`,
  editedAt: null,
  text: `${text} ${twin}-only`,
  outgoing: false,
  attachments: [],
  replyTo: null,
  forwardedFrom: null,
  reactions: null,
  ...extra,
})

export interface TwinIds {
  account: AccountKey
  mailAccountId: number
  threadId: number
  folderId: string
  meetingAccountId: number
  meetingId: number
  attachmentPk: number
}

export interface TwinStore {
  store: MessageStore
  twins: Record<Twin, TwinIds>
}

const seed = async (store: MessageStore, twin: Twin, folderId: string): Promise<TwinIds> => {
  const account = twinAccount(twin)
  await store.saveAccount(account, { name: `${twin} account` })
  await store.saveChats(account, [
    { id: CHAT, title: `${twin} chat`, kind: "group", unreadCount: 0, lastMessageAt: null, participantsCount: 3 },
  ])
  await store.saveMessages(
    account,
    CHAT,
    [
      message(twin, "1", `${SHARED_WORD} question`),
      message(twin, "2", `${SHARED_WORD} answer`, { replyToId: "1" }),
      message(twin, "3", `${SHARED_WORD} file`, { attachments: [{ kind: "file", name: "same.txt" }] }),
    ],
    { via: "history" },
  )
  await store.keepTranscript(account, CHAT, "1", `${twin}-only transcript`, "synthetic")
  await store.keepDownloads(account, CHAT, "3", [{ kind: "file", position: 0, path: `/downloads/${twin}/same.txt` }])
  const [file] = await store.fileAttachments(account, { chatId: CHAT, messageId: "3", limit: 1 })
  if (!file) throw new Error("the twin attachment was not stored")
  await store.keepAttachmentText(file.pk, { text: `${twin}-only attachment text`, origin: "agent", extractor: "agent" })

  const mailAccountId = await store.saveAccount(twinMail(twin), { name: `${twin} mail` })
  const thread = await store.mail.saveThread({
    accountId: mailAccountId,
    externalId: THREAD,
    subject: `${twin} subject`,
    emails: [
      {
        externalId: EMAIL,
        subject: `${twin} subject`,
        from: { address: "alice@example.com", name: "Alice Example" },
        sentAt: Date.parse("2026-10-01T00:00:00.000Z"),
        bodyText: `${SHARED_WORD} mail ${twin}-only`,
      },
    ],
    now: Date.parse("2026-10-01T00:00:00.000Z"),
  })

  await store.notes.saveFileNote({
    folderId,
    path: DOCUMENT_PATH,
    title: `${twin} document`,
    text: `${SHARED_WORD} document ${twin}-only`,
  })

  const meetingAccountId = await store.saveAccount(twinMeetings(twin), { name: `${twin} meetings` })
  const meeting = sampleMeeting()
  meeting.meeting.accountId = meetingAccountId
  meeting.meeting.title = `${twin} meeting`
  const [transcript] = meeting.transcripts ?? []
  const [row] = transcript?.rows ?? []
  if (row) row.text = `${SHARED_WORD} meeting ${twin}-only`
  const saved = await store.meetings.saveMeeting(meeting)

  return {
    account,
    mailAccountId,
    threadId: thread.thread.id,
    folderId,
    meetingAccountId,
    meetingId: saved.meeting.id,
    attachmentPk: file.pk,
  }
}

export const openTwinStore = async (): Promise<TwinStore> => {
  const store = await openStore({ path: join(mkdtempSync(join(tmpdir(), "twin-accounts-")), "twins.db") })
  const alphaFolder = await store.notes.addFolder({ name: "alpha folder" })
  const bravoFolder = await store.notes.addFolder({ name: "bravo folder" })
  const twins = {
    alpha: await seed(store, "alpha", alphaFolder.id),
    bravo: await seed(store, "bravo", bravoFolder.id),
  }
  await store.fillSearchIndex({})
  await store.fillStems({})
  return { store, twins }
}

/** Every string anywhere in a value, so a test can say no part of an answer names the other account. */
export const leaksOf = (value: unknown, twin: Twin): string[] => {
  const found: string[] = []
  const locator = new RegExp(`(synthetic|email|meet)/${TWIN_IDS[twin]}/`)
  const walk = (one: unknown): void => {
    if (typeof one === "string") {
      if (one.includes(`${twin}-only`) || one.includes(`/${twin}/`) || one.startsWith(`${twin} `) || locator.test(one))
        found.push(one)
    } else if (Array.isArray(one)) one.forEach(walk)
    else if (one instanceof Map) [...one.values()].forEach(walk)
    else if (one !== null && typeof one === "object") Object.values(one).forEach(walk)
  }
  walk(value)
  return found
}
