import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { migrate } from "./migrations.js"
import { type EmailFilter, type EmailInput, mailStoreOver, type ThreadSave } from "./sqlite/emails.js"
import { openSqlite } from "./sqlite/open.js"
import { openStore } from "./store.js"

const opened: { close(): unknown }[] = []
afterEach(async () => {
  for (const handle of opened.splice(0)) await handle.close()
})

const freshPath = () => join(mkdtempSync(join(tmpdir(), "mail-")), "store.db")

const seeded = async () => {
  const { database, orm } = await openSqlite(freshPath())
  opened.push(database)
  migrate(database)
  database
    .prepare("INSERT INTO accounts (id, provider, external_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, 1, 1)")
    .run(1, "email", "owner@example.com", "Owner Example")
  return { database, mail: mailStoreOver({ database, orm }) }
}

const email = (overrides: Partial<EmailInput> = {}): EmailInput => ({
  externalId: "<first@example.com>",
  subject: "Quarterly planning",
  from: { address: "Alice@Example.com", name: "Alice Example" },
  to: [{ address: "owner@example.com", name: null }],
  cc: [{ address: "bob@example.com", name: "Bob Sample" }],
  sentAt: 1000,
  receivedAt: 1100,
  references: [],
  bodyText: "Let us agree on the roadmap.",
  outgoing: false,
  read: true,
  mailboxes: [{ externalId: "INBOX", name: "Inbox", kind: "inbox" }],
  ...overrides,
})

const thread = (emails: EmailInput[], now = 2000): ThreadSave => ({ accountId: 1, externalId: "thread-1", emails, now })

describe("mail store", () => {
  it("saves a thread with its emails, recipients and mailboxes, and a resave changes nothing", async () => {
    const { mail } = await seeded()
    const first = await mail.saveThread(thread([email()]))
    expect(first.thread).toMatchObject({ subject: "Quarterly planning", emailsCount: 1, lastEmailAt: 1000 })
    const [saved] = first.emails
    expect(saved).toMatchObject({ fromAddress: "alice@example.com", read: true, outgoing: false, references: [] })
    expect(saved?.recipients.map(({ address, role, position }) => [address, role, position])).toEqual([
      ["owner@example.com", "to", 0],
      ["bob@example.com", "cc", 1],
    ])
    expect(saved?.mailboxes.map(({ externalId }) => externalId)).toEqual(["INBOX"])

    const again = await mail.saveThread(thread([email()], 3000))
    expect(again.thread.id).toBe(first.thread.id)
    expect(again.emails.map(({ id }) => id)).toEqual(first.emails.map(({ id }) => id))
    expect(again.emails[0]?.recipients).toEqual(saved?.recipients)
    expect(again.thread.emailsCount).toBe(1)
    expect(await mail.thread(first.thread.id)).toEqual(again)
  })

  it("adds replies and mailboxes, keeps the thread's subject and time, and reads by Message-ID", async () => {
    const { mail } = await seeded()
    const reply = email({ subject: "Re: Quarterly planning", externalId: "<reply@example.com>", sentAt: 5000 })
    await mail.saveThread(thread([reply, email()]))
    const details = await mail.saveThread(
      thread([email({ mailboxes: [{ externalId: "Label_1", name: "Projects", kind: "label" }] })], 6000),
    )
    expect(details.thread).toMatchObject({ subject: "Quarterly planning", emailsCount: 2, lastEmailAt: 5000 })
    expect(details.emails.map(({ externalId }) => externalId)).toEqual(["<first@example.com>", "<reply@example.com>"])
    expect((await mail.email(1, "<first@example.com>"))?.mailboxes.map(({ name }) => name)).toEqual([
      "Inbox",
      "Projects",
    ])
    expect(await mail.email(1, "<missing@example.com>")).toBeNull()
    expect((await mail.threads({ accountId: 1 })).map(({ id }) => id)).toEqual([details.thread.id])
    expect(await mail.threads({ accountId: 2 })).toEqual([])
  })

  it("searches subjects and bodies by word prefix, and an email marked deleted leaves the results", async () => {
    const { mail } = await seeded()
    await mail.saveThread(
      thread([email(), email({ externalId: "<second@example.com>", subject: "Lunch", bodyText: "Pizza on Friday" })]),
    )
    expect((await mail.search("quarterly")).map(({ externalId }) => externalId)).toEqual(["<first@example.com>"])
    expect((await mail.search("roadm")).map(({ externalId }) => externalId)).toEqual(["<first@example.com>"])
    expect((await mail.search("pizza friday")).map(({ externalId }) => externalId)).toEqual(["<second@example.com>"])
    expect(await mail.search("  ")).toEqual([])

    expect(await mail.markDeleted(1, ["<second@example.com>"], 7000)).toBe(1)
    expect(await mail.search("pizza")).toEqual([])
    expect((await mail.threads())[0]?.emailsCount).toBe(1)

    await mail.saveThread(thread([email({ bodyText: "The roadmap changed to a timeline." })], 8000))
    expect((await mail.search("timeline")).map(({ externalId }) => externalId)).toEqual(["<first@example.com>"])

    await mail.markDeleted(1, ["<first@example.com>"], 9000)
    expect(await mail.threads()).toEqual([])
    expect((await mail.threads({ includeDeleted: true }))[0]?.deletedAt).toBe(9000)
  })

  it("lists emails by thread, participant, mailbox and received time", async () => {
    const { mail } = await seeded()
    await mail.saveThread(
      thread([
        email(),
        email({
          externalId: "<second@example.com>",
          from: { address: "carol@example.com", name: null },
          to: [],
          cc: [],
          sentAt: 3000,
          receivedAt: 3100,
          mailboxes: [{ externalId: "Label_1", name: "Projects", kind: "label" }],
        }),
      ]),
    )
    await mail.saveThread({ ...thread([email({ externalId: "<other@example.com>", sentAt: 4000 })]), externalId: "t2" })
    const ids = async (filter: EmailFilter) => (await mail.emails(filter)).map(({ externalId }) => externalId)

    expect(await ids({ accountId: 1 })).toEqual(["<other@example.com>", "<second@example.com>", "<first@example.com>"])
    expect(await ids({ threadExternalId: "thread-1" })).toEqual(["<second@example.com>", "<first@example.com>"])
    expect(await ids({ participant: "Bob@Example.com" })).toEqual(["<other@example.com>", "<first@example.com>"])
    expect(await ids({ participant: "carol@example.com" })).toEqual(["<second@example.com>"])
    expect(await ids({ mailbox: "Label_1" })).toEqual(["<second@example.com>"])
    expect(await ids({ since: 1100, until: 3100 })).toEqual(["<other@example.com>", "<first@example.com>"])
    expect((await mail.mailboxes(1)).map(({ name }) => name)).toEqual(["Inbox", "Projects"])

    await mail.markDeleted(1, ["<first@example.com>"], 5000)
    expect(await ids({ threadExternalId: "thread-1" })).toEqual(["<second@example.com>"])
    expect(await ids({ threadExternalId: "thread-1", includeDeleted: true })).toHaveLength(2)
    const found = async (participant: string) =>
      (await mail.search("roadmap", { participant })).map(({ externalId }) => externalId)
    expect(await found("carol@example.com")).toEqual(["<second@example.com>"])
    expect(await found("bob@example.com")).toEqual(["<other@example.com>"])
  })

  it("sets membership only among the scanned mailboxes", async () => {
    const { mail } = await seeded()
    const archive = { externalId: "Archive", name: "Archive", kind: "archive" }
    await mail.saveThread(
      thread([email({ mailboxes: [{ externalId: "INBOX", name: "Inbox", kind: "inbox" }, archive] })]),
    )
    const scanned = [{ externalId: "INBOX", name: "Inbox", kind: "inbox" }]

    expect(await mail.setMailboxes(1, scanned, new Map([["<first@example.com>", []]]), 3000)).toBe(1)
    expect((await mail.email(1, "<first@example.com>"))?.mailboxes.map(({ externalId }) => externalId)).toEqual([
      "Archive",
    ])

    expect(await mail.setMailboxes(1, scanned, new Map([["<first@example.com>", ["INBOX"]]]), 4000)).toBe(1)
    expect((await mail.email(1, "<first@example.com>"))?.mailboxes.map(({ externalId }) => externalId)).toEqual([
      "INBOX",
      "Archive",
    ])
    expect(await mail.setMailboxes(1, scanned, new Map([["<missing@example.com>", ["INBOX"]]]), 5000)).toBe(0)
    await expect(mail.setMailboxes(1, scanned, new Map([["<first@example.com>", ["Archive"]]]), 6000)).rejects.toThrow(
      "Mailbox Archive was not scanned",
    )
  })

  it("replaces an email's attachments when given and finds their text by word", async () => {
    const { database, mail } = await seeded()
    const file = (position: number, name: string, text: string | null) => ({
      position,
      kind: "file",
      mime: "application/pdf",
      name,
      title: null,
      url: null,
      size: 10,
      width: null,
      height: null,
      duration: null,
      providerRef: { part: position + 2 },
      localPath: null,
      text,
      normalizedText: null,
      extraction: text === null ? null : "text",
      extractor: text === null ? null : "pdf:unpdf",
      extractionError: text === null ? "no_text" : null,
      contentSha256: null,
      extractedAt: 1500,
    })
    await mail.saveThread(
      thread([email({ attachments: [file(0, "plan.pdf", "Café budget"), file(1, "scan.pdf", null)] })]),
    )
    const saved = await mail.email(1, "<first@example.com>")
    expect(
      saved?.attachments.map(({ name, normalizedText, providerRef }) => [name, normalizedText, providerRef]),
    ).toEqual([
      ["plan.pdf", "cafe budget", { part: 2 }],
      ["scan.pdf", null, { part: 3 }],
    ])
    const words = database.prepare("SELECT rowid FROM attachment_words WHERE attachment_words MATCH 'cafe'").all()
    expect(words.map(({ rowid }) => Number(rowid))).toEqual([saved?.attachments[0]?.id])

    await mail.saveThread(thread([email({ attachments: [file(0, "plan-v2.pdf", "Budget")] })], 3000))
    expect((await mail.email(1, "<first@example.com>"))?.attachments.map(({ name }) => name)).toEqual(["plan-v2.pdf"])
    await mail.saveThread(thread([email()], 4000))
    expect((await mail.email(1, "<first@example.com>"))?.attachments).toHaveLength(1)
  })

  it("drops a deleted email's text and attachment text, and a save brings the email back", async () => {
    const { database, mail } = await seeded()
    const file = {
      position: 0,
      kind: "file",
      mime: "text/plain",
      name: "notes.txt",
      title: null,
      url: null,
      size: 5,
      width: null,
      height: null,
      duration: null,
      providerRef: null,
      localPath: null,
      text: "Secret plan",
      normalizedText: null,
      extraction: "text",
      extractor: "plain",
      extractionError: null,
      contentSha256: null,
      extractedAt: 1500,
    }
    await mail.saveThread(thread([email({ bodyHtml: "<p>roadmap</p>", snippet: "Let us", attachments: [file] })]))
    await mail.markDeleted(1, ["<first@example.com>"], 3000)

    const gone = await mail.email(1, "<first@example.com>")
    expect(gone).toMatchObject({ deletedAt: 3000, bodyText: null, bodyHtml: null, snippet: null })
    expect(gone?.attachments[0]).toMatchObject({ text: null, normalizedText: null })
    expect(database.prepare("SELECT rowid FROM attachment_words WHERE attachment_words MATCH 'secret'").all()).toEqual(
      [],
    )

    const back = await mail.saveThread(thread([email()], 4000))
    expect(back.emails[0]).toMatchObject({ deletedAt: null, bodyText: "Let us agree on the roadmap." })
    expect(back.thread).toMatchObject({ deletedAt: null, emailsCount: 1 })
    expect((await mail.search("roadmap")).map(({ externalId }) => externalId)).toEqual(["<first@example.com>"])
  })

  it("refuses an empty key and leaves nothing behind", async () => {
    const { mail } = await seeded()
    await expect(mail.saveThread(thread([email(), email({ externalId: "" })]))).rejects.toThrow("Invalid email key")
    expect(await mail.threads({ includeDeleted: true })).toEqual([])
    await expect(mail.saveThread({ ...thread([]), externalId: "" })).rejects.toThrow("Invalid thread key")
  })

  it("is the shared store's mail, built on first use", async () => {
    const store = await openStore({ path: freshPath() })
    opened.push(store)
    expect(await store.mail.threads()).toEqual([])
    expect(store.mail).toBe(store.mail)
  })
})
