import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import type { Message } from "../domain/models.js"
import { openCache } from "./open.js"
import { type AccountKey, openStore } from "./store.js"

const fresh = () => join(mkdtempSync(join(tmpdir(), "conversations-")), "messages.db")
const OWNER: AccountKey = { provider: "tg", account: "1" }

const message = (id: string, replyToId?: string): Message => ({
  id,
  chatId: "-1",
  senderId: "7",
  senderName: "Ana",
  timestamp: `2026-10-01T10:00:0${id}.000Z`,
  editedAt: null,
  text: `message ${id}`,
  outgoing: false,
  attachments: [],
  replyTo: null,
  ...(replyToId ? { replyToId } : {}),
  forwardedFrom: null,
  reactions: null,
})

const withDatabase = async <T>(path: string, body: (run: (sql: string) => Record<string, unknown>[]) => T) => {
  const database = await openCache(path)
  try {
    return body((sql) =>
      database
        .prepare(sql)
        .all()
        .map((row) => ({ ...row })),
    )
  } finally {
    database.close()
  }
}

/** Two messages, the second answering the first, grouped into one conversation of an enabled chat. */
const conversationIn = async (path: string) => {
  const store = await openStore({ path })
  await store.saveChats(OWNER, [
    { id: "-1", title: "Group", kind: "group", unreadCount: 0, lastMessageAt: null, participantsCount: null },
  ])
  await store.saveMessages(OWNER, "-1", [message("1"), message("2", "1")], { via: "history" })
  await store.close()
  await withDatabase(path, (run) => {
    run(`INSERT INTO message_links (chat_id, message_id, parent_id, source, kind, confidence, method, created_at, build,updated_at)
         SELECT m.chat_id, m.id, p.id, 'provider', 'reply', 1, 'reply', 0, 1
         ,0 FROM messages m JOIN messages p ON p.external_id = '1' WHERE m.external_id = '2'`)
    run(`INSERT INTO message_links (chat_id, message_id, parent_id, source, kind, confidence, method, created_at,updated_at)
         SELECT chat_id, id, NULL, 'agent', 'start', 0.9, 'model', 0 ,0 FROM messages WHERE external_id = '1'`)
    run(`INSERT INTO conversations (chat_id, build, first_message_id, first_at, last_at, message_count, built_at, algorithm_version,created_at,updated_at)
         SELECT chat_id, 1, id, sent_at, sent_at, 2, 0, 2 ,0,0 FROM messages WHERE external_id = '1'`)
    run("INSERT INTO conversation_messages (conversation_id, message_id) SELECT 1, id FROM messages")
    run("INSERT INTO conversation_state (chat_id, enabled_at, current_build) SELECT id, 0, 1 FROM chats")
  })
}

const counts = (path: string) =>
  withDatabase(path, (run) =>
    Object.fromEntries(
      ["message_links", "conversations", "conversation_messages", "conversation_state"].map((table) => [
        table,
        Number(run(`SELECT count(*) AS n FROM ${table}`)[0]?.n),
      ]),
    ),
  )

describe("conversation tables (store version 13)", () => {
  it("**go with the account**: a purge removes the messages, and the derived rows follow", async () => {
    const path = fresh()
    await conversationIn(path)
    expect(await counts(path)).toEqual({
      message_links: 2,
      conversations: 1,
      conversation_messages: 2,
      conversation_state: 1,
    })

    const store = await openStore({ path })
    await store.purge(OWNER)
    await store.close()

    expect(await counts(path)).toEqual({
      message_links: 0,
      conversations: 0,
      conversation_messages: 0,
      conversation_state: 0,
    })
    expect(await withDatabase(path, (run) => run("PRAGMA foreign_key_check"))).toEqual([])
  })

  it("hold one link per message, parent, source, kind and build — a start and an agent's link included", async () => {
    const path = fresh()
    await conversationIn(path)
    await withDatabase(path, (run) => {
      expect(() =>
        run(`INSERT INTO message_links (chat_id, message_id, parent_id, source, kind, confidence, method, created_at, build,updated_at)
             SELECT chat_id, message_id, parent_id, source, kind, 0.5, 'again', 1, build ,0 FROM message_links WHERE parent_id IS NOT NULL`),
      ).toThrow(/UNIQUE/)
      expect(() =>
        run(`INSERT INTO message_links (chat_id, message_id, parent_id, source, kind, confidence, method, created_at,updated_at)
             SELECT chat_id, message_id, NULL, source, kind, 0.5, 'again', 1 ,0 FROM message_links WHERE parent_id IS NULL`),
      ).toThrow(/UNIQUE/)
    })
  })
})

describe("chunk tables (store version 14)", () => {
  it("**chunks go with their conversation; vectors stay**, keyed by the text, for a later build to reuse", async () => {
    const path = fresh()
    await conversationIn(path)
    await withDatabase(path, (run) => {
      run(`INSERT INTO chunks (chunkable_type, chunkable_id, position, start_offset, end_offset, content_hash, created_at,
             updated_at) VALUES ('conversation', 1, 0, 0, 1, 'abc', 0, 0)`)
      run(`INSERT INTO chunk_messages (chunk_id, first_message_id, last_message_id)
           SELECT (SELECT id FROM chunks), min(id), max(id) FROM messages`)
      run(`INSERT INTO embeddings (model, content_hash, dims, vector, created_at,updated_at)
           VALUES ('local:e5-small:384', 'abc', 2, x'0000803f00000000', 0,0)`)
    })

    const store = await openStore({ path })
    await store.purge(OWNER)
    await store.close()

    expect(
      await withDatabase(path, (run) => [
        Number(run("SELECT count(*) AS n FROM chunks")[0]?.n),
        Number(run("SELECT count(*) AS n FROM chunk_messages")[0]?.n),
        Number(run("SELECT count(*) AS n FROM embeddings")[0]?.n),
      ]),
    ).toEqual([0, 0, 1])
  })
})
