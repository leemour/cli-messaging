import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"
import { openCache } from "./open.js"
import { openStore } from "./store.js"

it("rebuilds a person's ordered timeline across sources and uses the person index", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "involvements-")), "store.db")
  const store = await openStore({ path, now: () => 1000 })
  const account = { provider: "synthetic", account: "owner" }
  const database = await openCache(path)
  try {
    await store.saveChats(account, [
      { id: "room", title: "Synthetic room", kind: "group", unreadCount: 0, lastMessageAt: null, participantsCount: 1 },
    ])
    await store.saveMessages(
      account,
      "room",
      [
        {
          id: "message",
          chatId: "room",
          senderId: "alice",
          senderName: "Alice Example",
          timestamp: new Date(100).toISOString(),
          editedAt: null,
          text: "Synthetic text",
          outgoing: false,
          attachments: [],
          replyTo: null,
          forwardedFrom: null,
          reactions: null,
        },
      ],
      { via: "history" },
    )
    const identity = Number(database.prepare("SELECT id FROM identities WHERE external_id='alice'").get()?.id)
    const person = Number(
      database.prepare("SELECT person_id FROM identity_links WHERE identity_id=?").get(identity)?.person_id,
    )
    const accountId = Number(database.prepare("SELECT id FROM accounts").get()?.id)
    database.prepare("UPDATE accounts SET scope='work' WHERE id=?").run(accountId)
    database
      .prepare(
        "INSERT INTO email_threads (account_id, external_id, created_at, updated_at) VALUES (?, 'thread', 200, 200)",
      )
      .run(accountId)
    database
      .prepare(
        "INSERT INTO emails (email_thread_id, account_id, external_id, sent_at, created_at, updated_at) VALUES (1, ?, 'email-1', 200, 200, 200)",
      )
      .run(accountId)
    database
      .prepare(
        "INSERT INTO email_recipients (email_id, identity_id, address, role, position, created_at, updated_at) SELECT id, ?, 'alice@example.test', 'to', 0, 200, 200 FROM emails",
      )
      .run(identity)
    expect(store.involvements.rebuild(person)).toBe(2)
    expect(store.involvements.forPerson(person, { scope: "work" })).toMatchObject([
      { subjectType: "email", role: "recipient", occurredAt: 200 },
      { subjectType: "message", role: "sender", occurredAt: 100 },
    ])
    expect(store.involvements.forPerson(person, { scope: "personal" })).toEqual([])
    expect(store.involvements.rebuild()).toBe(2)
    expect(
      database
        .prepare(
          "EXPLAIN QUERY PLAN SELECT * FROM involvements WHERE person_id=? AND scope=? ORDER BY occurred_at DESC LIMIT ?",
        )
        .all(person, "work", 10)
        .map((row) => row.detail)
        .join(" "),
    ).toContain("involvements_by_person")
    database.prepare("UPDATE emails SET deleted_at=300").run()
    expect(store.involvements.rebuild(person)).toBe(1)
    expect(() => store.involvements.forPerson(person, { limit: -1 })).toThrow("1–1000")
  } finally {
    database.close()
    await store.close()
  }
})

it("keeps the index current by draining what writes queued, and ends where a full rebuild ends", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "involvements-")), "store.db")
  const store = await openStore({ path, now: () => 1000 })
  const account = { provider: "synthetic", account: "owner" }
  const database = await openCache(path)
  const rows = () =>
    database
      .prepare(
        "SELECT person_id, identity_id, subject_type, subject_id, role, occurred_at, scope FROM involvements ORDER BY subject_type, subject_id, role, person_id",
      )
      .all()
  const sameAsRebuild = () => {
    store.involvements.drain()
    const drained = rows()
    store.involvements.rebuild()
    expect(drained).toEqual(rows())
    return drained
  }
  const message = (id: string, senderId: string, extra: Record<string, unknown> = {}) => ({
    id,
    chatId: "room",
    senderId,
    senderName: senderId === "alice" ? "Alice Example" : "Bob Sample",
    timestamp: new Date(Number(id) * 100).toISOString(),
    editedAt: null,
    text: "Synthetic text",
    outgoing: false,
    attachments: [],
    replyTo: null,
    forwardedFrom: null,
    reactions: null,
    ...extra,
  })
  try {
    await store.saveChats(account, [
      { id: "room", title: "Synthetic room", kind: "group", unreadCount: 0, lastMessageAt: null, participantsCount: 2 },
    ])
    await store.saveMessages(account, "room", [message("1", "alice"), message("2", "bob")], { via: "history" })
    database.prepare("UPDATE messages SET mentions=json_array('alice') WHERE external_id='2'").run()
    const alice = Number(
      database
        .prepare(
          "SELECT l.person_id AS id FROM identity_links l JOIN identities i ON i.id=l.identity_id WHERE i.external_id='alice'",
        )
        .get()?.id,
    )

    expect(sameAsRebuild().filter((row) => row.person_id === alice)).toMatchObject([
      { subject_type: "message", role: "sender" },
      { subject_type: "message", role: "mentioned" },
    ])

    database.prepare("UPDATE accounts SET scope='work'").run()
    expect(sameAsRebuild().every((row) => row.scope === "work")).toBe(true)

    database.prepare("UPDATE messages SET deleted_at=2000 WHERE external_id='1'").run()
    expect(sameAsRebuild().filter((row) => row.person_id === alice)).toMatchObject([{ role: "mentioned" }])

    const bob = Number(
      database
        .prepare(
          "SELECT l.person_id AS id FROM identity_links l JOIN identities i ON i.id=l.identity_id WHERE i.external_id='bob'",
        )
        .get()?.id,
    )
    database
      .prepare(
        "UPDATE identity_links SET person_id=? WHERE identity_id=(SELECT id FROM identities WHERE external_id='alice')",
      )
      .run(bob)
    expect(rows().filter((row) => row.person_id === alice)).toEqual([])
    expect(sameAsRebuild().filter((row) => row.person_id === bob)).toHaveLength(2)
    expect(store.involvements.drain()).toEqual({ recomputed: 0, pending: 0 })
  } finally {
    database.close()
    await store.close()
  }
})
