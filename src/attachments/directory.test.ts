import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import type { Message } from "../domain/models.js"
import { openStore } from "../store/store.js"
import { directoryPaths } from "./directory.js"

const owner = { provider: "chat", account: "synthetic" }
const app = { command: "chat", appName: "chat-cli", envPrefix: "CHAT", description: "", version: "1.0.0" }
const message = (id: string, names: string[]): Message => ({
  id,
  chatId: "1",
  text: "synthetic",
  senderId: "test",
  senderName: null,
  timestamp: "2026-01-01T00:00:00Z",
  outgoing: false,
  editedAt: null,
  replyTo: null,
  forwardedFrom: null,
  reactions: null,
  attachments: names.map((name) => ({ kind: "file", name })),
})
const fixture = async () => {
  const root = mkdtempSync(join(tmpdir(), "directory-matching-"))
  const folder = join(root, "files")
  mkdirSync(folder)
  const store = await openStore({ path: join(root, "fixture.db") })
  await store.saveMessages(owner, "1", [message("1", ["same.txt", "other.txt"]), message("2", ["same.txt"])], {
    via: "history",
  })
  return { store, folder }
}

describe("directory attachment matching", () => {
  it("maps a complete canonical ordinal set instead of crediting duplicated original names", async () => {
    const { store, folder } = await fixture()
    try {
      writeFileSync(join(folder, "1-1-same.txt"), "first")
      writeFileSync(join(folder, "1-2-other.txt"), "second")
      const paths = await directoryPaths(store, owner, "1", folder, app, process.env)
      const held = await store.attachments(owner, { chatId: "1", limit: 10 })
      expect(paths.get(held.find((file) => file.messageId === "1" && file.position === 0)?.pk as number)).toBe(
        join(folder, "1-1-same.txt"),
      )
      expect(paths.get(held.find((file) => file.messageId === "2")?.pk as number)).toBeNull()
      expect(await directoryPaths(store, { ...owner, account: "other" }, "1", folder, app, process.env)).toEqual(
        new Map(),
      )
    } finally {
      await store.close()
    }
  })

  it("refuses an ambiguous original name and duplicate ordinal files", async () => {
    const { store, folder } = await fixture()
    try {
      writeFileSync(join(folder, "same.txt"), "ambiguous")
      await expect(directoryPaths(store, owner, "1", folder, app, process.env)).rejects.toMatchObject({
        code: "validation_error",
      })
      writeFileSync(join(folder, "1-1-a.txt"), "one")
      writeFileSync(join(folder, "1-1-b.txt"), "two")
      await expect(directoryPaths(store, owner, "1", folder, app, process.env)).rejects.toMatchObject({
        code: "validation_error",
      })
    } finally {
      await store.close()
    }
  })

  it("refuses credential and application folders through both typed paths and directory aliases", async () => {
    const { store, folder } = await fixture()
    const env = {
      ...process.env,
      CHAT_CONFIG_DIR: join(folder, "config"),
      CHAT_STATE_DIR: join(folder, "state"),
      CHAT_CACHE_DIR: join(folder, "cache"),
    }
    try {
      for (const [index, directory] of [
        join(folder, ".ssh"),
        join(folder, ".config", "autostart"),
        env.CHAT_CONFIG_DIR,
        env.CHAT_STATE_DIR,
        env.CHAT_CACHE_DIR,
      ].entries()) {
        mkdirSync(directory, { recursive: true })
        const alias = join(folder, `alias-${index}`)
        symlinkSync(directory, alias, "junction")
        for (const path of [directory, alias])
          await expect(directoryPaths(store, owner, "1", path, app, env)).rejects.toThrow("cannot read")
      }
      const allowed = join(folder, ".worktrees")
      mkdirSync(allowed)
      writeFileSync(join(allowed, ".private.txt"), "synthetic")
      await expect(directoryPaths(store, owner, "1", allowed, app, env)).resolves.toBeInstanceOf(Map)
    } finally {
      await store.close()
    }
  })
})
