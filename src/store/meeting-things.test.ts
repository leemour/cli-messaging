import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { sampleMeeting } from "@wirecat/cli-meetings/testing"
import { expect, it } from "vitest"
import { openCache } from "./open.js"
import { referenceOfThing, thingOf } from "./sqlite/things.js"
import { openStore } from "./store.js"

it("persists canonical meeting, retained revision and actual cue references as memory and decision evidence", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "meeting-things-example-")), "store.db")
  let store = await openStore({ path })
  const accountId = await store.saveAccount(
    { provider: "example", account: "alice-example" },
    { name: "Alice Example" },
  )
  const foreignId = await store.saveAccount({ provider: "example", account: "bob-sample" }, { name: "Bob Sample" })
  const input = sampleMeeting()
  input.meeting.accountId = accountId
  input.transcripts[0].rows[0].position = 7
  const saved = await store.meetings.saveMeeting(input)
  const root = `meeting:${accountId}/${saved.meeting.id}`
  const revision = `${root}/${saved.transcripts[0]?.transcript.id}`
  const cue = `${revision}/7`
  const refs = [root, revision, cue]
  const memory = await store.memories.add({
    kind: "fact",
    body: "Alice Example will review",
    scope: "work",
    author: "owner",
    evidence: refs,
    subject: root,
  })
  const decision = await store.decisions.add({ statement: "Bob Sample reviews next", by: "owner", evidence: [cue] })
  await expect(
    store.memories.add({
      kind: "fact",
      body: "Foreign scope",
      scope: "work",
      author: "owner",
      evidence: [`meeting:${foreignId}/${saved.meeting.id}`],
    }),
  ).rejects.toMatchObject({ code: "not_found" })
  await expect(
    store.memories.add({
      kind: "fact",
      body: "Missing cue",
      scope: "work",
      author: "owner",
      evidence: [`${revision}/0`],
    }),
  ).rejects.toMatchObject({ code: "not_found" })
  input.transcripts[0].contentHash = "invented-correction"
  input.transcripts[0].rows[0].text = "Corrected example"
  await store.meetings.saveMeeting(input)
  await store.close()
  store = await openStore({ path })
  try {
    expect((await store.memories.get(memory.ref)).evidence).toEqual(refs)
    expect((await store.memories.get(memory.ref)).subject).toBe(root)
    expect((await store.decisions.get(decision.ref)).evidence).toEqual([cue])
    const db = await openCache(path)
    try {
      for (const ref of refs) {
        const thing = thingOf(db, ref)
        expect(thing).toBeDefined()
        if (thing) expect(referenceOfThing(db, thing)).toBe(ref)
      }
      db.prepare("UPDATE meetings SET deleted_at=1 WHERE id=?").run(saved.meeting.id)
      expect(thingOf(db, cue)).toBeUndefined()
    } finally {
      db.close()
    }
    await expect(
      store.memories.add({ kind: "fact", body: "Deleted example", scope: "work", author: "owner", evidence: [cue] }),
    ).rejects.toMatchObject({ code: "not_found" })
  } finally {
    await store.close()
  }
})
