import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { captureStreams, memoryKeyring } from "@wirecat/cli-core"
import { beforeEach, describe, expect, it } from "vitest"
import type { Message } from "../../domain/models.js"
import { openStore } from "../../store/index.js"
import { run } from "../program.js"
import { settingsFor } from "../settings.js"
import { botCommand } from "./command.js"
import type { BotAdapter, BotEvent, BotMenuEntry, BotMessenger, BotUpdatesPage, BotWebhook } from "./port.js"
import { botFiles, ChatRegistry } from "./registry.js"
import { BotTokenStore } from "./token.js"

const app = { command: "chat", appName: "chat-cli", envPrefix: "CHAT", description: "A test", version: "1.0.0" }
const config = settingsFor(app)

let root: string
let env: NodeJS.ProcessEnv
let keyring: ReturnType<typeof memoryKeyring>
let calls: string[]
let menu: BotMenuEntry[]
let hooks: hook[]
let webhooks: BotWebhook[]
let pages: BotUpdatesPage[]
let polled: (string | undefined)[]
let stop: AbortController
let failKeep: number
type hook = readonly BotEvent[]

const message = (id: string, text: string): Message => ({
  id,
  chatId: "-100",
  senderId: "42",
  senderName: "Ann",
  timestamp: "2026-10-02T10:00:00.000Z",
  editedAt: null,
  text,
  outgoing: false,
  attachments: [],
  replyTo: null,
  forwardedFrom: null,
  reactions: null,
})

const adapter = (): BotAdapter => ({
  me: async () => ({ id: "bot1", name: "Sales", username: "sales_bot" }),
  close: async () => {},
  menu: async () => menu,
  setMenu: async (entries) => {
    menu = entries
  },
  answer: async (callbackId, { text, notification, press }) => {
    calls.push(
      `answer ${callbackId} ${text ?? "-"} ${notification ?? "-"} ${press ? `${press.chatId}/${press.messageId}` : "-"}`,
    )
  },
  webhooks: async () => webhooks,
  setWebhook: async (url, { types }) => {
    webhooks = [...webhooks, { url, types: types ?? null }]
  },
  deleteWebhook: async (url) => {
    webhooks = webhooks.filter((one) => one.url !== url)
  },
  updates: async (cursor) => {
    polled.push(cursor)
    const page = pages.shift()
    if (!page) {
      stop.abort()
      return { events: [], cursor }
    }
    return page
  },
})

const botWith = (more: Partial<BotMessenger> = {}): BotMessenger => ({
  app,
  provider: "chat-bot",
  name: "Chat",
  resolveSettings: config.resolveSettings,
  connect: async () => adapter(),
  tokenStore: (_command, profile) =>
    new BotTokenStore({ app, profile, env: {}, configDir: join(root, "config"), keyring }),
  keepUpdates: (_command, _profile, events) => {
    if (failKeep > 0) {
      failKeep -= 1
      throw new Error("disk full")
    }
    hooks.push(events)
  },
  ...more,
})

const call = async (argv: string[], bot = botWith(), tty = false) => {
  const streams = captureStreams()
  const code = await run(
    argv,
    { app, commands: () => [botCommand(bot)] },
    { streams, tty, env, ...(argv.includes("watch") ? { signal: stop.signal } : {}) },
  )
  return { code, stdout: streams.stdout, stderr: streams.stderr.join("\n") }
}

const cursorFile = () => botFiles(app, "sales", env).updates

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "bot-watch-"))
  env = { CHAT_CONFIG_DIR: join(root, "config"), CHAT_STATE_DIR: join(root, "state") }
  keyring = memoryKeyring()
  calls = []
  menu = []
  hooks = []
  webhooks = []
  pages = []
  polled = []
  stop = new AbortController()
  failKeep = 0
  new BotTokenStore({ app, profile: "sales", env: {}, configDir: join(root, "config"), keyring }).write("token")
  new ChatRegistry(app, "sales", env).observe([{ id: "-100", title: "Team", kind: "group" }])
})

describe("bot commands", () => {
  it("**replaces the menu** from name=description, lists it, and clears it", async () => {
    const set = await call(["sales", "bot", "commands", "set", "/start=Begin", "help", "--json"])
    expect(set.code).toBe(0)
    expect(menu).toEqual([
      { name: "start", description: "Begin" },
      { name: "help", description: null },
    ])
    expect(JSON.parse((await call(["sales", "bot", "commands", "list", "--json"])).stdout[0] ?? "").items).toHaveLength(
      2,
    )
    await call(["sales", "bot", "commands", "clear"])
    expect(menu).toEqual([])
    expect((await call(["sales", "bot", "commands", "set", "=x"])).code).toBe(2)
  })
})

describe("bot webhooks", () => {
  it("**refuses a second address**, unless the messenger keeps many and --add says so", async () => {
    await call(["sales", "bot", "webhooks", "set", "https://a.example/hook", "--types", "message_created, bot_started"])
    expect(webhooks).toEqual([{ url: "https://a.example/hook", types: ["message_created", "bot_started"] }])

    const refused = await call(["sales", "bot", "webhooks", "set", "https://b.example/hook"])
    expect(refused.code).toBe(7)
    expect(refused.stderr).toContain("chat sales bot webhooks delete")
    expect((await call(["sales", "bot", "webhooks", "set", "https://b.example/hook", "--add"])).code).not.toBe(0)
    expect(webhooks).toHaveLength(1)

    const many = botWith({ manyWebhooks: true })
    expect((await call(["sales", "bot", "webhooks", "set", "https://b.example/hook", "--add"], many)).code).toBe(0)
    expect(webhooks).toHaveLength(2)
    await call(["sales", "bot", "webhooks", "delete", "https://a.example/hook"])
    expect(webhooks.map((one) => one.url)).toEqual(["https://b.example/hook"])
  })

  it("**asks for the secret only once the profile may set a webhook**", async () => {
    mkdirSync(join(root, "config"), { recursive: true })
    writeFileSync(
      join(root, "config", "config.json"),
      JSON.stringify({ bot: { profiles: { sales: { readOnly: true } } } }),
    )
    let asked = false
    const secretive = botWith({
      readSecret: async () => {
        asked = true
        return "s3cret"
      },
    })
    const refused = await call(
      ["sales", "bot", "webhooks", "set", "https://a.example/hook", "--secret-stdin"],
      secretive,
    )

    expect(refused.code).toBe(5)
    expect(asked).toBe(false)
    expect(webhooks).toEqual([])
  })
})

describe("bot watch", () => {
  it("**keeps a batch before printing it**, then moves the cursor; only new messages without --events", async () => {
    pages = [
      {
        events: [
          { event: "message", message: { ...message("7", "hello"), chatTitle: null } },
          { event: "joined", chatId: "-100", person: { id: "43", name: "Bob", username: null } },
        ],
        cursor: "c-1",
      },
    ]
    const watched = await call(["sales", "bot", "watch", "--jsonl"])

    expect(watched.code).toBe(0)
    expect(watched.stdout.map((line) => JSON.parse(line))).toEqual([
      expect.objectContaining({ id: "7", text: "hello", chatTitle: "Team" }),
    ])
    expect(hooks).toHaveLength(1)
    expect(polled).toEqual([undefined, "c-1"])
    expect(JSON.parse(readFileSync(cursorFile(), "utf8"))).toEqual({ marker: "c-1" })
    const kept = await call(["sales", "bot", "messages", "show", "Team", "7", "--offline", "--json"])
    expect(JSON.parse(kept.stdout[0] ?? "")).toMatchObject({ text: "hello" })
  })

  it("**fetches a batch again with the same cursor when it was not kept**, and prints it once", async () => {
    const page: BotUpdatesPage = {
      events: [{ event: "message", message: { ...message("8", "again"), chatTitle: null } }],
      cursor: "c-2",
    }
    pages = [page, page]
    failKeep = 1
    const watched = await call(["sales", "bot", "watch", "--jsonl"])

    expect(watched.stderr).toContain("the updates were not kept")
    expect(polled).toEqual([undefined, undefined, "c-2"])
    expect(watched.stdout).toHaveLength(1)
  }, 10_000)

  it("**skips an update handled before** when the messenger delivers it again", async () => {
    const page: BotUpdatesPage = {
      events: [
        {
          event: "message",
          message: { ...message("9", "once"), chatTitle: null },
          update: { id: "u-9", kind: "message" },
        },
      ],
      cursor: "c-9",
    }
    pages = [page, page]
    const watched = await call(["sales", "bot", "watch", "--jsonl"])

    expect(watched.stdout).toHaveLength(1)
    expect(hooks).toHaveLength(1)
    const store = await openStore()
    try {
      const [update] = store.botUpdates.recent({ provider: "chat-bot", account: "bot1" })
      expect(update).toMatchObject({ externalId: "u-9", kind: "message", error: null })
      expect(update?.handledAt).not.toBeNull()
    } finally {
      await store.close()
    }
  })

  it("**retries an update it failed to keep** instead of skipping it", async () => {
    const page: BotUpdatesPage = {
      events: [
        {
          event: "message",
          message: { ...message("10", "retry"), chatTitle: null },
          update: { id: "u-10", kind: "message" },
        },
      ],
      cursor: "c-10",
    }
    pages = [page, page]
    failKeep = 1
    const watched = await call(["sales", "bot", "watch", "--jsonl"])

    expect(watched.stdout).toHaveLength(1)
    expect(hooks).toHaveLength(1)
    const store = await openStore()
    try {
      const update = store.botUpdates
        .recent({ provider: "chat-bot", account: "bot1" })
        .find(({ externalId }) => externalId === "u-10")
      expect(update).toMatchObject({ error: null })
      expect(update?.handledAt).not.toBeNull()
    } finally {
      await store.close()
    }
  }, 10_000)

  it("**carries on from the marker max-cli wrote**, and names every event with --events", async () => {
    mkdirSync(dirname(cursorFile()), { recursive: true })
    writeFileSync(cursorFile(), `${JSON.stringify({ marker: "m-41" })}\n`)
    pages = [
      {
        events: [
          {
            event: "callback",
            callbackId: "cb-1",
            chatId: "-100",
            messageId: "7",
            from: { id: "42", name: "Ann", username: null },
            data: "yes",
          },
        ],
        cursor: "m-42",
      },
    ]
    const watched = await call(["sales", "bot", "watch", "--events"], botWith(), true)

    expect(polled[0]).toBe("m-41")
    expect(watched.stdout.join("")).toContain("button pressed by Ann in Team: yes (callback cb-1)")
    stop = new AbortController()
    await call(["sales", "bot", "callbacks", "answer", "cb-1", "--text", "Done", "--notification", "Thanks"])
    expect(calls).toEqual(["answer cb-1 Done Thanks -100/7"])
  })

  it("refuses --json, a callback answer with nothing in it, and polling while a webhook is set", async () => {
    expect((await call(["sales", "bot", "watch", "--json"])).code).toBe(2)
    expect((await call(["sales", "bot", "callbacks", "answer", "cb-9"])).code).toBe(2)
    webhooks = [{ url: "https://a.example/hook", types: null }]
    const refused = await call(["sales", "bot", "watch", "--jsonl"])
    expect(refused.code).toBe(2)
    expect(refused.stderr).toContain("chat sales bot webhooks list")
    expect(polled).toEqual([])
  })
})
