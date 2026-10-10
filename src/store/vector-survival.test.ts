import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { sampleMeeting } from "@wirecat/cli-meetings/testing"
import { afterEach, describe, expect, it } from "vitest"
import { chunkHash } from "../conversations/chunks.js"
import type { Message } from "../domain/models.js"
import { openSqlite } from "./sqlite/open.js"
import { purgeVectorHashes } from "./sqlite/vectors.js"
import { openStore } from "./store.js"

const opened: { close(): unknown }[] = []
afterEach(async () => {
  for (const handle of opened.splice(0)) await handle.close()
})
const fixture = async () => {
  const path = join(mkdtempSync(join(tmpdir(), "zm-test-vector-survival-")), "fixture.db")
  const store = await openStore({ path, now: () => 1000 })
  opened.push(store)
  const context = { ...(await openSqlite(path)), now: () => 1000 }
  opened.push(context.database)
  return { store, context }
}

describe("shared vector hash survival", () => {
  it("keeps a live note's semantic result after deleting a message sharing the same vector", async () => {
    const { store } = await fixture()
    const text = "Invented shared message and note evidence"
    const hash = chunkHash(text)
    const account = { provider: "example", account: "invented" }
    const message: Message = {
      id: "one",
      chatId: "room",
      senderId: null,
      senderName: null,
      timestamp: "2026-10-11T00:00:00Z",
      editedAt: null,
      text,
      outgoing: false,
      attachments: [],
      replyTo: null,
      forwardedFrom: null,
      reactions: null,
    }
    await store.saveMessages(account, "room", [message], { via: "fixture" })
    await store.replaceConversations(account, "room", {
      startedAt: 1000,
      algorithmVersion: 1,
      links: [],
      conversations: [["one"]],
      chunks: [[{ firstId: "one", lastId: "one", hash }]],
    })
    const note = await store.notes.addNote({ text })
    expect((await store.notes.chunksToEmbed("invented-model", { limit: 1 }))[0]?.hash).toBe(hash)
    await store.saveVectors("invented-model", 2, [{ hash, vector: new Float32Array([1, 0]) }])
    await store.markDeleted(account, ["one"], { chatId: "room" })
    expect((await store.notes.nearest("invented-model", new Float32Array([1, 0]), { limit: 1 }))[0]?.note.id).toBe(
      note.id,
    )
    expect(
      await store.nearestConversations(account, { model: "invented-model", query: new Float32Array([1, 0]), limit: 1 }),
    ).toEqual([])
  })

  for (const corpus of ["note", "document", "meeting_transcript"] as const)
    it(`preserves every model's vector while a ${corpus} chunk still uses the hash`, async () => {
      const { store, context } = await fixture()
      let hash: string
      if (corpus === "note") await store.notes.addNote({ text: "Invented common evidence" })
      if (corpus === "document") {
        const folder = await store.notes.addFolder({ name: "Invented" })
        await store.notes.saveFileNote({
          folderId: folder.id,
          path: "example.md",
          title: "Example",
          text: "Invented common evidence",
        })
      }
      if (corpus === "meeting_transcript") {
        const accountId = await store.saveAccount({ provider: "example", account: "invented" }, { name: "Invented" })
        const sample = sampleMeeting()
        sample.meeting.accountId = accountId
        const saved = await store.meetings.saveMeeting(sample)
        const transcript = saved.transcripts[0]
        if (!transcript) throw new Error("Missing invented transcript")
        hash = "invented-transcript-chunk-hash"
        context.database
          .prepare(
            "INSERT INTO chunks (chunkable_type, chunkable_id, position, start_offset, end_offset, content_hash, created_at, updated_at) VALUES ('meeting_transcript', ?, 0, 0, 20, ?, 1, 1)",
          )
          .run(transcript.transcript.id, hash)
      } else {
        const [chunk] = await store.notes.chunksToEmbed("invented-model", { limit: 1 })
        if (!chunk) throw new Error("Missing invented note chunk")
        hash = chunk.hash
      }
      for (const model of ["invented-model-one", "invented-model-two"])
        await store.saveVectors(model, 2, [{ hash, vector: new Float32Array([1, 0]) }])
      const before = context.database
        .prepare("SELECT * FROM embeddings WHERE content_hash = ? ORDER BY model")
        .all(hash)
      purgeVectorHashes(context, [hash])
      expect(
        context.database.prepare("SELECT * FROM embeddings WHERE content_hash = ? ORDER BY model").all(hash),
      ).toEqual(before)
      context.database.prepare("DELETE FROM chunks WHERE chunkable_type = ? AND content_hash = ?").run(corpus, hash)
      purgeVectorHashes(context, [hash])
      expect(context.database.prepare("SELECT count(*) AS n FROM embeddings WHERE content_hash = ?").get(hash)?.n).toBe(
        0,
      )
    })
})
