import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { describe, expect, it } from "vitest"
import type { Messenger } from "../cli/messenger/context.js"
import type { Message } from "../domain/models.js"
import type { SendGuard } from "../sends/guard.js"
import { conversationsService } from "../services/conversations.js"
import { storedDeps } from "../services/deps.js"
import { openStore } from "../store/store.js"
import { chunkHash, chunkTextOf, cutChunks, splitText } from "./chunks.js"

describe("cutChunks", () => {
  it("**cuts a conversation at message boundaries**, each chunk within the limit", () => {
    const lines = [
      { id: "1", sender: "Ana", text: "a".repeat(10) },
      { id: "2", sender: "Bo", text: "b".repeat(10) },
      { id: "3", sender: null, text: "c".repeat(10) },
    ]
    const chunks = cutChunks(lines, 30)
    expect(chunks.map(({ firstId, lastId, text }) => [firstId, lastId, text])).toEqual([
      ["1", "2", `Ana: ${"a".repeat(10)}\nBo: ${"b".repeat(10)}`],
      ["3", "3", "c".repeat(10)],
    ])
    expect(chunks[0]?.hash).toBe(chunkHash(chunks[0]?.text ?? ""))
  })

  it("splits a message longer than the limit into pieces of its own, and skips messages with no text", () => {
    const chunks = cutChunks(
      [
        { id: "1", sender: null, text: "short" },
        { id: "2", sender: null, text: "x".repeat(50) },
        { id: "3", sender: null, text: "  " },
      ],
      20,
    )
    expect(chunks[0]).toMatchObject({ firstId: "1", lastId: "1" })
    expect(chunks[0]?.range).toBeUndefined()
    const pieces = chunks.slice(1)
    expect(pieces.length).toBeGreaterThan(2)
    expect(pieces.every(({ firstId, lastId, text }) => firstId === "2" && lastId === "2" && text.length <= 20)).toBe(
      true,
    )
    expect(pieces[0]?.range?.start).toBe(0)
    expect(pieces.at(-1)?.range?.end).toBe(50)
    expect(cutChunks([{ id: "1", sender: null, text: "" }])).toEqual([])
  })

  it("cuts a long text at paragraphs and sentences, overlapping so a sentence cut in two is whole in one", () => {
    const paragraph = (n: number) => `Paragraph ${n} talks about the harbour plan. It has a second sentence here.`
    const text = Array.from({ length: 12 }, (_, n) => paragraph(n)).join("\n\n")

    const ranges = splitText(text, 300, 60)

    for (const [index, { start, end }] of ranges.entries()) {
      expect(end - start).toBeLessThanOrEqual(300)
      if (index < ranges.length - 1) expect(text.slice(start, end)).toMatch(/[.\n]\s*$/)
      const next = ranges[index + 1]
      if (next) expect(next.start).toBeLessThan(end)
    }
    expect(ranges[0]?.start).toBe(0)
    expect(ranges.at(-1)?.end).toBe(text.length)
  })

  it("keeps the sender on every piece, within the limit", () => {
    const pieces = cutChunks([{ id: "1", sender: "Rin", text: "word ".repeat(100) }], 120)

    expect(pieces.every(({ text }) => text.startsWith("Rin: ") && text.length <= 120)).toBe(true)
  })

  it("rebuilds a piece's text from the message and its range, as the store reads it back", () => {
    const line = { id: "1", sender: "Rin", text: "alpha beta gamma delta ".repeat(20) }
    for (const piece of cutChunks([line], 100)) {
      expect(chunkHash(chunkTextOf([line], piece.range))).toBe(piece.hash)
    }
  })
})

const account = { provider: "test", account: "1" }

const message = (id: string, text: string, replyToId?: string): Message => ({
  id,
  chatId: "9",
  senderId: "100",
  senderName: "Ana",
  timestamp: new Date(Date.parse("2026-10-01T00:00:00Z") + Number(id) * 3_600_000).toISOString(),
  editedAt: null,
  text,
  outgoing: false,
  attachments: [],
  replyTo: null,
  ...(replyToId ? { replyToId } : {}),
  forwardedFrom: null,
  reactions: null,
})

const chunkRows = (path: string) => {
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    return db
      .prepare(
        `SELECT f.external_id AS first, l.external_id AS last, k.content_hash AS hash FROM chunks k
         JOIN chunk_messages r ON r.chunk_id = k.id
         JOIN conversations c ON k.chunkable_type = 'conversation' AND c.id = k.chunkable_id
         JOIN conversation_state s ON s.chat_id = c.chat_id AND s.current_build = c.build
         JOIN messages f ON f.id = r.first_message_id JOIN messages l ON l.id = r.last_message_id
         ORDER BY f.sent_at`,
      )
      .all() as { first: string; last: string; hash: string }[]
  } finally {
    db.close()
  }
}

describe("chunks in a build", () => {
  it("**are written with each build**; a rebuild keeps every hash, an edit changes only its chunk's", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "chunks-")), "m.db")
    const store = await openStore({ path })
    await store.saveChats(account, [
      { id: "9", title: "Group", kind: "group", unreadCount: 0, lastMessageAt: null, participantsCount: null },
    ])
    await store.saveMessages(
      account,
      "9",
      [message("1", "where do we meet"), message("2", "at the station", "1"), message("40", "new topic")],
      { via: "history" },
    )
    const conversations = conversationsService(
      storedDeps({ provider: "test", app: { command: "chat" } } as Messenger, store, account, {} as SendGuard),
    )

    await conversations.build("9")
    const first = chunkRows(path)
    expect(first.map(({ first, last }) => [first, last])).toEqual([
      ["1", "2"],
      ["40", "40"],
    ])
    expect(first[0]?.hash).toBe(chunkHash("Ana: where do we meet\nAna: at the station"))

    await conversations.build("9")
    expect(chunkRows(path)).toEqual(first)

    await store.saveMessages(
      account,
      "9",
      [{ ...message("40", "a new topic"), editedAt: "2026-10-03T00:00:00.000Z" }],
      {
        via: "history",
      },
    )
    await conversations.build("9")
    const edited = chunkRows(path)
    expect(edited[0]).toEqual(first[0])
    expect(edited[1]?.hash).not.toBe(first[1]?.hash)
    await store.close()
  })
})
