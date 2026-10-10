import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"
import { chunkHash } from "../conversations/chunks.js"
import type { Message } from "../domain/models.js"
import { openCache } from "./open.js"
import { type AccountKey, openStore } from "./store.js"

const account: AccountKey = { provider: "synthetic", account: "owner", scope: "work" }
const message = (id: string, extra: Partial<Message> = {}): Message => ({
  id,
  chatId: "room",
  senderId: "alice",
  senderName: "Alice Example",
  timestamp: new Date(200).toISOString(),
  editedAt: null,
  text: "Synthetic text",
  outgoing: false,
  attachments: [],
  replyTo: null,
  forwardedFrom: null,
  reactions: null,
  ...extra,
})
const fresh = () => join(mkdtempSync(join(tmpdir(), "messaging-")), "store.db")

it("stores scoped nested chats and connects a reply thread when its root arrives later", async () => {
  const path = fresh(),
    store = await openStore({ path, now: () => 1000 }),
    db = await openCache(path)
  try {
    await store.saveChats(account, [
      {
        id: "room",
        parentChatId: "parent",
        scope: "personal",
        kind: "group",
        title: "Synthetic room",
        unreadCount: 0,
        lastMessageAt: null,
        participantsCount: null,
      },
    ])
    await store.saveMessages(account, "room", [message("reply", { threadId: "root" })], { via: "history" })
    expect(db.prepare("SELECT thread_root_id FROM messages").get()?.thread_root_id).toBeNull()
    await store.keepTranscript(account, "room", "root", "Synthetic transcript", "synthetic")
    await store.saveMessages(account, "room", [message("root")], { via: "history" })
    expect(db.prepare("SELECT message_id FROM message_transcripts").get()?.message_id).not.toBeNull()
    expect(
      db
        .prepare(
          "SELECT root.external_id FROM messages reply JOIN messages root ON root.id=reply.thread_root_id WHERE reply.external_id='reply'",
        )
        .get()?.external_id,
    ).toBe("root")
    expect(
      db
        .prepare(
          "SELECT a.scope,c.scope AS chat_scope,parent.external_id AS parent FROM chats c JOIN accounts a ON a.id=c.account_id JOIN chats parent ON parent.id=c.parent_chat_id",
        )
        .get(),
    ).toEqual({ scope: "work", chat_scope: "personal", parent: "parent" })
    expect((await store.chats(account, {})).items.find((chat) => chat.id === "room")).toMatchObject({
      scope: "personal",
      parentChatId: "parent",
    })
    expect(db.prepare("SELECT message_count FROM chats WHERE external_id='room'").get()?.message_count).toBe(2)
    await store.markDeleted(account, ["root"], { chatId: "room" })
    await store.keepTranscript(account, "room", "root", "Late transcript", "synthetic")
    expect(await store.transcript(account, "room", "root")).toBeUndefined()
  } finally {
    db.close()
    await store.close()
  }
})

it("keeps contact aliases per account and revisioned notes on the identity", async () => {
  const path = fresh(),
    store = await openStore({ path, now: () => 1000 })
  try {
    await store.savePeople(account, [{ id: "alice", name: "Alice Example", username: "alice" }])
    const other = { ...account, account: "other" }
    await store.savePeople(other, [{ id: "alice", name: "Alice Example" }])
    await store.setContactAlias(account, "alice", "Local Alice")
    expect((await store.privateContact(account, "alice")).alias).toBe("Local Alice")
    expect((await store.privateContact(other, "alice")).alias).toBeNull()
    const note = await store.addContactNote(account, "alice", "Synthetic note")
    const edited = await store.editContactNote(other, "alice", note.id, "Revised note", note.revision)
    expect(edited).toMatchObject({ text: "Revised note", revision: 2 })
    await expect(store.editContactNote(account, "alice", note.id, "Stale", 1)).rejects.toThrow("current revision")
    expect((await store.personOf({ provider: account.provider, id: "alice" }))?.uid).toMatch(/^\d+$/)
    await store.setContactAlias(account, "alice", null)
    expect((await store.privateContact(account, "alice")).alias).toBeNull()
    await store.removeContactNote(account, "alice", note.id)
    expect((await store.privateContact(other, "alice")).notes).toEqual([])
  } finally {
    await store.close()
  }
})

it("stores chunk filter columns and narrows by scope, project, person and time before scoring", async () => {
  const path = fresh(),
    store = await openStore({ path, now: () => 1000 }),
    db = await openCache(path)
  try {
    await store.saveMessages(account, "room", [message("1")], { via: "history" })
    db.prepare(
      "INSERT INTO projects (key,name,type,scope,created_at,updated_at) VALUES ('SYN','Synthetic project','work','work',0,0)",
    ).run()
    const chat = Number(db.prepare("SELECT id FROM chats WHERE external_id='room'").get()?.id)
    db.prepare(
      "INSERT INTO links (from_type,from_id,to_type,to_id,kind,source,created_at,updated_at) VALUES ('chat',?,'project',1,'member-of','owner',0,0)",
    ).run(chat)
    const hash = chunkHash("Alice Example: Synthetic text")
    await store.replaceConversations(account, "room", {
      startedAt: 1000,
      algorithmVersion: 1,
      links: [],
      conversations: [["1"]],
      chunks: [[{ firstId: "1", lastId: "1", hash }]],
    })
    expect(db.prepare("SELECT scope,project_id,occurred_at,account_id FROM chunks").get()).toEqual({
      scope: "work",
      project_id: 1,
      occurred_at: 200,
      account_id: 1,
    })
    await store.saveVectors("synthetic", 2, [{ hash, vector: new Float32Array([1, 0]) }])
    const person = String(db.prepare("SELECT person_id FROM identity_links").get()?.person_id)
    const query = { model: "synthetic", query: new Float32Array([1, 0]), limit: 10 }
    expect(
      await store.nearestConversations(account, {
        ...query,
        scope: "work",
        projectId: "1",
        personId: person,
        since: new Date(200).toISOString(),
        before: new Date(201).toISOString(),
      }),
    ).toHaveLength(1)
    expect(await store.nearestConversations(account, { ...query, scope: "personal" })).toEqual([])
    expect(await store.nearestConversations(account, { ...query, projectId: "2" })).toEqual([])
    expect(await store.nearestConversations(account, { ...query, personId: "999" })).toEqual([])
    expect(await store.nearestConversations(account, { ...query, before: new Date(200).toISOString() })).toEqual([])

    db.prepare("UPDATE chats SET scope='personal' WHERE id=?").run(chat)
    expect(await store.nearestConversations(account, { ...query, scope: "personal" })).toHaveLength(1)
    db.prepare("DELETE FROM links WHERE from_type='chat'").run()
    expect(db.prepare("SELECT project_id FROM chunks").get()).toEqual({ project_id: null })

    db.prepare("DELETE FROM messages").run()
    expect([
      db.prepare("SELECT count(*) AS n FROM chunks").get()?.n,
      db.prepare("SELECT count(*) AS n FROM chunk_messages").get()?.n,
    ]).toEqual([0, 0])
    await store.purge(account)
  } finally {
    db.close()
    await store.close()
  }
})

it("keeps attachments with overlapping IDs isolated by their owning type during reads and purge", async () => {
  const path = fresh(),
    store = await openStore({ path }),
    db = await openCache(path)
  try {
    await store.saveMessages(
      account,
      "room",
      [message("1", { attachments: [{ kind: "file", name: "message.txt" }] })],
      { via: "history" },
    )
    db.prepare(
      "INSERT INTO accounts (provider,external_id,created_at,updated_at) VALUES ('folder','synthetic-folder',0,0)",
    ).run()
    db.prepare(
      "INSERT INTO documents (account_id,external_id,kind,created_at,updated_at) VALUES (2,'synthetic-document','file',0,0)",
    ).run()
    db.prepare(
      "INSERT INTO attachments (attachable_type,attachable_id,position,kind,name,created_at,updated_at) VALUES ('document',1,0,'file','document.txt',0,0)",
    ).run()
    expect((await store.messages(account, "room", { limit: 10 })).items[0]?.attachments).toEqual([
      { kind: "file", name: "message.txt" },
    ])
    expect((await store.fileAttachments(account, { limit: 10 })).map((file) => file.name)).toEqual(["message.txt"])
    await store.purge(account)
    expect(db.prepare("SELECT attachable_type,name FROM attachments").all()).toEqual([
      { attachable_type: "document", name: "document.txt" },
    ])
  } finally {
    db.close()
    await store.close()
  }
})
