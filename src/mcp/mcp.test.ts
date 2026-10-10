import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { Client, type ElicitResult } from "@modelcontextprotocol/client"
import { InMemoryTransport, McpServer } from "@modelcontextprotocol/server"
import { serveStdio } from "@modelcontextprotocol/server/stdio"
import { CliError, captureStreams } from "@wirecat/cli-core"
import { skillResource } from "@wirecat/cli-core/skill"
import { sampleMeeting } from "@wirecat/cli-meetings/testing"
import { Command } from "commander"
import { PNG } from "pngjs"
import { afterEach, describe, expect, it, vi } from "vitest"
import { provide } from "../cli/context.js"
import { type Messenger, messengerContext } from "../cli/messenger/context.js"
import { inboxCommand } from "../cli/messenger/inbox.js"
import { serverEntry } from "../cli/messenger/mcp-command.js"
import { checkPoints } from "../cli/messenger/points.js"
import type { MessengerAdapter, SendOptions } from "../cli/messenger/port.js"
import { reviewCommand } from "../cli/messenger/review.js"
import { createProgram, run } from "../cli/program.js"
import { settingsFor } from "../cli/settings.js"
import { skillCommand } from "../cli/skill-command.js"
import { parseMarkdown } from "../domain/markdown.js"
import type { Chat, Message } from "../domain/models.js"
import { parseLucene } from "../search/lucene/parser.js"
import type { SendGuard } from "../sends/guard.js"
import { SendJournal, sendsPathFor } from "../sends/journal.js"
import { conversationsService } from "../services/conversations.js"
import { storedDeps } from "../services/deps.js"
import { embeddingsService } from "../services/embeddings.js"
import { servicesFor } from "../services/index.js"
import { openStore } from "../store/store.js"
import { pdf } from "../testing/files.js"
import { commandsClient } from "../testing/mcp-commands-client.js"
import { freePort, mcpHttpClient as httpClient } from "../testing/mcp-http-client.js"
import { searchRecipes, seedSearchRecipes } from "../testing/search-recipes.js"
import { serveOverHttp } from "./http/serve.js"
import { instructions } from "./instructions.js"
import {
  type PersonalMcpRegistration,
  personalMcpToolKey,
  personalMcpTools,
  registerPersonalMcpTools,
} from "./personal.js"
import { createServer, type ServerOptions } from "./server.js"

describe("public personal MCP mounting", () => {
  it("encloses online, stored and host-service reads in the host's permission scope", async () => {
    const root = mkdtempSync(join(tmpdir(), "mcp-host-"))
    const env = { MESSAGING_STORE: join(root, "messages.db") }
    const account = { provider: "fixture", account: "500" }
    const opened = await openStore({ env })
    await opened.saveChats(account, [chat])
    await opened.saveMessages(account, "7", [message], { via: "fixture" })
    await opened.close()
    const backend = scripted({ sessions: async () => [] })
    const messenger: Messenger = {
      app,
      provider: "fixture",
      chatArgument: "chat id",
      resolveSettings: settingsFor(app).resolveSettings,
      connect: async () => backend.connect(),
    }
    const all = personalMcpTools(messenger)
    const pick = (name: string) => {
      const one = all[name]
      if (!one) throw new Error(name)
      return one
    }
    const server = new McpServer({ name: "host", version: "0" })
    let allowed = false
    let reads = 0
    const keys: (string | null | undefined)[] = []
    const withStore: PersonalMcpRegistration["withStore"] = async (work) => {
      reads += 1
      const store = await openStore({ env })
      try {
        return await work(store, account)
      } finally {
        await store.close()
      }
    }
    registerPersonalMcpTools(
      server,
      {
        account_sessions: pick("account_sessions"),
        search_messages: pick("search_messages"),
        messages_context: pick("messages_context"),
        messages_send: pick("messages_send"),
      },
      {
        command: "host",
        messenger,
        session: {
          use: async (_name, work) => {
            const adapter = await backend.connect()
            try {
              return await work(adapter, () => adapter.close())
            } finally {
              await adapter.close()
            }
          },
        },
        withStore,
        withServices: (work, options) =>
          withStore(
            (store, account) =>
              work(
                servicesFor(storedDeps(messenger, store, account, { check: () => {}, record: () => {} })),
                async () => {
                  throw new Error("local read connected")
                },
              ),
            options,
          ),
        defaults: {
          limit: 20,
          guard: { check: () => {}, record: () => {} },
          env,
          settings: { profile: "default", configured: {}, shared: {} },
        },
        around: async (name, definition, work) => {
          keys.push(personalMcpToolKey(name, definition))
          if (!allowed) throw new CliError("permission_error", "host denies this operation")
          return work()
        },
      },
    )
    const [serverSide, clientSide] = InMemoryTransport.createLinkedPair()
    await server.connect(serverSide)
    const client = new Client({ name: "fixture", version: "0" })
    await client.connect(clientSide)
    try {
      for (const [name, args] of [
        ["account_sessions", {}],
        ["search_messages", { text: "chapter" }],
        ["messages_context", { chat: "7", message: "1" }],
      ] as const) {
        const result = await client.callTool({ name: `host_${name}`, arguments: args })
        expect(result.isError).toBe(true)
      }
      expect(keys).toContain("account.sessions.list")
      expect(reads).toBe(0)
      expect(backend.opened()).toBe(0)
      allowed = true
      const context = await client.callTool({ name: "host_messages_context", arguments: { chat: "7", message: "1" } })
      expect(context.isError).not.toBe(true)
      expect(context.structuredContent).toMatchObject({ items: [{ id: "1", anchor: true }] })
      expect(backend.opened()).toBe(0)
      const invalid = await client.callTool({
        name: "host_messages_send",
        arguments: { chat: "7", text: "later", at: "2h" },
      })
      expect(invalid.isError).toBe(true)
      expect(backend.opened()).toBe(0)
    } finally {
      await client.close()
      await server.close()
    }
  })
})

const models = vi.hoisted(() => ({ opened: 0, closed: 0 }))
vi.mock("../embeddings/embed.js", async (original) => {
  const real = await original<typeof import("../embeddings/embed.js")>()
  return {
    ...real,
    openEmbedder: async (...args: Parameters<typeof real.openEmbedder>) => {
      models.opened += 1
      const embedder = await real.openEmbedder(...args)
      return {
        ...embedder,
        close: async () => {
          models.closed += 1
          await embedder.close()
        },
      }
    },
  }
})
// The child process runs from dist, which the tests do not build: the server's model runs in this thread here,
// counted as above.
vi.mock("../embeddings/process.js", async () => {
  const { openEmbedder } = await import("../embeddings/embed.js")
  return {
    openProcess: (
      ...[model, directory, { threads }]: Parameters<typeof import("../embeddings/process.js").openProcess>
    ) => openEmbedder(model, directory, { threads }),
  }
})
// The default model is the test fixture: e5-small is not in CI.
vi.mock("../embeddings/models.js", async (original) => {
  const real = await original<typeof import("../embeddings/models.js")>()
  return {
    ...real,
    textModel: (id: string) =>
      id === real.DEFAULT_TEXT_MODEL
        ? {
            id: "tiny",
            title: "a five-word model",
            languages: "test",
            licence: "none",
            dims: 4,
            maxTokens: 64,
            chunksPerSecond: 1,
            pooling: "mean",
            prefix: { query: "", passage: "" },
            onnx: "onnx/model.onnx",
            files: [{ name: "onnx/model.onnx", url: "", sha256: "", bytes: 318 }],
          }
        : real.textModel(id),
  }
})

const app = {
  command: "chat",
  appName: "chat-cli",
  envPrefix: "CHAT",
  description: "A test messenger",
  version: "1.0.0",
}

const chat: Chat = {
  id: "7",
  title: "Book club",
  kind: "group",
  unreadCount: 0,
  lastMessageAt: "2026-09-27T10:00:00.000Z",
  participantsCount: 4,
}
const message: Message = {
  id: "1",
  chatId: "7",
  senderId: "9",
  senderName: "Olga",
  timestamp: "2026-09-27T10:00:00.000Z",
  editedAt: null,
  text: "chapter three is long",
  outgoing: false,
  attachments: [],
  replyTo: null,
  forwardedFrom: null,
  reactions: null,
}

interface Scripted {
  connect: () => Promise<MessengerAdapter>
  opened: () => number
  closed: () => number
}

/** A messenger that counts its connections and fails if two calls overlap on one. */
const scripted = (overrides: Partial<MessengerAdapter> = {}): Scripted => {
  let opened = 0
  let closed = 0
  let busy = false
  const once = async <T>(value: T): Promise<T> => {
    if (busy) throw new Error("two calls at once on one connection")
    busy = true
    await new Promise((resolve) => setTimeout(resolve, 5))
    busy = false
    return value
  }
  const adapter: MessengerAdapter = {
    formatMarkdown: async (text: string) => {
      const parsed = parseMarkdown(text)
      return { text: parsed.text, spans: parsed.markup }
    },
    self: () => "500",
    me: async () => ({ id: "500", name: "Owner", username: null }),
    chats: () => once({ items: [chat], hasMore: true }),
    history: () => once({ items: [message], hasMore: false }),
    resolve: async () => chat,
    chat: async () => ({ ...chat, members: [] }),
    contact: async () => ({
      id: "9",
      name: "Olga",
      username: null,
      description: null,
      lastMessagedAt: null,
      chats: [],
    }),
    around: async () => [{ ...message, anchor: true }],
    send: async () => ({ message, sendId: "1" }),
    logout: async () => {},
    close: async () => {
      closed += 1
    },
    ...overrides,
  }
  return {
    connect: async () => {
      opened += 1
      return adapter
    },
    opened: () => opened,
    closed: () => closed,
  }
}

const READ_ONLY = { profiles: { default: { readOnly: true } } }
const levels = (permissions: Record<string, string>) => ({ profiles: { default: { permissions } } })

const closers: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of closers.splice(0)) await close()
})

interface Harness {
  connect?: Messenger["connect"]
  /** Answers the server's form; without it the client says it cannot show one. */
  form?: (message: string) => ElicitResult
  era?: "legacy" | "modern"
  /** The config file, for a profile's `permissions`, `allow` or `readOnly`. */
  config?: object
  skill?: URL
  history?: Messenger["history"]
  pollQuiz?: boolean
  inviteLinkUpdate?: boolean
  pollVoters?: boolean
  topicShow?: boolean
  forwardTopic?: boolean
  pollCloseSeconds?: readonly [number, number]
  counterFields?: Messenger["counterFields"]
  serverSearch?: boolean
  /** Another server's files, to read what it stored. */
  root?: string
  /** Over `mcp --http` on 127.0.0.1, logged in through the owner login as a browser app would. */
  http?: boolean
  permission?: string[]
}

const connect = async (telegram: Scripted = scripted(), options: Partial<ServerOptions> & Harness = {}) => {
  const root = options.root ?? mkdtempSync(join(tmpdir(), "mcp-"))
  const env = {
    CHAT_STATE_DIR: join(root, "state"),
    CHAT_CONFIG_DIR: join(root, "config"),
    MESSAGING_STORE: join(root, "m.db"),
    CLI_COMMON_CACHE_DIR: join(root, "cache"),
    CHAT_CACHE_DIR: join(root, "chat-cache"),
  }
  const {
    connect: connecting,
    form,
    era = "legacy",
    config,
    skill,
    history,
    serverSearch,
    pollQuiz,
    inviteLinkUpdate,
    pollVoters,
    topicShow,
    forwardTopic,
    pollCloseSeconds,
    counterFields,
    root: _root,
    http,
    permission = [],
    ...serverOptions
  } = options
  if (config) {
    mkdirSync(env.CHAT_CONFIG_DIR, { recursive: true })
    writeFileSync(join(env.CHAT_CONFIG_DIR, "config.json"), JSON.stringify(config))
  }
  const messenger: Messenger = {
    app,
    provider: "chat",
    name: "Chat",
    resolveSettings: settingsFor(app).resolveSettings,
    connect: connecting ?? telegram.connect,
    chatArgument: "a chat",
    ...(skill ? { skill } : {}),
    ...(history ? { history } : {}),
    ...(serverSearch ? { serverSearch } : {}),
    ...(pollQuiz ? { pollQuiz } : {}),
    ...(inviteLinkUpdate ? { inviteLinkUpdate } : {}),
    ...(pollVoters ? { pollVoters } : {}),
    ...(topicShow ? { topicShow } : {}),
    ...(forwardTopic ? { forwardTopic } : {}),
    ...(pollCloseSeconds ? { pollCloseSeconds } : {}),
    ...(counterFields ? { counterFields } : {}),
  }
  const streams = captureStreams()
  let made: ReturnType<typeof createServer> | undefined
  const program = createProgram({
    app,
    commands: () => [
      new Command("probe")
        .option("--permission <key=level>", "override", (value: string, previous: string[]) => [...previous, value], [])
        .action(function (this: Command) {
          made = createServer(this, messengerContext(this, messenger), messenger, serverOptions)
        }),
    ],
  })
  provide(program, { streams, tty: false, env, app })
  await program.parseAsync(["probe", ...permission.flatMap((entry) => ["--permission", entry])], { from: "user" })
  const { session, build, log } = made as ReturnType<typeof createServer>

  if (http) {
    const loginCodes: string[] = []
    const port = await freePort()
    const listening = await serveOverHttp(build, {
      publicUrl: new URL(`http://127.0.0.1:${port}`),
      port,
      tokenFile: join(root, "state", "mcp-http.json"),
      appName: "chat",
      onCode: (code) => loginCodes.push(code),
    })
    const client = await httpClient(listening.url, () => loginCodes.at(-1) ?? "", { era, form })
    const { embedders } = made as ReturnType<typeof createServer>
    closers.push(async () => {
      await client.client.close()
      await listening.close()
      await session.close()
      await embedders.close()
      await log.close()
    })
    const commands = commandsClient(client.client, "chat")
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const result = await commands.callTool({ name, arguments: args })
      const [first] = result.content as { type: string; text: string }[]
      return { isError: result.isError === true, body: JSON.parse(first?.text ?? "null") }
    }
    return {
      client: commands,
      raw: client.client,
      call,
      session,
      embedders,
      streams,
      forms: client.forms,
      env,
      tokens: client.tokens,
    }
  }

  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair()
  // The modern era is chosen by `serveStdio`, as in `mcp`; a server connected directly only speaks the legacy one.
  const served = era === "modern" ? serveStdio(build, { transport: serverSide }) : undefined
  const server = served ? undefined : build()
  await server?.connect(serverSide)
  const client = new Client(
    { name: "test", version: "1.0.0" },
    {
      ...(form ? { capabilities: { elicitation: {} } } : {}),
      ...(era === "modern" ? { versionNegotiation: { mode: { pin: "2026-07-28" } } } : {}),
    },
  )
  const forms: string[] = []
  if (form) {
    client.setRequestHandler("elicitation/create", async (request) => {
      forms.push(request.params.message)
      return form(request.params.message)
    })
  }
  await client.connect(clientSide)
  const { embedders } = made as ReturnType<typeof createServer>
  closers.push(async () => {
    await client.close()
    await server?.close()
    await served?.close()
    await session.close()
    await embedders.close()
    await log.close()
  })
  const commands = commandsClient(client, "chat")
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await commands.callTool({ name, arguments: args })
    const [first] = result.content as { type: string; text: string }[]
    return { isError: result.isError === true, body: JSON.parse(first?.text ?? "null") }
  }
  return { client: commands, raw: client, call, session, embedders, streams, forms, env }
}

/** A store filled the way `serve` fills it: a server-mode session saves what it read. */
const filledRoot = async () => {
  const root = mkdtempSync(join(tmpdir(), "mcp-"))
  const { call } = await connect(
    scripted({ chats: async () => ({ items: [{ ...chat, unreadCount: 1 }], hasMore: false }) }),
    {
      root,
    },
  )
  await call("chat_chats_list")
  await call("chat_messages_list", { chat: "7" })
  return root
}

/** A messenger that records what it was asked to send. */
const sending = () => {
  const sent: ({ chatId: string; text: string } & SendOptions)[] = []
  const telegram = scripted({
    send: async (chatId, text, options) => {
      sent.push({ chatId, text, ...options })
      return { message: { ...message, id: "99", text, outgoing: true }, sendId: options.sendId }
    },
  })
  return { telegram, sent }
}

describe("the MCP server", () => {
  it("ranks and pages evidence over the actual three-tool MCP surface without connecting", async () => {
    const root = await filledRoot()
    const connectSpy = vi.fn(async () => {
      throw new Error("local ranking connected")
    })
    const { call, raw } = await connect(scripted(), { root, connect: connectSpy })
    const top = await call("chat_stats_contacts_top", { measure: "messages", limit: 10 })
    expect(top.isError, JSON.stringify(top.body)).toBe(false)
    const row = top.body.items[0]
    const evidence = await call("chat_stats_contacts_evidence", {
      person: row.id,
      selection: row.drilldown.selection,
      component: "messages",
      limit: 1,
    })
    expect(evidence.isError, JSON.stringify(evidence.body)).toBe(false)
    expect(evidence.body).toMatchObject({ included: 1, total: 1 })
    expect((await raw.listTools()).tools.map(({ name }) => name).sort()).toEqual([
      "chat_read",
      "chat_tools_search",
      "chat_write",
    ])
    expect(connectSpy).not.toHaveBeenCalled()
  })

  it("executes all administrator report schemas over the three-tool surface without connecting", async () => {
    const root = await filledRoot()
    const connectSpy = vi.fn(async () => {
      throw Error("report connected")
    })
    const { call, raw } = await connect(scripted(), { root, connect: connectSpy })
    for (const [name, args] of [
      ["chat_stats_messages_unanswered", { chat: "7", older_than: "1h" }],
      ["chat_stats_contacts_responses", { chat: "7", answerer: ["9"] }],
      ["chat_stats_chats_newcomers", { chat: "7", within: "3d" }],
      ["chat_stats_messages_discussion", { chat: "7", max_replies: 2 }],
    ] as const) {
      const found = await call(name, args)
      expect(found.isError, JSON.stringify(found.body)).toBe(false)
      expect(found.body.quality).toMatchObject({ counterFreshness: "unknown" })
    }
    expect((await raw.listTools()).tools).toHaveLength(3)
    expect(connectSpy).not.toHaveBeenCalled()
  })

  it("runs retention and counter preview/refresh through the three-tool frontend", async () => {
    const root = await filledRoot()
    const fetchCounters = vi.fn(async () => ({
      views: { value: 21, observedAt: new Date().toISOString(), source: "remote_fetch" as const },
    }))
    const backend = scripted({ fetchCounters })
    const { call, raw } = await connect(backend, { root, counterFields: ["views"] })
    const retention = await call("chat_stats_chats_retention", { chat: "7", checkpoints: "1d,7d", within: "7d" })
    expect(retention.isError, JSON.stringify(retention.body)).toBe(false)
    expect(retention.body.quality).toMatchObject({ membership: "observed_checkpoints", continuousSurvival: false })
    const shown = await call("chat_stats_messages_counters_show", { chat: "7", counters: "views", limit: 1 })
    expect(shown.isError, JSON.stringify(shown.body)).toBe(false)
    const preview = await call("chat_stats_messages_counters_refresh", {
      selection: shown.body.selection,
      counters: "views",
      dry_run: true,
      limit: 1,
    })
    expect(preview.isError, JSON.stringify(preview.body)).toBe(false)
    expect(preview.body).toMatchObject({ dryRun: true, supported: ["views"] })
    expect(fetchCounters).not.toHaveBeenCalled()
    const refreshed = await call("chat_stats_messages_counters_refresh", {
      selection: shown.body.selection,
      counters: "views",
      limit: 1,
    })
    expect(refreshed.isError, JSON.stringify(refreshed.body)).toBe(false)
    expect(refreshed.body).toMatchObject({ complete: true, items: [{ updated: ["views"] }] })
    expect(fetchCounters).toHaveBeenCalledOnce()
    expect((await raw.listTools()).tools).toHaveLength(3)
  })

  it("refreshes local search and stats over a held session without marking read", async () => {
    const root = await filledRoot()
    const markRead = vi.fn(async () => {})
    const history = vi.fn(async () => ({ items: [{ ...message, id: "2" }], hasMore: false }))
    const backend = scripted({ history, markRead })
    const { call } = await connect(backend, { root })
    await call("chat_searches_create", { name: "chapter-query", text: "chapter", chat: "7" })
    const search = await call("chat_search_messages", {
      text: "chapter chat:7",
      sync_first: true,
      max_messages: 10,
      sync_time: "1s",
    })
    expect(search.isError).toBe(false)
    expect(search.body).toMatchObject({ refreshed: { chats: ["7"], messages: 1, complete: true } })
    expect(search.body.items.map((hit: { id: string }) => hit.id).sort()).toEqual(["1", "2"])
    const stats = await call("chat_stats_messages_show", { text: "chapter", chat: "7", sync_first: true })
    expect(stats.body.total).toBe(2)
    expect(stats.body.refreshed.complete).toBe(true)
    const saved = await call("chat_search_messages", { saved: "chapter-query", sync_first: true })
    expect(saved.body.refreshed.complete).toBe(true)
    const local = await call("chat_search_messages", { saved: "chapter-query" })
    expect(local.body.refreshed).toBeUndefined()
    expect(history).toHaveBeenCalledTimes(3)
    expect(backend.opened()).toBe(1)
    expect(markRead).not.toHaveBeenCalled()
  })

  it("asks the server beside the archive only where it searches, and marks each hit's source", async () => {
    const root = await filledRoot()
    const searchMessages = vi.fn(async () => ({
      items: [{ ...message, id: "30", text: "chapter thirty", chatTitle: "Book club" }],
      hasMore: false,
      chats: [],
    }))
    const backend = scripted({ searchMessages })
    const { client, call } = await connect(backend, { root, serverSearch: true })
    const found = await call("chat_search_messages", { text: "chapter", backend: "both", server_time: "2s" })
    expect(found.body).toMatchObject({ server: { backend: "both", new: 1, complete: true } })
    expect(found.body.items.map(({ id, source }: { id: string; source: string }) => [id, source]).sort()).toEqual([
      ["1", "archive"],
      ["30", "server"],
    ])
    const { tools } = await client.listTools()
    expect(tools.find((tool) => tool.name === "chat_search_messages")?.inputSchema.properties).toHaveProperty("backend")
    const plain = await connect(scripted(), { root })
    const listed = await plain.client.listTools()
    expect(
      listed.tools.find((tool) => tool.name === "chat_search_messages")?.inputSchema.properties,
    ).not.toHaveProperty("backend")
  })

  it.each(["readonly", "ask", "deny"])(
    "answers from the archive under messages.server-search %s and never asks the server",
    async (level) => {
      const root = await filledRoot()
      const searchMessages = vi.fn()
      const { call } = await connect(scripted({ searchMessages }), {
        root,
        serverSearch: true,
        config: levels({ "messages.server-search": level }),
      })
      const found = await call("chat_search_messages", { text: "chapter", backend: "both" })
      expect(found.body).toMatchObject({ server: { skipped: "not_allowed" }, items: [{ id: "1", source: "archive" }] })
      const strict = await call("chat_search_messages", { text: "chapter", backend: "server" })
      expect(strict.isError).toBe(true)
      expect(searchMessages).not.toHaveBeenCalled()
    },
  )

  it("keeps hits when a refresh connection fails", async () => {
    const root = await filledRoot()
    const backend = scripted()
    const { call } = await connect(backend, {
      root,
      connect: async () => {
        throw new Error("private detail")
      },
    })
    const search = await call("chat_search_messages", { text: "chapter", chat: "7", sync_first: true })
    expect(search.isError).toBe(false)
    expect(search.body).toMatchObject({
      items: [{ id: "1" }],
      coverage: { state: "stale" },
      refreshed: { complete: false },
    })
    expect(JSON.stringify(search.body)).not.toContain("private detail")
  })

  it.each(["readonly", "deny", "ask"])(
    "hides network arguments under messages.sync-first %s while preserving local search",
    async (level) => {
      const root = await filledRoot()
      const backend = scripted()
      const { client, call } = await connect(backend, { root, config: levels({ "messages.sync-first": level }) })
      const { tools } = await client.listTools()
      for (const name of ["chat_search_messages", "chat_stats_messages_show", "chat_search_conversations"]) {
        const schema = tools.find((tool) => tool.name === name)?.inputSchema.properties
        expect(schema).not.toHaveProperty("sync_first")
        expect(schema).not.toHaveProperty("sync_time")
        expect(schema).not.toHaveProperty("max_messages")
      }
      expect((await call("chat_search_messages", { text: "chapter" })).isError).toBe(false)
      expect(
        (await client.callTool({ name: "chat_search_messages", arguments: { text: "chapter", sync_first: true } }))
          .isError,
      ).toBe(true)
      expect(backend.opened()).toBe(0)
    },
  )

  it("conversation sync refresh is separate from local graph freshness", async () => {
    const root = await filledRoot()
    const backend = scripted()
    const { call } = await connect(backend, { root, history: "store" })
    const answer = await call("chat_search_conversations", { query: "chapter", chat: "7", sync_first: true })
    expect(answer.isError).toBe(false)
    expect(answer.body).toMatchObject({
      coverage: { state: "stale" },
      refreshed: { failed: [{ reason: "pushed_history" }] },
    })
    expect(backend.opened()).toBe(0)
  })

  it("offers only reading on a read-only profile, named after the command, each marked read-only", async () => {
    const { client } = await connect(scripted(), { config: READ_ONLY })
    const { tools } = await client.listTools()

    expect(tools.map((one) => one.name).sort()).toEqual([
      "chat_account_sessions",
      "chat_account_show",
      "chat_attachments_list",
      "chat_attachments_show",
      "chat_chats_events",
      "chat_chats_folders_list",
      "chat_chats_folders_show",
      "chat_chats_inspect",
      "chat_chats_link_list",
      "chat_chats_link_show",
      "chat_chats_list",
      "chat_chats_members",
      "chat_chats_members_audit",
      "chat_chats_members_history",
      "chat_chats_requests_list",
      "chat_chats_rules_show",
      "chat_chats_send_as",
      "chat_chats_show",
      "chat_chats_tracking_list",
      "chat_chats_tracking_show",
      "chat_contacts_check",
      "chat_contacts_context",
      "chat_contacts_list",
      "chat_contacts_lookup",
      "chat_contacts_notes_list",
      "chat_contacts_notes_show",
      "chat_contacts_profile",
      "chat_contacts_show",
      "chat_contacts_timeline",
      "chat_conversations_batches_next",
      "chat_conversations_batches_status",
      "chat_conversations_list",
      "chat_conversations_related",
      "chat_conversations_show",
      "chat_conversations_status",
      "chat_inbox",
      "chat_messages_comments",
      "chat_messages_context",
      "chat_messages_evidence",
      "chat_messages_link",
      "chat_messages_list",
      "chat_messages_photo",
      "chat_messages_scheduled",
      "chat_messages_transcribe",
      "chat_metadata_get",
      "chat_polls_show",
      "chat_review",
      "chat_runs_search",
      "chat_search_all",
      "chat_search_conversations",
      "chat_search_mail",
      "chat_search_messages",
      "chat_search_notes",
      "chat_search_topics",
      "chat_searches_history",
      "chat_searches_list",
      "chat_stats_charts",
      "chat_stats_chats_newcomers",
      "chat_stats_chats_retention",
      "chat_stats_chats_show",
      "chat_stats_contacts_evidence",
      "chat_stats_contacts_responses",
      "chat_stats_contacts_top",
      "chat_stats_messages_counters_show",
      "chat_stats_messages_discussion",
      "chat_stats_messages_evidence",
      "chat_stats_messages_show",
      "chat_stats_messages_top",
      "chat_stats_messages_unanswered",
      "chat_stats_tasks_show",
      "chat_status",
      "chat_store_gaps_plan",
      "chat_store_jobs_list",
      "chat_store_jobs_show",
      "chat_tags_list",
      "chat_tasks_list",
      "chat_topics_list",
    ])
    expect(tools.every((one) => one.annotations?.readOnlyHint === true)).toBe(true)
  })

  it("answers chat_status without connecting", async () => {
    const telegram = scripted()
    const { call } = await connect(telegram)

    const { body } = await call("chat_status")

    expect(body).toMatchObject({ profile: "default", account: null, permissions: {} })
    expect(body.writes).toContain("messages send")
    expect(telegram.opened()).toBe(0)
  })

  it("reads forward with after_id on chat_messages_list, and refuses it with before_id", async () => {
    const seen: unknown[] = []
    const { call } = await connect(
      scripted({
        historyAfter: async (_chat, window) => {
          seen.push(window.after)
          return { items: [], hasMore: false }
        },
      }),
    )

    expect((await call("chat_messages_list", { chat: "7", after_id: "12" })).body).toMatchObject({ items: [] })
    expect(seen).toEqual([{ id: "12" }])
    expect((await call("chat_messages_list", { chat: "7", after_id: "12", before_id: "20" })).isError).toBe(true)
  })

  it("takes a message id that is not digits, and refuses one with a space or a control character", async () => {
    const seen: unknown[] = []
    const { call, client } = await connect(
      scripted({
        history: async (_chat, options) => {
          seen.push(options.before)
          return { items: [], hasMore: false }
        },
        historyAfter: async (_chat, window) => {
          seen.push(window.after)
          return { items: [], hasMore: false }
        },
      }),
    )

    expect((await call("chat_messages_list", { chat: "7", before_id: "urn:li:msg:4F2" })).isError).toBe(false)
    expect((await call("chat_messages_list", { chat: "7", after_id: "wamid.HBgL" })).isError).toBe(false)
    expect(seen).toEqual(["urn:li:msg:4F2", { id: "wamid.HBgL" }])
    for (const before_id of ["4 2", "42\u0007", "", "9".repeat(257)]) {
      const refused = await client.callTool({ name: "chat_messages_list", arguments: { chat: "7", before_id } })
      expect(refused.isError).toBe(true)
    }
    expect(seen).toHaveLength(2)
  })

  it("audits a group's members with chat_chats_members_audit, a page at a time", async () => {
    const pages: unknown[] = []
    const { call } = await connect(
      scripted({
        members: async (_chat, window) => {
          pages.push(window)
          return { chatId: "7", hasMore: false, items: [{ id: "40", name: "", username: null, isBot: true }] }
        },
      }),
    )

    const { body } = await call("chat_chats_members_audit", { chat: "7", budget: 1 })

    expect(body).toMatchObject({ chatId: "7", read: 1, more: false, items: [{ id: "40", score: 4 }] })
    expect(body.unknown).toContain("never_wrote")
    expect(pages).toEqual([{ limit: 200, offset: 0 }])
  })

  it("lists a forum's topics with chat_topics_list, and finds them by title with chat_search_topics", async () => {
    const seen: unknown[] = []
    const topic = {
      id: "4",
      title: "Pisos",
      closed: false,
      pinned: false,
      unreadCount: 0,
      lastMessageAt: null,
      createdAt: null,
    }
    const { call } = await connect(
      scripted({
        topics: async (_chat, window) => {
          seen.push(window)
          return { items: [topic], hasMore: false }
        },
      }),
    )

    expect((await call("chat_search_topics", { chat: "7", text: "pis", limit: 5 })).body).toEqual({
      items: [topic],
      page: 1,
      limit: 5,
      hasMore: false,
    })
    expect((await call("chat_topics_list", { chat: "7", limit: 5 })).body).toMatchObject({ items: [topic] })
    expect((await call("chat_topics_list", { chat: "7", search: "pis" })).isError).toBe(true)
    expect(seen).toEqual([
      { limit: 5, offset: 0, search: "pis" },
      { limit: 5, offset: 0 },
    ])
  })

  it("filters chat_chats_list, and says when the messenger could not list every chat", async () => {
    const { call } = await connect(scripted())

    const { body } = await call("chat_chats_list", { kind: "channel" })

    expect(body).toMatchObject({ items: [], hasMore: false, partial: true })
  })

  it("answers listings in the command's envelope, and connects once for several calls", async () => {
    const telegram = scripted()
    const { call } = await connect(telegram)

    expect((await call("chat_chats_list", { limit: 1, page: 2 })).body).toEqual({
      items: [chat],
      page: 2,
      limit: 1,
      hasMore: true,
    })
    expect((await call("chat_messages_list", { chat: "Book club" })).body).toEqual({
      items: [message],
      page: 1,
      limit: 20,
      hasMore: false,
    })
    expect((await call("chat_status")).body.account).toBe("500")
    expect(telegram.opened()).toBe(1)
  })

  it("returns message links through the same read-only service and refuses account mismatch", async () => {
    const permalink = vi.fn(async () => ({
      url: "https://provider.example/1",
      access: "restricted" as const,
      reason: null,
    }))
    const { call, client } = await connect(scripted({ permalink }))
    const offered = (await client.listTools()).tools.find((one) => one.name === "chat_messages_link")
    expect(offered?.annotations?.readOnlyHint).toBe(true)
    expect((await call("chat_messages_link", { chat: "7", message: "1" })).body).toEqual({
      locator: "msg:chat/500/7/1",
      url: "https://provider.example/1",
      access: "restricted",
      reason: null,
    })
    expect((await call("chat_messages_link", { chat: "msg:chat/500/7/1" })).body.locator).toBe("msg:chat/500/7/1")
    const mismatch = await client.callTool({ name: "chat_messages_link", arguments: { chat: "msg:chat/other/7/1" } })
    expect(mismatch.isError).toBe(true)
    expect(permalink).toHaveBeenCalledTimes(2)
  })

  it("lists contacts as the one-to-one chats, and shows one person", async () => {
    const dialogs: Chat[] = [
      { ...chat, id: "20", kind: "dialog", title: "Zoe" },
      { ...chat, id: "21", kind: "dialog", title: "Adam", lastMessageAt: "2026-09-26T09:00:00.000Z" },
    ]
    const { call } = await connect(scripted({ chats: async () => ({ items: [chat, ...dialogs], hasMore: false }) }))

    const listed = await call("chat_contacts_list", { order: "name", limit: 1 })
    expect(listed.body).toMatchObject({ items: [{ name: "Adam" }], page: 1, limit: 1, hasMore: true })
    expect((await call("chat_contacts_list", { search: "zo" })).body.items).toMatchObject([{ name: "Zoe" }])
    expect((await call("chat_contacts_show", { person: "Olga" })).body).toMatchObject({ id: "9", name: "Olga" })
  })

  it("profiles a person with the phone always masked", async () => {
    const { call } = await connect(
      scripted({
        profile: async () => ({
          id: "9",
          name: "Olga",
          usernames: [],
          bio: null,
          phone: "0123",
          flags: { scam: false },
          seen: "week",
          chats: [{ id: "7", title: "Book club", kind: "group", lastMessageAt: null }],
        }),
      }),
    )

    const { body } = await call("chat_contacts_profile", { person: "Olga" })

    expect(body).toMatchObject({ id: "9", phone: "***0123", seen: "week" })
    expect(body.chats).toMatchObject([{ id: "7", kind: "group" }])
  })

  it("runs calls that arrive together one after another, over the one connection", async () => {
    const telegram = scripted()
    const { call } = await connect(telegram)

    const answers = await Promise.all([call("chat_chats_list"), call("chat_messages_list", { chat: "7" })])

    expect(answers.map((one) => one.isError)).toEqual([false, false])
    expect(telegram.opened()).toBe(1)
  })

  it("executes documented recipes with identical ids through MCP text and structured AST", async () => {
    const telegram = scripted()
    const { call, env } = await connect(telegram)
    await call("chat_chats_list")
    const store = await openStore({ path: env.MESSAGING_STORE })
    await seedSearchRecipes(store, { provider: "chat", account: "500" })
    await store.close()
    const opened = telegram.opened()
    for (const recipe of searchRecipes.recipes) {
      const textual = await call("chat_search_messages", { text: recipe.query, language: "lucene", timezone: "UTC" })
      const structured = await call("chat_search_messages", { ast: parseLucene(recipe.query), timezone: "UTC" })
      expect(textual.isError, recipe.title).toBe(false)
      expect(structured.body).toEqual(textual.body)
      expect(textual.body.items.map((item: { id: string }) => item.id).sort()).toEqual(recipe.ids)
      expect(textual.body).toMatchObject({
        page: 1,
        query: { language: "lucene-v1", timezone: "UTC" },
        coverage: { coveredChats: recipe.query.startsWith("chat:") ? 1 : 3 },
      })
    }
    expect(telegram.opened()).toBe(opened)
    expect((await call("chat_search_messages", {})).isError).toBe(true)
    expect((await call("chat_search_messages", { text: "invoice", ast: parseLucene("invoice") })).isError).toBe(true)
  })

  it("searches what an earlier read kept, without connecting for it", async () => {
    const telegram = scripted()
    const { call } = await connect(telegram)
    await call("chat_messages_list", { chat: "7" })

    const { body } = await call("chat_search_messages", { text: "chapter" })

    expect(body.items.map((hit: { id: string }) => hit.id)).toEqual(["1"])
    expect(body).toMatchObject({ corrections: [], completeness: [{ chatId: "7" }], wordsReady: true })
    expect(body).toMatchObject({ query: { language: "lucene-v1" }, page: 1 })
    const typo = await call("chat_search_messages", { text: "chaptre", context: 1, language: "legacy" })
    expect(typo.body).toMatchObject({ corrections: [{ from: "chaptre", to: ["chapter"] }] })
    expect(typo.body.items[0].context).toEqual(expect.any(Array))
    expect((await call("chat_search_messages", { text: "chapter", source: "all" })).body.items).toHaveLength(1)
    const unheld = await call("chat_search_messages", { text: "chapter", source: "nowhere" })
    expect(unheld.isError).toBe(true)
    expect(JSON.stringify(unheld.body)).toContain('--source takes chat, personal, bots, all — not \\"nowhere\\"')
    expect(telegram.opened()).toBe(1)
  })

  it("search_all answers messages and notes together, typed; search_mail says when no mail is held", async () => {
    const telegram = scripted()
    const { call } = await connect(telegram)
    await call("chat_messages_list", { chat: "7" })
    await call("chat_search_notes", { text: "chapter" })

    const all = await call("chat_search_all", { text: "chapter" })
    expect(all.body.items.map((item: { kind: string }) => item.kind)).toContain("message")
    expect(all.body.searched).toEqual(["messages", "notes"])
    expect(all.body.skipped).toEqual([{ resource: "mail", reason: expect.stringContaining("memo mail import") }])
    const notes = await call("chat_search_notes", { text: "chapter" })
    expect(notes.body).toMatchObject({ by: "words", hits: [] })
    const mail = await call("chat_search_mail", { text: "chapter" })
    expect(mail.isError).toBe(true)
    expect(JSON.stringify(mail.body)).toContain("memo mail import")
    expect(telegram.opened()).toBe(1)
  })

  it("search_all takes meetings: the one stored meeting account, or one named; never without asking", async () => {
    const telegram = scripted()
    const { call, env } = await connect(telegram)
    await call("chat_messages_list", { chat: "7" })
    const store = await openStore({ path: env.MESSAGING_STORE })
    try {
      const accountId = await store.saveAccount({ provider: "zoom", account: "zm-profile:alice" }, { name: null })
      const sample = sampleMeeting()
      await store.meetings.saveMeeting({
        ...sample,
        meeting: { ...sample.meeting, accountId },
        transcripts: [
          { ...sample.transcripts[0], rows: [{ ...sample.transcripts[0].rows[0], text: "Bob Sample on the chapter" }] },
        ],
      })
    } finally {
      await store.close()
    }

    const plain = await call("chat_search_all", { text: "chapter" })
    expect(plain.body.items.map((item: { kind: string }) => item.kind)).not.toContain("meeting")
    for (const meetings of [true, "zoom:zm-profile:alice"]) {
      const found = await call("chat_search_all", { text: "chapter", meetings })
      expect(found.isError).toBe(false)
      expect(found.body.searched).toContain("meetings")
      expect(found.body.items).toContainEqual(
        expect.objectContaining({ kind: "meeting", provider: "zoom", text: "Bob Sample on the chapter" }),
      )
    }
    const unasked = await call("chat_search_all", { text: "chapter", only: ["meetings"] })
    expect(unasked.isError).toBe(true)
    expect(JSON.stringify(unasked.body)).toContain("needs meetings")
    const every = await call("chat_search_all", { text: "chapter", meetings: true, max_meetings: "all" })
    expect(every.body.meetings).toMatchObject({ complete: true })
    const bounded = await call("chat_search_all", { text: "chapter", max_meetings: 5 })
    expect(bounded.isError).toBe(true)
    expect(JSON.stringify(bounded.body)).toContain("max_meetings needs meetings")
  })

  it("prepares stored evidence with a cursor and typed failures without connecting", async () => {
    const root = await filledRoot()
    const telegram = scripted()
    const { call, client, env } = await connect(telegram, { root, config: levels({ messages: "readonly" }) })
    const store = await openStore({ path: env.MESSAGING_STORE })
    try {
      await store.saveMessages({ provider: "chat", account: "500" }, "7", [{ ...message, id: "2" }], { via: "test" })
    } finally {
      await store.close()
    }
    const evidence = (await client.listTools()).tools.find((one) => one.name === "chat_messages_evidence")
    expect(evidence?.annotations).toMatchObject({ readOnlyHint: true })
    const first = await call("chat_messages_evidence", { chat: "Book", limit: 1 })
    expect(first.isError).toBe(false)
    expect(first.body).toMatchObject({
      kind: "chats",
      source: { provider: "chat", account: "500", chat: "7" },
      nextBeforeId: "2",
      items: [{ locator: "msg:chat/500/7/2" }],
      coverage: { hasMore: true, history: "unknown" },
    })
    const next = await call("chat_messages_evidence", { chat: "7", before_id: first.body.nextBeforeId })
    expect(next.body).toMatchObject({ nextBeforeId: null, items: [{ locator: "msg:chat/500/7/1" }] })
    const invalid = await call("chat_messages_evidence", { chat: "7", before_id: "missing" })
    expect(invalid.isError).toBe(true)
    expect(invalid.body.error.code).toBe("not_found")
    expect(
      (await client.callTool({ name: "chat_messages_evidence", arguments: { chat: "7", limit: 101 } })).isError,
    ).toBe(true)
    expect(telegram.opened()).toBe(0)
  })

  it("removes the evidence tool when the messages permission is denied", async () => {
    const telegram = scripted()
    const { client } = await connect(telegram, { config: levels({ messages: "deny" }) })
    expect((await client.listTools()).tools.map(({ name }) => name)).not.toContain("chat_messages_evidence")
    expect((await client.listTools()).tools.map(({ name }) => name)).not.toContain("chat_stats_charts")
    expect(telegram.opened()).toBe(0)
  })

  it.each(["legacy", "modern"] as const)("returns a chart image over the %s MCP transport", async (era) => {
    const telegram = scripted()
    const { client, call } = await connect(telegram, { era })
    await call("chat_messages_list", { chat: "7" })
    const opened = telegram.opened()
    const result = await client.callTool({ name: "chat_stats_charts", arguments: { chat: "7", format: "png" } })
    expect(result.isError).not.toBe(true)
    const content = result.content as { type: string; data?: string; mimeType?: string; text?: string }[]
    expect(content[0]).toMatchObject({ type: "image", mimeType: "image/png" })
    expect([...Buffer.from(content[0]?.data ?? "", "base64").subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10])
    expect(JSON.parse(content[1]?.text ?? "null")).toMatchObject({
      chart: { version: 1, kind: "bar" },
      image: { format: "png", width: 800, height: 400 },
    })
    expect(telegram.opened()).toBe(opened)
  })

  it("answers member history and the tracking list from the store, empty before any fetch", async () => {
    const { call } = await connect(scripted())
    await call("chat_messages_list", { chat: "7" })

    expect((await call("chat_chats_members_history", { chat: "7" })).body).toEqual({ chatId: "7", items: [] })
    expect((await call("chat_chats_tracking_list")).body).toEqual({ items: [] })
    expect((await call("chat_chats_tracking_show", { chat: "7" })).body).toEqual({
      chatId: "7",
      trackedAt: null,
      counts: [],
    })
  })

  it("offline ordinary context reads stored messages without another connection", async () => {
    const backend = scripted()
    const { call } = await connect(backend)
    await call("chat_messages_list", { chat: "7" })
    const opened = backend.opened()
    expect((await call("chat_messages_context", { chat: "msg:chat/500/7/1", offline: true })).body.items).toMatchObject(
      [{ id: "1", anchor: true }],
    )
    expect((await call("chat_messages_context", { chat: "msg:chat/501/7/1", offline: true })).body.error.code).toBe(
      "validation_error",
    )
    expect(backend.opened()).toBe(opened)
  })

  it("ordinary context accepts only active-account locators, through the same service as CLI", async () => {
    let reads = 0
    const { call } = await connect(
      scripted({
        around: async () => {
          reads++
          return [{ ...message, anchor: true }]
        },
      }),
    )
    await call("chat_messages_list", { chat: "7" })
    expect((await call("chat_messages_context", { chat: "msg:chat/501/7/1" })).body.error.code).toBe("validation_error")
    expect(reads).toBe(0)
    expect((await call("chat_messages_context", { chat: "msg:chat/500/7/1" })).body.items).toMatchObject([
      { id: "1", anchor: true },
    ])
    expect(reads).toBe(1)
  })

  it("lists and shows a built chat's conversations from the store, and names the build command before that", async () => {
    const telegram = scripted()
    const { call, env } = await connect(telegram)
    await call("chat_messages_list", { chat: "7" })

    const before = await call("chat_conversations_list", { chat: "7" })
    expect(before.isError).toBe(true)
    expect(JSON.stringify(before.body)).toContain("conversations build --chat 7")

    const store = await openStore({ path: env.MESSAGING_STORE })
    const account = { provider: "chat", account: "500" }
    await conversationsService(storedDeps({ provider: "chat" } as Messenger, store, account, {} as SendGuard)).build(
      "7",
    )
    await store.close()

    const { body } = await call("chat_conversations_list", { chat: "7" })
    expect(body.items).toMatchObject([{ firstMessageId: "1", messageCount: 1 }])
    const shown = await call("chat_conversations_show", { id: body.items[0].id })
    expect(shown.body.messages.map((one: { id: string }) => one.id)).toEqual(["1"])
    expect((await call("chat_conversations_show", { chat: "7" })).isError).toBe(true)
    expect((await call("chat_conversations_status", {})).body).toMatchObject({
      items: [{ chat: "7", state: "words-only", pending: { new: 0 } }],
      hasMore: false,
    })
  })

  it("thread context and search use the same stored graph and never mark read or infer", async () => {
    const records = [
      ["1", undefined],
      ["2", undefined],
      ["3", "1"],
      ["4", "2"],
      ["5", "3"],
      ["6", "1"],
    ].map(([id, parent], i) => ({
      ...message,
      id: id as string,
      senderId: String(10 + i),
      text: `synthetic graph message ${id}`,
      timestamp: new Date(Date.parse(message.timestamp) + i * 600_000).toISOString(),
      ...(parent ? { replyToId: parent } : {}),
    }))
    const markRead = vi.fn(async () => {})
    const backend = scripted({ history: async () => ({ items: records, hasMore: false }), markRead })
    const { call, session, env } = await connect(backend)
    await call("chat_messages_list", { chat: "7" })
    await call("chat_conversations_build", { chat: "7" })
    await session.close()
    const inferred = models.opened
    const context = await call("chat_messages_context", { chat: "7", message: "5", thread: true })
    expect(context.isError).toBe(false)
    expect(context.body.items.map((item: { id: string }) => item.id)).toEqual(["1", "3", "5", "6"])
    expect(context.body).toMatchObject({ mode: "thread", chain: ["3", "1"], stale: false })
    const located = await call("chat_messages_context", { chat: "msg:chat/500/7/5", thread: true })
    expect(located.body).toEqual(context.body)
    expect((await call("chat_messages_context", { chat: "msg:chat/600/7/5", thread: true })).isError).toBe(true)
    const search = await call("chat_search_messages", { text: 'text:"synthetic graph message 5"', thread: true })
    expect(search.body.items[0].thread).toEqual(context.body)
    const capped = await call("chat_messages_context", { chat: "7", message: "5", thread: true, thread_hops: 0 })
    expect(capped.body).toMatchObject({ items: [{ id: "5" }], stopped: ["hops"] })
    expect(markRead).not.toHaveBeenCalled()
    expect(models.opened).toBe(inferred)
    expect(backend.opened()).toBe(1)
    const store = await openStore({ env })
    try {
      const direct = servicesFor(
        storedDeps(
          { app, provider: "chat" } as Messenger,
          store,
          { provider: "chat", account: "500" },
          {} as SendGuard,
        ),
      )
      expect(await direct.messages.thread("7", "5")).toEqual(context.body)
    } finally {
      await store.close()
    }
  })

  it("read-only MCP thread context falls back locally when there is no graph", async () => {
    const root = await filledRoot()
    const backend = scripted()
    const { call } = await connect(backend, { root, config: levels({ messages: "readonly" }) })
    const found = await call("chat_messages_context", {
      chat: "7",
      message: "1",
      thread: true,
      thread_bytes: 1000,
      thread_within: "1d",
    })
    expect(found.isError).toBe(false)
    expect(found.body).toMatchObject({ mode: "time", fallback: "not_built", items: [{ id: "1", anchor: true }] })
    expect(backend.opened()).toBe(0)
    expect((await call("chat_messages_context", { chat: "7" })).isError).toBe(true)
    expect(backend.opened()).toBe(0)
  })

  it("agent links over MCP and rebuilds a synthetic tangled chat without inference or messenger writes", async () => {
    const telegram = scripted({
      history: async () => ({
        items: [
          { ...message, id: "1", senderId: "10", text: "Which train goes to the museum?" },
          { ...message, id: "2", senderId: "11", text: "The bread needs another ten minutes." },
          { ...message, id: "3", senderId: "12", text: "Take the blue line and change at North." },
          { ...message, id: "4", senderId: "13", text: "I will take it out of the oven then." },
        ],
        hasMore: false,
      }),
    })
    const { call, client, streams } = await connect(telegram)
    await call("chat_messages_list", { chat: "7" })
    const opened = telegram.opened()
    const inferred = models.opened
    const prompt = (await client.getPrompt({ name: "link-conversations" })).messages[0]
    expect(prompt?.content).toMatchObject({ type: "text", text: expect.stringContaining("Wait for a yes") })
    expect((await call("chat_conversations_build", { chat: "7" })).body.conversations).toBe(4)
    expect((await call("chat_conversations_batches_status", { chat: "7" })).body).toMatchObject({
      messages: 4,
      batches: 1,
      characters: expect.any(Number),
      tokensEstimate: expect.any(Number),
    })
    const batch = (await call("chat_conversations_batches_next", { chat: "7", size: 10 })).body
    const answers = [
      { message: "1", parent: null, confidence: 1 },
      { message: "2", parent: null, confidence: 1 },
      { message: "3", parent: "1", confidence: 0.9 },
      { message: "4", parent: "2", confidence: 0.9 },
    ]
    const invalid = await call("chat_conversations_links_add", {
      batch: batch.batch,
      model: "synthetic-agent",
      answers: [answers[0], { message: "2", parent: "4", confidence: 1 }],
    })
    expect(invalid.isError).toBe(true)
    expect((await call("chat_conversations_batches_status", { chat: "7" })).body.messages).toBe(4)
    expect(
      (
        await call("chat_conversations_links_add", {
          batch: batch.batch,
          model: "synthetic-agent",
          skill: "1",
          answers,
        })
      ).body.stored,
    ).toBe(4)
    expect((await call("chat_conversations_batches_next", { chat: "7" })).body).toEqual({ batch: null })
    expect((await call("chat_conversations_build", { chat: "7" })).body.conversations).toBe(2)
    for (const [root, members] of [
      ["1", ["1", "3"]],
      ["2", ["2", "4"]],
    ] as const) {
      const shown = (await call("chat_conversations_show", { chat: "7", message: root })).body
      expect(shown.messages.map((one: Message) => one.id)).toEqual(members)
    }
    expect((await call("chat_conversations_links_clear", { chat: "7", model: "other" })).body.cleared).toBe(0)
    expect((await call("chat_conversations_links_clear", { chat: "7", model: "synthetic-agent" })).body.cleared).toBe(4)
    expect((await call("chat_conversations_build", { chat: "7" })).body.conversations).toBe(4)
    expect(telegram.opened()).toBe(opened)
    expect(models.opened).toBe(inferred)
    expect(streams.stderr.join("\n")).not.toContain("oven")
  })

  it("refuses a stale MCP batch atomically when the chat changes", async () => {
    const { call, env } = await connect(scripted())
    await call("chat_messages_list", { chat: "7" })
    const batch = (await call("chat_conversations_batches_next", { chat: "7" })).body.batch
    const store = await openStore({ path: env.MESSAGING_STORE })
    await store.markDeleted({ provider: "chat", account: "500" }, ["1"], { chatId: "7" })
    await store.close()
    const result = await call("chat_conversations_links_add", {
      batch,
      model: "synthetic-agent",
      answers: [{ message: "1", parent: null, confidence: 1 }],
    })
    expect(result.isError).toBe(true)
    expect((await call("chat_conversations_batches_next", { chat: "7" })).body).toEqual({ batch: null })
  })

  it("hides local graph writes on readonly, goes ahead at ask, and keeps batches readable", async () => {
    for (const level of ["readonly", "deny", "ask", "allow"]) {
      const { client, call } = await connect(scripted(), { config: levels({ "conversations.links": level }) })
      const names = (await client.listTools()).tools.map(({ name }) => name)
      expect(names).toContain("chat_conversations_batches_status")
      expect(names).toContain("chat_conversations_batches_next")
      for (const tool of ["build", "links_add", "links_clear"]) {
        expect(names.includes(`chat_conversations_${tool}`)).toBe(level === "allow" || level === "ask")
      }
      if (level === "ask") {
        await call("chat_messages_list", { chat: "7" })
        for (const [tool, args] of [
          ["build", { chat: "7" }],
          ["links_clear", { chat: "7" }],
          ["links_add", { batch: "bad", model: "synthetic", answers: [] }],
        ] as const) {
          expect((await call(`chat_conversations_${tool}`, args)).body?.error?.code).not.toBe("confirmation_required")
        }
      }
    }
  })

  it("loads the model once for every search_conversations, and lets it go when the server closes", async () => {
    const { call, env, embedders } = await connect(
      scripted({
        history: async () => ({ items: [{ ...message, senderName: null, text: "cat dog" }], hasMore: false }),
      }),
    )
    await call("chat_messages_list", { chat: "7" })
    mkdirSync(join(env.CLI_COMMON_CACHE_DIR, "models", "text"), { recursive: true })
    symlinkSync(
      fileURLToPath(new URL("../embeddings/fixtures/tiny", import.meta.url)),
      join(env.CLI_COMMON_CACHE_DIR, "models", "text", "tiny"),
    )
    vi.stubEnv("CLI_COMMON_CACHE_DIR", env.CLI_COMMON_CACHE_DIR)
    const store = await openStore({ path: env.MESSAGING_STORE })
    const deps = storedDeps(
      { provider: "chat", app } as Messenger,
      store,
      { provider: "chat", account: "500" },
      {} as SendGuard,
    )
    await conversationsService(deps).build("7")
    await embeddingsService(deps).embed("7", { threads: 1 })
    await store.close()
    models.opened = 0
    models.closed = 0

    const [first, second] = await Promise.all([
      call("chat_search_conversations", { query: "cat" }),
      call("chat_search_conversations", { query: "dog", chat: "7" }),
    ])
    const third = await call("chat_search_conversations", { query: "cat dog" })

    expect([first, second, third].map(({ body }) => body.items.length)).toEqual([1, 1, 1])
    expect(third.body).toMatchObject({ meaning: "searched", readiness: { searchedByMeaning: ["7"], stale: [] } })
    const related = await call("chat_conversations_related", { chat: "7", message: message.id })
    expect(related.body).toMatchObject({ model: "tiny", source: { chatId: "7" }, items: [], readiness: { stale: [] } })
    expect(models).toEqual({ opened: 1, closed: 0 })
    await embedders.close()
    expect(models.closed).toBe(1)
    vi.unstubAllEnvs()
  })

  it("**brings conversations up to date** with conversations_refresh, on the warm model, writing only to the store", async () => {
    const telegram = scripted({
      history: async () => ({ items: [{ ...message, senderName: null, text: "cat dog" }], hasMore: false }),
    })
    const { client, call, env, embedders } = await connect(telegram)
    await call("chat_chats_list")
    await call("chat_messages_list", { chat: "7" })
    mkdirSync(join(env.CLI_COMMON_CACHE_DIR, "models", "text"), { recursive: true })
    symlinkSync(
      fileURLToPath(new URL("../embeddings/fixtures/tiny", import.meta.url)),
      join(env.CLI_COMMON_CACHE_DIR, "models", "text", "tiny"),
    )
    vi.stubEnv("CLI_COMMON_CACHE_DIR", env.CLI_COMMON_CACHE_DIR)
    const opened = telegram.opened()
    models.opened = 0

    const refresh = (await client.listTools()).tools.find(({ name }) => name === "chat_conversations_refresh")
    expect(refresh?.annotations).toMatchObject({ readOnlyHint: false })
    expect((await call("chat_conversations_refresh", { max_chunks: 1 })).body).toMatchObject({
      model: "tiny",
      modelAvailable: true,
      built: [{ chat: "7", messages: 1 }],
      embedded: [{ chat: "7", embedded: 1 }],
      left: [],
    })
    expect((await call("chat_search_conversations", { query: "cat" })).body).toMatchObject({
      readiness: { searchedByMeaning: ["7"], partial: [], stale: [] },
    })
    expect([telegram.opened(), models.opened]).toEqual([opened, 1])
    await embedders.close()
    vi.unstubAllEnvs()
  })

  it("**tasks through MCP as the command does**, recorded as the agent's, the writes hidden where tasks are read-only", async () => {
    const telegram = scripted()
    const { call, env } = await connect(telegram)
    await call("chat_chats_list")
    const store = await openStore({ path: env.MESSAGING_STORE })
    await seedSearchRecipes(store, { provider: "chat", account: "500" })
    await store.close()

    const added = await call("chat_tasks_add", { message: "msg:chat/500/7/101", type: "promise" })
    expect(added.body).toMatchObject({ kind: "promise", state: "open", origin: "agent", created: true })
    expect((await call("chat_tasks_list", { state: "open", type: ["promise"] })).body).toMatchObject({
      items: [{ id: added.body.id, message: { text: expect.any(String) } }],
      hasMore: false,
    })
    const closed = await call("chat_tasks_close", { task: added.body.id, as: "dismissed", reason: "no-reply-needed" })
    expect(closed.body).toMatchObject({ state: "dismissed", reason: "no-reply-needed", closedBy: "agent" })
    expect((await call("chat_stats_tasks_show")).body).toMatchObject({ items: [{ group: "7", open: 0 }] })
    const foreign = await call("chat_tasks_add", { message: "msg:chat/999/7/101", type: "promise" })
    expect([foreign.isError, foreign.body.error.code]).toEqual([true, "validation_error"])

    const readOnly = await connect(scripted(), { config: levels({ tasks: "readonly" }) })
    const names = (await readOnly.client.listTools()).tools.map(({ name }) => name)
    expect(names).toEqual(expect.arrayContaining(["chat_tasks_list", "chat_stats_tasks_show"]))
    expect(names).not.toContain("chat_tasks_add")
    expect(names).not.toContain("chat_tasks_close")
  })

  it("keeps private contact metadata local through MCP and offers only its reads on a readonly profile", async () => {
    const { call, env } = await connect(scripted())
    await call("chat_chats_list")
    const store = await openStore({ path: env.MESSAGING_STORE })
    await seedSearchRecipes(store, { provider: "chat", account: "500" })
    await store.saveChatMetadata(
      { provider: "chat", account: "500" },
      { chatId: "7", title: "AI news", username: null, description: null },
    )
    await store.close()
    expect((await call("chat_contacts_alias_set", { person: "10", alias: "Local" })).body).toMatchObject({
      alias: "Local",
    })
    const added = await call("chat_contacts_notes_add", { person: "Local", text: "Own note" })
    expect(added.body).toMatchObject({ revision: 1, text: "Own note" })
    const id = added.body.id
    expect((await call("chat_contacts_notes_list", { person: "10" })).body).toMatchObject({ items: [{ id }] })
    expect((await call("chat_contacts_notes_show", { person: "10", id })).body).toMatchObject({ text: "Own note" })
    expect(
      (await call("chat_contacts_notes_edit", { person: "10", id, text: "Edited", revision: 1 })).body,
    ).toMatchObject({ revision: 2 })
    expect((await call("chat_contacts_notes_remove", { person: "10", id })).body).toMatchObject({ removed: true })
    expect((await call("chat_contacts_alias_rm", { person: "10" })).body).toMatchObject({ alias: null })
    expect((await call("chat_metadata_get", { chat: "7" })).body).toMatchObject({ metadata: { title: "AI news" } })
    expect((await call("chat_tags_auto", { chats: ["7"], dry_run: true })).body).toMatchObject({
      dryRun: true,
      items: [{ chatId: "7" }],
    })
    const readonly = await connect(scripted(), {
      config: levels({ contacts: "readonly", metadata: "readonly", tags: "readonly" }),
    })
    const names = (await readonly.client.listTools()).tools.map(({ name }) => name)
    expect(names).toContain("chat_contacts_notes_list")
    expect(names).not.toContain("chat_contacts_alias_set")
    expect(names).not.toContain("chat_contacts_notes_add")
    expect(names).not.toContain("chat_tags_auto")
    expect(names).not.toContain("chat_metadata_refresh")
  })

  it("**tags through MCP as the command does**, hides the writes where tags are read-only, and goes ahead at ask", async () => {
    const telegram = scripted()
    const { call, env } = await connect(telegram)
    await call("chat_chats_list")
    const store = await openStore({ path: env.MESSAGING_STORE })
    await seedSearchRecipes(store, { provider: "chat", account: "500" })
    await store.close()

    const added = await call("chat_tags_add", { tags: ["Paid"], chat: "7", message: "101" })
    expect(added.body).toMatchObject({ target: { type: "message", messageId: "101" }, added: ["paid"] })
    expect((await call("chat_tags_list", { tag: "paid" })).body).toMatchObject({
      items: [{ tag: "paid", type: "message", locator: "msg:chat/500/7/101" }],
      hasMore: false,
    })
    const found = await call("chat_search_messages", { text: "tag:paid OR tag:family", language: "lucene" })
    expect(found.body.items.map(({ id }: { id: string }) => id).sort()).toEqual(["101", "103", "108"])
    expect((await call("chat_tags_remove", { tags: ["paid"], message: "msg:chat/500/7/101" })).body).toMatchObject({
      removed: ["paid"],
    })
    const twoTargets = await call("chat_tags_add", { tags: ["x"], chat: "7", contact: "11" })
    expect([twoTargets.isError, twoTargets.body.error.code]).toEqual([true, "validation_error"])

    const readOnly = await connect(scripted(), { config: levels({ tags: "readonly" }) })
    const names = (await readOnly.client.listTools()).tools.map(({ name }) => name)
    expect(names).toContain("chat_tags_list")
    expect(names).not.toContain("chat_tags_add")
    expect(names).not.toContain("chat_tags_remove")

    const asked = await connect(scripted(), { config: levels({ "tags.add": "ask" }) })
    await asked.call("chat_chats_list")
    expect((await asked.call("chat_tags_add", { tags: ["x"], chat: "7" })).isError).toBe(false)
  })

  it("**an agent finds files without text and writes back what it read**, as the command does", async () => {
    const { call, env } = await connect(scripted())
    await call("chat_chats_list")
    const store = await openStore({ path: env.MESSAGING_STORE })
    await seedSearchRecipes(store, { provider: "chat", account: "500" })
    await store.keepDownloads({ provider: "chat", account: "500" }, "9", "108", [
      { kind: "file", name: "Отчёт.PDF", path: "/saved/report.pdf" },
    ])
    await store.close()

    expect((await call("chat_attachments_list", { needs_text: true })).body).toEqual({
      items: [
        {
          locator: "msg:chat/500/9/108",
          attachment: 1,
          kind: "file",
          name: "Отчёт.PDF",
          localPath: "/saved/report.pdf",
          text: null,
        },
      ],
      page: 1,
      limit: expect.any(Number),
      hasMore: false,
    })
    const kept = await call("chat_attachments_text_set", { message: "msg:chat/500/9/108", text: "Квартальный отчёт" })
    expect(kept.body).toEqual({
      locator: "msg:chat/500/9/108",
      attachment: 1,
      origin: "agent",
      chars: 17,
      replaced: null,
    })
    const found = await call("chat_search_messages", { text: "content:квартальный", language: "lucene" })
    expect(found.body.items.map(({ id }: { id: string }) => id)).toEqual(["108"])
    expect((await call("chat_attachments_list", { needs_text: true })).body.items).toEqual([])

    const readOnly = await connect(scripted(), { config: levels({ attachments: "readonly" }) })
    const names = (await readOnly.client.listTools()).tools.map(({ name }) => name)
    expect(names).toContain("chat_attachments_list")
    expect(names).not.toContain("chat_attachments_text_set")
  })

  it("delivers retained PDF bytes through the real three-tool transport and honors message permissions", async () => {
    const root = await filledRoot()
    const connectSpy = vi.fn(async () => {
      throw new Error("retained transfer connected")
    })
    const { client, raw, env } = await connect(scripted(), { root, connect: connectSpy })
    const store = await openStore({ path: env.MESSAGING_STORE })
    const path = join(root, "remote.pdf")
    const bytes = Buffer.from("%PDF-1.7\nsynthetic remote file")
    writeFileSync(path, bytes)
    await store.saveMessages(
      { provider: "chat", account: "500" },
      "7",
      [{ ...message, id: "902", attachments: [{ kind: "file", name: "remote.pdf" }] }],
      { via: "test" },
    )
    await store.keepDownloads({ provider: "chat", account: "500" }, "7", "902", [{ kind: "file", position: 0, path }])
    await store.close()
    const answer = await client.callTool({
      name: "chat_attachments_show",
      arguments: { message: "msg:chat/500/7/902" },
    })
    expect(answer.isError).not.toBe(true)
    expect(answer.content[0]).toMatchObject({
      type: "resource",
      resource: {
        mimeType: "application/pdf",
        blob: bytes.toString("base64"),
      },
    })
    expect(answer.structuredContent).toMatchObject({ complete: true, totalBytes: bytes.length })
    expect(JSON.stringify(answer.structuredContent)).not.toContain("base64")
    const fallback = await client.callTool({
      name: "chat_attachments_show",
      arguments: { message: "msg:chat/500/7/902", format: "base64", chunk_bytes: 5 },
    })
    expect(fallback.structuredContent).toMatchObject({
      base64: bytes.subarray(0, 5).toString("base64"),
      nextOffsetBytes: 5,
      complete: false,
    })
    writeFileSync(path, pdf("Synthetic page for an agent"))
    const preview = await client.callTool({
      name: "chat_attachments_show",
      arguments: { message: "msg:chat/500/7/902", page: 1 },
    })
    expect(preview.isError).not.toBe(true)
    expect(preview.content[0]).toMatchObject({ type: "image", mimeType: "image/png" })
    expect(preview.structuredContent).toMatchObject({ pdf: { page: 1, pageCount: 1 }, complete: true })
    expect(JSON.stringify(preview.structuredContent)).not.toContain("base64")
    const foreign = await client.callTool({
      name: "chat_attachments_show",
      arguments: { message: "msg:chat/600/7/902" },
    })
    expect(foreign.isError).toBe(true)
    const png = PNG.sync.write(new PNG({ width: 1, height: 1 }))
    writeFileSync(path, png)
    const image = await client.callTool({ name: "chat_attachments_show", arguments: { message: "msg:chat/500/7/902" } })
    expect(image.content[0]).toMatchObject({ type: "image", mimeType: "image/png", data: png.toString("base64") })
    expect(connectSpy).not.toHaveBeenCalled()
    expect((await raw.listTools()).tools.map(({ name }) => name).sort()).toEqual([
      "chat_read",
      "chat_tools_search",
      "chat_write",
    ])
    const denied = await connect(scripted(), { root, config: levels({ messages: "deny" }) })
    expect((await denied.client.listTools()).tools.map(({ name }) => name)).not.toContain("chat_attachments_show")
  })

  it("refuses protected attachment locations before downloading, indexing or transferring bytes", async () => {
    const root = await filledRoot()
    const backend = scripted()
    const { call, env } = await connect(backend, { root })
    const store = await openStore({ path: env.MESSAGING_STORE })
    const owner = { provider: "chat", account: "500" }
    const directories = [
      join(root, ".ssh"),
      join(root, ".config", "autostart"),
      env.CHAT_STATE_DIR,
      env.CHAT_CONFIG_DIR,
      env.CHAT_CACHE_DIR,
    ]
    try {
      await store.saveMessages(
        owner,
        "7",
        [{ ...message, id: "903", attachments: [{ kind: "file", name: "synthetic.txt" }] }],
        { via: "test" },
      )
      for (const [index, directory] of directories.entries()) {
        mkdirSync(directory, { recursive: true })
        const path = join(directory, "synthetic.txt")
        writeFileSync(path, "synthetic protected bytes")
        const alias = join(root, `protected-alias-${index}`)
        symlinkSync(directory, alias, "junction")
        for (const folder of [directory, alias]) {
          const download = await call("chat_attachments_extract", {
            chat: "7",
            download: true,
            output_dir: join(folder, "missing", "downloads"),
          })
          expect(download.isError).toBe(true)
          expect(download.body).toMatchObject({ error: { code: "validation_error" } })
          const extract = await call("chat_attachments_extract", { chat: "7", from_dir: folder })
          expect(extract.isError).toBe(true)
          expect(extract.body).toMatchObject({ error: { code: "validation_error" } })
          await store.keepDownloads(owner, "7", "903", [
            { kind: "file", position: 0, path: join(folder, "synthetic.txt") },
          ])
          const transfer = await call("chat_attachments_show", { chat: "7", message: "903", format: "base64" })
          expect(transfer.isError).toBe(true)
          expect(transfer.body).toMatchObject({ error: { code: "validation_error" } })
          expect(JSON.stringify(transfer)).not.toContain(Buffer.from("synthetic protected bytes").toString("base64"))
        }
      }
      expect(backend.opened()).toBe(0)
      expect(
        await store.localPathOf(
          (await store.attachments(owner, { chatId: "7", messageId: "903", limit: 1 }))[0]?.pk as number,
        ),
      ).not.toBeNull()
    } finally {
      await store.close()
    }
  })

  it("extracts local file text through MCP without connecting and keeps the body out of its answer", async () => {
    const root = await filledRoot()
    const backend = scripted()
    const { call, env } = await connect(backend, { root })
    const store = await openStore({ path: env.MESSAGING_STORE })
    const path = join(root, "extract-fixture.txt")
    writeFileSync(path, "synthetic extractionneedle")
    await store.saveMessages(
      { provider: "chat", account: "500" },
      "7",
      [{ ...message, id: "900", attachments: [{ kind: "file", name: "extract-fixture.txt" }] }],
      { via: "history" },
    )
    await store.keepDownloads({ provider: "chat", account: "500" }, "7", "900", [{ kind: "file", position: 0, path }])
    await store.close()
    const answer = await call("chat_attachments_extract", { chat: "7", limit: 1 })
    expect(answer.isError).toBe(false)
    expect(answer.body).toMatchObject({ extracted: 1 })
    expect(JSON.stringify(answer.body)).not.toContain("extractionneedle")
    expect(
      (await call("chat_search_messages", { text: "content:extractionneedle" })).body.items.map(
        ({ id }: { id: string }) => id,
      ),
    ).toEqual(["900"])
    expect(backend.opened()).toBe(0)
    const refused = await call("chat_attachments_extract", { from_dir: root })
    expect(refused.isError).toBe(true)
    expect(backend.opened()).toBe(0)
    const readonly = await connect(scripted(), { root, config: levels({ attachments: "readonly" }) })
    expect((await readonly.client.listTools()).tools.map(({ name }) => name)).not.toContain("chat_attachments_extract")
  })

  it("explicitly OCRs a local image through the shared gateway and indexes it through MCP", async () => {
    const root = await filledRoot()
    const { call, env } = await connect(scripted(), {
      root,
      config: {
        defaults: {
          models: { ocr: { provider: "openai", model: "vision-fixture", baseUrl: "https://example.test/v1" } },
        },
      },
    })
    const store = await openStore({ path: env.MESSAGING_STORE })
    const path = join(root, "mcp-ocr.png")
    writeFileSync(path, PNG.sync.write(new PNG({ width: 2, height: 2 })))
    await store.saveMessages(
      { provider: "chat", account: "500" },
      "7",
      [{ ...message, id: "901", attachments: [{ kind: "photo", name: "mcp-ocr.png" }] }],
      { via: "history" },
    )
    await store.keepDownloads({ provider: "chat", account: "500" }, "7", "901", [{ kind: "photo", position: 0, path }])
    await store.close()
    const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        choices: [{ finish_reason: "stop", message: { content: "mcpocrneedle" } }],
        usage: { total_tokens: 10 },
      }),
    )
    try {
      const answer = await call("chat_attachments_extract", { chat: "7", ocr: true, concurrency: 2, limit: 1 })
      expect(answer.isError).toBe(false)
      expect(answer.body).toMatchObject({ extracted: 1 })
      expect(JSON.stringify(answer.body)).not.toContain("mcpocrneedle")
      expect(
        (await call("chat_search_messages", { text: "content:mcpocrneedle" })).body.items.map(
          ({ id }: { id: string }) => id,
        ),
      ).toEqual(["901"])
      expect(fetcher).toHaveBeenCalledTimes(1)
    } finally {
      fetcher.mockRestore()
    }
  })

  it("plans gaps locally and repairs them through the retained session", async () => {
    const root = await filledRoot()
    const backend = scripted()
    const { call, env } = await connect(backend, { root })
    const store = await openStore({ path: env.MESSAGING_STORE })
    await store.markRange({ provider: "chat", account: "500" }, "7", 100, 101)
    await store.markRange({ provider: "chat", account: "500" }, "7", 103, 104)
    await store.close()
    const plan = await call("chat_store_gaps_plan", { chat: "7" })
    expect(plan.body.gaps).toEqual([{ from: 102, to: 102 }])
    expect(backend.opened()).toBe(0)
    const repaired = await call("chat_store_gaps_repair", {
      chat: "7",
      fingerprint: plan.body.fingerprint,
      limit: 3,
      max_gaps: 1,
      page_size: 3,
      pause: "1ms",
      repair_time: "1s",
    })
    expect(repaired.isError, JSON.stringify(repaired.body)).toBe(false)
    expect(repaired.body).toHaveProperty("scope", "interior")
    expect((await call("chat_store_jobs_list", {})).body).toMatchObject({ items: [], page: 1 })
    expect((await call("chat_store_jobs_show", { job: "missing" })).isError).toBe(true)
    const readonly = await connect(scripted(), { root, config: READ_ONLY })
    expect((await readonly.client.listTools()).tools.map(({ name }) => name)).not.toContain("chat_store_gaps_repair")
  })

  it("refuses secondary search preparation permission before repairing through MCP", async () => {
    const root = await filledRoot()
    const backend = scripted()
    const { call } = await connect(backend, {
      root,
      config: levels({ store: "allow", "conversations.links": "readonly", "conversations.embed": "allow" }),
    })
    const result = await call("chat_store_gaps_repair", { chat: "7", catch_up: true })
    expect(result.isError).toBe(true)
    expect(result.body.error).toMatchObject({
      code: "permission_error",
      permission: "conversations.links",
    })
    expect(backend.opened()).toBe(0)
  })

  it("queues a fingerprinted gap repair without opening a connection and filters job metadata by profile", async () => {
    const root = await filledRoot()
    const backend = scripted()
    const spawnJob = vi.fn((_argv: string[], _env: NodeJS.ProcessEnv, _log: string) => 999999)
    const { call } = await connect(backend, { root, spawnJob })
    const queued = await call("chat_store_gaps_repair", {
      chat: "7",
      background: true,
      repair_time: "1s",
      pause: "1ms",
    })
    expect(queued.isError, JSON.stringify(queued.body)).toBe(false)
    expect(spawnJob.mock.calls[0]?.[0]).toEqual(expect.arrayContaining(["--fingerprint", "--repair-time", "1s"]))
    expect(backend.opened()).toBe(0)
    expect((await call("chat_store_jobs_show", { job: queued.body.job })).body).toMatchObject({
      profile: "default",
      chat: "7",
      pid: 999999,
    })
    expect((await call("chat_store_jobs_list", { limit: 1, page: 1 })).body.items).toHaveLength(1)
  })

  it("checks one person without the ban lists when asked, and says a non-Telegram account is not in them", async () => {
    const { call } = await connect(scripted())
    const quiet = await call("chat_contacts_check", { person: "Olga", registries: false })
    const implicit = await call("chat_contacts_check", { person: "Olga" })
    const asked = await call("chat_contacts_check", { person: "Olga", registries: true })

    expect(quiet.isError).toBe(false)
    expect(quiet.body.registries).toEqual([])
    expect(implicit.body.registries.map((one: { answer: string }) => one.answer)).toEqual(["unknown", "unknown"])
    expect(quiet.body.notes).toContain("the ban lists were not asked")
    expect(asked.body.registries.map((one: { answer: string }) => one.answer)).toEqual(["unknown", "unknown"])
  })

  it("honours permission tightening on an already-open MCP session, including local writes", async () => {
    const root = mkdtempSync(join(tmpdir(), "mcp-permissions-current-"))
    const backend = scripted()
    const { call, env, raw } = await connect(backend, { root })
    expect((await call("chat_messages_list", { chat: "7" })).isError).toBe(false)
    writeFileSync(
      join(env.CHAT_CONFIG_DIR, "config.json"),
      JSON.stringify(levels({ messages: "deny", tags: "readonly" })),
    )
    expect((await call("chat_messages_list", { chat: "7" })).body.error.code).toBe("permission_error")
    expect((await call("chat_tags_add", { tags: ["synthetic"], chat: "7" })).body.error.code).toBe("permission_error")
    await expect(raw.readResource({ uri: "chat://chat/7" })).rejects.toThrow(/does not allow this resource/)
    writeFileSync(join(env.CHAT_CONFIG_DIR, "config.json"), JSON.stringify(levels({ chats: "deny" })))
    await expect(raw.listResources()).rejects.toThrow(/does not allow this resource/)
  })

  it("hides contact context when message reading is denied", async () => {
    const { client } = await connect(scripted(), { config: levels({ messages: "deny" }) })
    expect((await client.listTools()).tools.map(({ name }) => name)).not.toContain("chat_contacts_context")
  })

  it.each([false, true])("MCP search history follows explicit recording %s", async (record) => {
    const { call, env } = await connect(scripted(), { config: { defaults: { record } } })
    await call("chat_chats_list")
    const store = await openStore({ path: env.MESSAGING_STORE })
    await seedSearchRecipes(store, { provider: "chat", account: "500" })
    await store.close()
    const found = await call("chat_search_messages", { text: "invoice" })
    const counted = await call("chat_stats_messages_show", { text: "invoice" })
    expect(found.isError).toBe(false)
    expect(counted.body).toMatchObject({ total: 3 })
    expect((await call("chat_searches_history")).body.items).toHaveLength(record ? 2 : 0)
  })

  it("**saves and runs searches through MCP as the commands do**, and hides the writes where searches are read-only", async () => {
    const telegram = scripted()
    const { call, env } = await connect(telegram)
    await call("chat_chats_list")
    const store = await openStore({ path: env.MESSAGING_STORE })
    await seedSearchRecipes(store, { provider: "chat", account: "500" })
    await store.close()

    expect(
      (await call("chat_searches_create", { name: "invoices", text: "invoice", by: "sender" })).body,
    ).toMatchObject({
      name: "invoices",
      command: "stats",
    })
    const found = await call("chat_search_messages", { saved: "invoices", text: "alpha", limit: 5 })
    expect(found.body.items.map(({ id }: { id: string }) => id).sort()).toEqual(["101", "106"])
    expect((await call("chat_stats_messages_show", { saved: "invoices" })).body).toMatchObject({
      by: "sender",
      total: 3,
    })
    const ast = await call("chat_search_messages", { saved: "invoices", ast: parseLucene("alpha") })
    expect([ast.isError, ast.body.error.code]).toEqual([true, "validation_error"])
    expect((await call("chat_searches_list")).body).toMatchObject({ items: [{ name: "invoices", runs: 2 }] })
    expect((await call("chat_searches_history", { limit: 1 })).body).toMatchObject({ limit: 1, hasMore: true })
    expect((await call("chat_searches_clear")).body).toEqual({ cleared: 2 })
    expect((await call("chat_searches_delete", { name: "invoices" })).body).toMatchObject({ name: "invoices" })

    const readOnly = await connect(scripted(), { config: levels({ searches: "readonly" }) })
    const names = (await readOnly.client.listTools()).tools.map(({ name }) => name)
    expect(names).toEqual(expect.arrayContaining(["chat_searches_list", "chat_searches_history"]))
    for (const write of ["chat_searches_create", "chat_searches_delete", "chat_searches_clear"])
      expect(names).not.toContain(write)
  })

  it("runs conversations_refresh where conversations.embed asks, and hides it where it is read-only", async () => {
    const asked = await connect(scripted(), { config: levels({ "conversations.embed": "ask" }) })
    await asked.call("chat_chats_list")
    expect((await asked.call("chat_conversations_refresh")).body?.error?.code).not.toBe("confirmation_required")

    const { client } = await connect(scripted(), { config: levels({ "conversations.embed": "readonly" }) })
    const names = (await client.listTools()).tools.map(({ name }) => name)
    expect(names).toContain("chat_search_conversations")
    expect(names).not.toContain("chat_conversations_refresh")
  })

  it("connects again once the connection has been idle, or is older than the age limit", async () => {
    const telegram = scripted()
    let now = 0
    const { call } = await connect(telegram, { idleMs: 10, maxAgeMs: 1000, now: () => now })

    await call("chat_chats_list")
    await new Promise((resolve) => setTimeout(resolve, 30))
    await call("chat_chats_list")
    expect(telegram.opened()).toBe(2)
    expect(telegram.closed()).toBe(1)

    now = 2000
    await call("chat_chats_list")
    expect(telegram.opened()).toBe(3)
  })

  it("keeps the connection after the caller's mistake, and drops it after anything else", async () => {
    let failure: Error = new CliError("not_found", "no chat matches Bok")
    const telegram = scripted({
      chat: async () => {
        throw failure
      },
    })
    const { call } = await connect(telegram)

    const missing = await call("chat_chats_show", { chat: "Bok" })
    expect(missing).toMatchObject({
      isError: true,
      body: { error: { code: "not_found", message: "no chat matches Bok", retryable: false } },
    })
    expect(telegram.closed()).toBe(0)

    failure = new CliError("network_error", "the socket closed")
    await call("chat_chats_show", { chat: "Bok" })
    expect(telegram.closed()).toBe(1)
  })

  it("says how to log in when there is no session, and keeps nothing on stdout", async () => {
    const { call, streams } = await connect(scripted(), {
      connect: async () => {
        throw new CliError("authentication_error", 'no session for profile "default" — run `chat session start`')
      },
    })

    const { isError, body } = await call("chat_chats_list")

    expect(isError).toBe(true)
    expect(body.error).toMatchObject({ code: "authentication_error" })
    expect(body.error.message).toContain("session start")
    expect(streams.stdout).toEqual([])
  })

  it("keeps its instructions within the 2048 characters a client shows", () => {
    const text = instructions({
      command: "chat",
      name: "Chat",
      profile: "a-long-profile-name",
      writes: ["messages_send", "messages_delete", "chats_mark_read"],
      skill: skillResource(app, new URL("file:///SKILL.md")).instruction,
    })
    expect(text.length).toBeLessThanOrEqual(2048)
  })
})

describe("the photo tool", () => {
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3])
  const holding = (...files: { kind: string; size?: number; body?: Uint8Array }[]) =>
    scripted({
      download: async () => ({
        files: files.map(({ kind, size, body = jpeg }) => ({
          kind,
          ...(size === undefined ? {} : { size }),
          async *bytes() {
            yield body
          },
        })),
        skipped: [],
      }),
    })
  const look = async (telegram: Scripted) => {
    const { client } = await connect(telegram)
    const result = await client.callTool({
      name: "chat_messages_photo",
      arguments: { chat: "Book club", message: "1" },
    })
    return { isError: result.isError === true, content: result.content as unknown as Record<string, string>[] }
  }

  it("**answers a photo as an image**, with what it is as text", async () => {
    const { isError, content } = await look(holding({ kind: "photo" }))

    expect(isError).toBe(false)
    expect(content[0]).toEqual({ type: "image", mimeType: "image/jpeg", data: Buffer.from(jpeg).toString("base64") })
    expect(JSON.parse(content[1]?.text ?? "")).toEqual({ chatId: "7", messageId: "1", bytes: jpeg.length })
  })

  it("refuses anything else with the command that saves it", async () => {
    const voice = await look(holding({ kind: "voice" }))
    const large = await look(holding({ kind: "photo", size: 600 * 1024 }))
    const unsized = await look(holding({ kind: "photo", body: new Uint8Array(600 * 1024).fill(0xff) }))
    const unknown = await look(holding({ kind: "photo", body: new Uint8Array([1, 2, 3, 4]) }))

    for (const refused of [voice, large, unsized, unknown]) {
      expect(refused.isError).toBe(true)
      expect(refused.content[0]?.text).toContain("chat messages download 7 1")
    }
  })

  it("refuses a message with no photo, and a messenger that cannot download", async () => {
    const none = await look(holding())
    const unable = await look(scripted())

    expect(JSON.parse(none.content[0]?.text ?? "").error.code).toBe("not_found")
    expect(unable.content[0]?.text).toContain("cannot download attachments")
  })
})

describe("the transcribe tool", () => {
  it("answers the text, and whether the messenger was still working on it", async () => {
    let asked: unknown
    const { call } = await connect(
      scripted({
        transcribe: async (chat, id) => {
          asked = [chat, id]
          return { text: "hello there", pending: false }
        },
      }),
    )

    expect((await call("chat_messages_transcribe", { chat: "Book club", message: "5" })).body).toEqual({
      messageId: "5",
      text: "hello there",
      pending: false,
      via: "chat",
    })
    expect(asked).toEqual(["Book club", "5"])
  })

  it("hears a chat's voice messages with `transcribe` on the list tool", async () => {
    const { call } = await connect(
      scripted({
        history: async () => ({ items: [{ ...message, attachments: [{ kind: "voice" }] }], hasMore: false }),
        transcribe: async () => ({ text: "read me", pending: false }),
      }),
    )

    const { body } = await call("chat_messages_list", { chat: "7", transcribe: true })

    expect(body).toMatchObject({ items: [{ transcript: "read me" }], unheard: [] })
  })

  it("hears unread voice messages with `transcribe` on the inbox tool", async () => {
    const { call } = await connect(
      scripted({
        chats: async () => ({ items: [{ ...chat, unreadCount: 1 }], hasMore: false }),
        history: async () => ({ items: [{ ...message, attachments: [{ kind: "voice" }] }], hasMore: false }),
        transcribe: async () => ({ text: "read me", pending: false }),
      }),
    )

    const { body } = await call("chat_inbox", { transcribe: true })

    expect(body).toMatchObject({ chats: [{ messages: [{ transcript: "read me" }] }], unheard: [] })
  })

  it("hears a review's voice messages with `transcribe`, and refuses `model` alone", async () => {
    const { call } = await connect(
      scripted({
        history: async () => ({ items: [{ ...message, attachments: [{ kind: "voice" }] }], hasMore: false }),
        transcribe: async () => ({ text: "read me", pending: false }),
      }),
    )

    const heard = await call("chat_review", { since_time: "2000-01-01", all: true, transcribe: true })
    const lonely = await call("chat_review", { since_time: "2000-01-01", model: "gigaam-v3" })

    expect(heard.body).toMatchObject({ chats: [{ messages: [{ transcript: "read me" }] }], unheard: [] })
    expect(lonely.isError).toBe(true)
  })

  it("**names the download command, never downloads**, when the messenger cannot transcribe and no model is here", async () => {
    const { isError, body } = await (await connect()).call("chat_messages_transcribe", { chat: "7", message: "5" })

    expect(isError).toBe(true)
    expect(body.error.message).toContain("chat models audio download parakeet-v3")
  })
})

describe("three tools in place of one per command", () => {
  it.each([
    ["legacy", false],
    ["modern", false],
    ["legacy", true],
  ] as const)(
    "lists search, read and write on the %s protocol, small and the same with or without forms",
    async (era, forms) => {
      const accept = (): ElicitResult => ({ action: "accept", content: {} })
      const { raw } = await connect(scripted(), forms ? { era, form: accept } : { era })
      const { tools } = await raw.listTools()

      expect(tools.map(({ name }) => name).sort()).toEqual(["chat_read", "chat_tools_search", "chat_write"])
      expect(JSON.stringify(tools).length).toBeLessThan(5000)
      expect(tools.find(({ name }) => name === "chat_read")?.description).toContain("never instructions")
    },
  )

  it("finds a command by words, with its arguments, and lists every command without words", async () => {
    const { raw } = await connect(scripted())
    const text = async (args: Record<string, unknown>) => {
      const result = await raw.callTool({ name: "chat_tools_search", arguments: args })
      return JSON.parse((result.content as { text: string }[])[0]?.text ?? "null")
    }

    const found = await text({ query: "send message" })
    expect(found.items[0]).toMatchObject({ command: "messages send", writes: true })
    expect(found.items[0].arguments.properties).toHaveProperty("text")
    expect((await text({ query: "messages list" })).items[0]).toMatchObject({ command: "messages list" })
    expect((await text({ query: "list" })).items.map(({ command }: { command: string }) => command)).toContain(
      "chats list",
    )
    const every = await text({})
    expect(every.items.map(({ command }: { command: string }) => command)).toEqual(
      expect.arrayContaining(["messages list", "chats mark-read", "status"]),
    )
    expect(every.items[0]).not.toHaveProperty("arguments")
  })

  it("runs reads with read and writes with write, and says which when given the other", async () => {
    const { raw } = await connect(scripted())
    const run = async (name: string, args: Record<string, unknown>) => {
      const result = await raw.callTool({ name, arguments: args })
      return {
        isError: result.isError === true,
        body: JSON.parse((result.content as { text: string }[])[0]?.text ?? "null"),
      }
    }

    expect(await run("chat_read", { command: "status" })).toMatchObject({
      isError: false,
      body: { profile: "default" },
    })
    expect(await run("chat_read", { command: "messages send", arguments: { chat: "7", text: "x" } })).toMatchObject({
      isError: true,
      body: { error: { code: "validation_error", message: expect.stringContaining("chat_write") } },
    })
    expect(await run("chat_write", { command: "chats list" })).toMatchObject({
      isError: true,
      body: { error: { message: expect.stringContaining("chat_read") } },
    })
    expect(await run("chat_read", { command: "chats lst" })).toMatchObject({
      isError: true,
      body: { error: { message: expect.stringContaining('"chats list"') } },
    })
    expect(await run("chat_read", { command: "messages list", arguments: { chat: "7", limit: "many" } })).toMatchObject(
      {
        isError: true,
        body: { error: { code: "validation_error", arguments: { properties: { limit: expect.anything() } } } },
      },
    )
  })

  it("has no write tool on a read-only profile, and finds no writing command there", async () => {
    const { raw } = await connect(scripted(), { config: READ_ONLY })

    expect((await raw.listTools()).tools.map(({ name }) => name)).not.toContain("chat_write")
    const result = await raw.callTool({ name: "chat_tools_search", arguments: {} })
    const { items } = JSON.parse((result.content as { text: string }[])[0]?.text ?? "null")
    expect(items.every(({ writes }: { writes: boolean }) => !writes)).toBe(true)
  })
})

describe("sending over MCP", () => {
  it("offers the send command unless the profile is read-only, marked as a write", async () => {
    const reading = (await (await connect(scripted(), { config: READ_ONLY })).client.listTools()).tools.map(
      (one) => one.name,
    )
    const { tools } = await (await connect(scripted(), {})).client.listTools()
    const send = tools.find((one) => one.name === "chat_messages_send")

    expect(reading).not.toContain("chat_messages_send")
    expect(send?.annotations).toMatchObject({ readOnlyHint: false })
  })

  it("sends through the guard, with the reply, and journals it without the text", async () => {
    const { telegram, sent } = sending()
    const { call, env } = await connect(telegram, {})

    const { isError, body } = await call("chat_messages_send", { chat: "Book club", text: "see you", reply_to: "1" })

    expect(isError).toBe(false)
    expect(sent).toEqual([{ chatId: "7", text: "see you", sendId: body.sendId, replyTo: "1" }])
    const [entry] = new SendJournal(sendsPathFor(app, "default", env)).entries()
    expect(entry).toMatchObject({ outcome: "sent", chatId: "7", replyTo: "1", messageId: "99" })
    expect(JSON.stringify(entry)).not.toContain("see you")
  })

  it.each(["legacy", "modern"] as const)(
    "preserves decoded HTML text and its spans on the %s transport",
    async (era) => {
      const decoded = "a\u{e0041}b"
      const written: { text: string; from: number; length: number }[] = []
      const { call } = await connect(
        scripted({
          formatHtml: async () => ({ text: decoded, spans: [{ type: "bold", from: 3, length: 1 }] }),
          send: async (_chat, text, options) => {
            written.push({
              text,
              from: options.formatting?.[0]?.from ?? -1,
              length: options.formatting?.[0]?.length ?? -1,
            })
            return { message: { ...message, text }, sendId: "1" }
          },
          edit: async (_chat, _message, text, options) => {
            written.push({
              text,
              from: options?.formatting?.[0]?.from ?? -1,
              length: options?.formatting?.[0]?.length ?? -1,
            })
            return { ...message, text }
          },
        }),
        { era, config: levels({ messages: "allow" }) },
      )
      const args = { chat: "7", text: "a&#xE0041;<b>b</b>", html: true }
      expect((await call("chat_messages_send", args)).isError).toBe(false)
      expect((await call("chat_messages_edit", { ...args, message: "1" })).isError).toBe(false)
      expect(written).toEqual(Array.from({ length: 2 }, () => ({ text: decoded, from: 3, length: 1 })))
      for (const row of written) expect(row.text.slice(row.from, row.from + row.length)).toBe("b")
    },
  )

  it.each(["legacy", "modern"] as const)(
    "exposes hidden text on reads and writes through the %s MCP transport",
    async (era) => {
      const hidden = "a\u{e0041}\u0085\u202e\ufeffb"
      const visible = "a\\u{e0041}\\x85\\u202e\\ufeffb"
      const flag = "\u{1f3f4}\u{e0067}\u{e0062}\u{e0065}\u{e006e}\u{e0067}\u{e007f}"
      const sent: string[] = []
      const edited: string[] = []
      const { call } = await connect(
        scripted({
          history: async () => ({ items: [{ ...message, text: hidden + flag }], hasMore: false }),
          send: async (_chat, text) => {
            sent.push(text)
            return { message: { ...message, text }, sendId: "1" }
          },
          edit: async (_chat, _message, text) => {
            edited.push(text)
            return { ...message, text }
          },
        }),
        { era, config: levels({ messages: "allow" }) },
      )
      const read = await call("chat_messages_list", { chat: "7" })
      expect(read.body.items[0].text).toBe(visible + flag)
      expect((await call("chat_messages_send", { chat: "7", text: hidden + flag })).isError).toBe(false)
      expect((await call("chat_messages_edit", { chat: "7", message: "1", text: hidden + flag })).isError).toBe(false)
      expect(sent).toEqual([hidden + flag])
      expect(edited).toEqual([hidden + flag])
    },
  )

  it("configures a forum and creates a topic through the same guarded service", async () => {
    let enabled = false
    const telegram = scripted({
      forumState: async () => ({
        chat,
        forum: enabled,
        needsUpgrade: false,
        owner: true,
        canCreate: true,
        linkedDiscussion: false,
      }),
      enableForum: async () => {
        enabled = true
        return { chat, forum: true, needsUpgrade: false, owner: true, canCreate: true, linkedDiscussion: false }
      },
      createTopic: async () => ({
        id: "12",
        title: "synthetic",
        closed: false,
        pinned: false,
        unreadCount: 0,
        lastMessageAt: null,
        createdAt: "2026-10-03T00:00:00Z",
      }),
    })
    const { call, env } = await connect(telegram, {
      config: levels({ "topics.enable": "allow", "topics.create": "allow" }),
    })
    expect((await call("chat_topics_enable", { chat: "7" })).isError).toBe(false)
    const result = await call("chat_topics_create", { chat: "7", title: "synthetic", send_id: "42" })
    expect(result.isError).toBe(false)
    expect(result.body).toMatchObject({ sendId: "42", topic: { id: "12" } })
    const entries = new SendJournal(sendsPathFor(app, "default", env)).entries()
    expect(entries).toMatchObject([
      { action: "forum-enable", outcome: "sent" },
      { action: "topic-create", threadId: "12", sendId: "42", outcome: "sent" },
    ])
    expect(JSON.stringify(entries)).not.toContain("synthetic")
  })

  it("creates a quiz over MCP where the messenger makes them, and refuses one where it does not", async () => {
    const polls: unknown[] = []
    const telegram = scripted({
      createPoll: async (_chatId, poll, options) => {
        polls.push(poll)
        return { message, sendId: options.sendId }
      },
    })
    const quiz = { chat: "7", text: "2+2?", answers: ["3", "4"], quiz: true, correct: 2, solution: "four" }

    const quizzing = await connect(telegram, { pollQuiz: true })
    expect((await quizzing.call("chat_polls_create", quiz)).isError).toBe(false)
    const plain = await connect(telegram, {})
    expect((await plain.call("chat_polls_create", quiz)).isError).toBe(true)
    expect(polls).toMatchObject([{ quiz: { correct: 1, solution: "four" } }])
  })

  it("preserves topic addressing through MCP send and poll tools", async () => {
    const validations: unknown[] = []
    const sends: unknown[] = []
    const telegram = scripted({
      validateThread: async (...args) => {
        validations.push(args)
      },
      send: async (chatId, text, options) => {
        sends.push([chatId, text, options])
        return { message, sendId: options.sendId }
      },
      createPoll: async (chatId, poll, options) => {
        sends.push([chatId, poll, options])
        return { message, sendId: options.sendId }
      },
    })
    const { call } = await connect(telegram, {})
    expect(
      (await call("chat_messages_send", { chat: "7", text: "hi", topic: "12", reply_to: "14", send_id: "42" })).isError,
    ).toBe(false)
    expect(
      (
        await call("chat_polls_create", {
          chat: "7",
          text: "Friday?",
          answers: ["yes", "no"],
          topic: "12",
          send_id: "43",
        })
      ).isError,
    ).toBe(false)
    expect(validations).toEqual([
      ["7", "12", { replyTo: "14" }],
      ["7", "12", {}],
    ])
    expect(sends).toMatchObject([
      ["7", "hi", { threadId: "12", replyTo: "14", sendId: "42" }],
      ["7", { question: "Friday?" }, { threadId: "12", sendId: "43" }],
    ])
  })

  it("lists sender identities read-only and sends as one through the same check", async () => {
    const identities = [
      { id: "500", title: "Owner", kind: "self" as const, premiumRequired: false, default: true },
      { id: "-1002", title: "Synthetic channel", kind: "channel" as const, premiumRequired: false, default: false },
    ]
    const sends: unknown[] = []
    const telegram = scripted({
      sendAsIdentities: async () => identities,
      send: async (chatId, text, options) => {
        sends.push([chatId, text, options])
        return { message, sendId: options.sendId }
      },
    })
    const { call, client } = await connect(telegram, {})
    const offered = (await client.listTools()).tools.find((one) => one.name === "chat_chats_send_as")
    expect(offered?.annotations?.readOnlyHint).toBe(true)
    expect((await call("chat_chats_send_as", { chat: "7" })).body.items).toEqual(identities)
    expect((await call("chat_messages_send", { chat: "7", text: "hi", send_as: "-1002" })).isError).toBe(false)
    expect((await call("chat_messages_send", { chat: "7", text: "hi", send_as: "-1099" })).isError).toBe(true)
    expect(sends).toMatchObject([["7", "hi", { sendAs: "-1002" }]])
  })

  it("repeats the send_id it was given, so the messenger can drop a duplicate", async () => {
    const { telegram, sent } = sending()
    const { call } = await connect(telegram, {})

    await call("chat_messages_send", { chat: "7", text: "again", send_id: "12345" })

    expect(sent[0]?.sendId).toBe("12345")
  })

  it("sends silently, without a preview, with the Markdown marks turned into spans", async () => {
    const { telegram, sent } = sending()
    const { call } = await connect(telegram, {})

    await call("chat_messages_send", { chat: "7", text: "**hi**", silent: true, no_preview: true, md: true })

    expect(sent[0]).toMatchObject({
      text: "hi",
      silent: true,
      noPreview: true,
      formatting: [{ type: "bold", from: 0, length: 2 }],
    })
  })

  it("schedules with `at`, answers scheduledFor, and lists the queue", async () => {
    const sent: SendOptions[] = []
    const telegram = scripted({
      send: async (_chatId, text, options) => {
        sent.push(options)
        return { message: { ...message, text }, sendId: options.sendId }
      },
      scheduled: async () => [{ ...message, scheduledFor: "2030-01-01T09:00:00.000Z" }],
    })
    const { call } = await connect(telegram, {})

    const { body } = await call("chat_messages_send", { chat: "7", text: "later", at_time: "30m" })
    const queue = await call("chat_messages_scheduled", { chat: "7" })

    expect(body.scheduledFor).toBe(sent[0]?.at)
    expect(queue.body.items[0].scheduledFor).toBe("2030-01-01T09:00:00.000Z")
  })

  it("attaches a file from a path, and refuses a hidden one with no way around it", async () => {
    const { telegram, sent } = sending()
    const { call } = await connect(telegram, {})
    const root = mkdtempSync(join(tmpdir(), "mcp-upload-"))
    writeFileSync(join(root, "plan.pdf"), "pdf")
    writeFileSync(join(root, ".env"), "SECRET=1")

    const attached = await call("chat_messages_send", { chat: "7", file: join(root, "plan.pdf") })
    const hidden = await call("chat_messages_send", { chat: "7", text: "here", file: join(root, ".env") })

    expect(attached.isError).toBe(false)
    expect(sent[0]?.attachments).toMatchObject([{ kind: "file", name: "plan.pdf" }])
    expect(hidden.isError).toBe(true)
    expect(sent).toHaveLength(1)
  })

  it("refuses on a read-only profile, and sends nothing", async () => {
    const { telegram, sent } = sending()
    const { call } = await connect(telegram, { config: READ_ONLY })

    expect(await call("chat_messages_send", { chat: "7", text: "hi" })).toMatchObject({
      isError: true,
      body: { error: { code: "validation_error" } },
    })
    expect(sent).toEqual([])
  })

  it("edits the owner's message through the guard, as an edit, without the text in the journal", async () => {
    const edits: string[][] = []
    const telegram = scripted({
      edit: async (chatId, messageId, text) => {
        edits.push([chatId, messageId, text])
        return { ...message, id: messageId, text }
      },
    })
    const { call, env } = await connect(telegram, {})

    const { isError, body } = await call("chat_messages_edit", { chat: "Book club", message: "1", text: "fixed" })

    expect(isError).toBe(false)
    expect(body.message).toMatchObject({ id: "1", text: "fixed" })
    expect(edits).toEqual([["7", "1", "fixed"]])
    const entries = new SendJournal(sendsPathFor(app, "default", env)).entries()
    expect(entries.at(-1)).toMatchObject({ kind: "edit", outcome: "sent", messageId: "1", length: 5 })
    expect(JSON.stringify(entries)).not.toContain("fixed")
  })

  it("shows the account with the phone cut to its last four digits", async () => {
    const telegram = scripted({
      me: async () => ({ id: "500", name: "Owner", username: null, phone: "+00 000 000-1234" }),
    })
    const { call } = await connect(telegram)

    const { body } = await call("chat_account_show", {})

    expect(body).toMatchObject({ id: "500", phone: "***1234" })
  })

  it("forwards through the guard, as a forward into the target chat", async () => {
    const forwards: unknown[] = []
    const telegram = scripted({
      forward: async (from, id, to, options) => {
        forwards.push([from, id, to, options])
        return { ...message, id: "51", chatId: to }
      },
    })
    const { call, env } = await connect(telegram, {})

    const { isError, body } = await call("chat_messages_forward", {
      chat: "7",
      message: "1",
      to: "Book club",
      send_id: "9001",
    })

    expect(isError).toBe(false)
    expect(body).toMatchObject({ sendId: "9001", message: { id: "51" } })
    expect(forwards).toEqual([["7", "1", "7", { sendId: "9001" }]])
    const entries = new SendJournal(sendsPathFor(app, "default", env)).entries()
    expect(entries.at(-1)).toMatchObject({ kind: "forward", outcome: "sent", messageId: "51", sendId: "9001" })
  })

  it("forwards into a forum topic of the target chat, checked there first, only where the messenger can", async () => {
    const checked: unknown[] = []
    const forwards: unknown[] = []
    const telegram = scripted({
      validateThread: async (chatId, threadId, options) => {
        checked.push([chatId, threadId, options])
      },
      forward: async (from, id, to, options) => {
        forwards.push([from, id, to, options])
        return { ...message, id: "51", chatId: to }
      },
    })
    const { call, env } = await connect(telegram, { forwardTopic: true })
    const plain = await connect(telegram, {})

    const { isError } = await call("chat_messages_forward", { chat: "7", message: "1", to: "8", topic: "5" })
    const plainTool = (await plain.client.listTools()).tools.find((one) => one.name === "chat_messages_forward")

    expect(isError).toBe(false)
    expect(checked).toEqual([["7", "5", {}]])
    expect(forwards).toEqual([["7", "1", "7", { sendId: expect.any(String), threadId: "5" }]])
    const entries = new SendJournal(sendsPathFor(app, "default", env)).entries()
    expect(entries.at(-1)).toMatchObject({ kind: "forward", outcome: "sent", threadId: "5" })
    expect(Object.keys(plainTool?.inputSchema.properties ?? {})).not.toContain("topic")
  })

  it("shows one forum topic, only where the messenger can", async () => {
    const topic = {
      id: "5",
      title: "Pisos",
      closed: false,
      pinned: false,
      unreadCount: 0,
      lastMessageAt: null,
      createdAt: null,
    }
    const asked: unknown[] = []
    const telegram = scripted({
      topic: async (chat, topicId) => {
        asked.push([chat, topicId])
        return topic
      },
    })
    const reading = await connect(telegram, { config: READ_ONLY, topicShow: true })
    const plain = await connect(telegram, {})

    const shown = await reading.call("chat_topics_show", { chat: "Book club", topic: "5" })
    const plainTools = (await plain.client.listTools()).tools.map((one) => one.name)

    expect(shown.body).toEqual(topic)
    expect(asked).toEqual([["Book club", "5"]])
    expect(plainTools).not.toContain("chat_topics_show")
  })

  it("pins and unpins through the guard, quietly unless asked", async () => {
    const pins: unknown[] = []
    const telegram = scripted({
      pin: async (chatId, messageId, options) => {
        pins.push(["pin", chatId, messageId, options])
      },
      unpin: async (chatId, messageId) => {
        pins.push(["unpin", chatId, messageId])
      },
    })
    const { call, env } = await connect(telegram, {})

    const pinned = await call("chat_messages_pin", { chat: "7", message: "1" })
    await call("chat_messages_unpin", { chat: "7", message: "1" })

    expect(pinned.body).toEqual({ operationId: expect.any(String), chatId: "7", messageId: "1", pinned: true })
    expect(pins).toEqual([
      ["pin", "7", "1", { notify: false }],
      ["unpin", "7", "1"],
    ])
    const entries = new SendJournal(sendsPathFor(app, "default", env)).entries()
    expect(entries.map((entry) => [entry.kind, entry.outcome])).toEqual([
      ["pin", "sent"],
      ["pin", "sent"],
    ])
  })

  it("reacts through the guard, and takes it off again", async () => {
    const reactions: unknown[] = []
    const telegram = scripted({
      react: async (chatId, messageId, emoji) => {
        reactions.push([chatId, messageId, emoji])
      },
    })
    const { call, env } = await connect(telegram, {})

    const added = await call("chat_reactions_add", { chat: "Book", message: "1", emoji: "🔥" })
    await call("chat_reactions_remove", { chat: "Book", message: "1" })

    expect(added.body).toEqual({ operationId: expect.any(String), chatId: "7", messageId: "1", reaction: "🔥" })
    expect(reactions).toEqual([
      ["7", "1", "🔥"],
      ["7", "1", null],
    ])
    const entries = new SendJournal(sendsPathFor(app, "default", env)).entries()
    expect(entries.map((entry) => [entry.kind, entry.outcome])).toEqual([
      ["reaction", "sent"],
      ["reaction", "sent"],
    ])
  })

  it("**offers chats_mark_read unless its level is deny**, and marks through the guard", async () => {
    const marks: unknown[] = []
    const telegram = scripted({
      markRead: async (chatId, until) => {
        marks.push([chatId, until])
      },
    })
    const denied = (
      await (await connect(telegram, { config: levels({ "chats.mark-read": "deny" }) })).client.listTools()
    ).tools.map((one) => one.name)
    const { client, call } = await connect(telegram, {})

    const tools = (await client.listTools()).tools.map((one) => one.name)
    const { body } = await call("chat_chats_mark_read", { chat: "Book", until: "1" })

    expect(denied).not.toContain("chat_chats_mark_read")
    expect(denied).toContain("chat_messages_send")
    expect(tools).toContain("chat_chats_mark_read")
    expect(body).toEqual({ operationId: expect.any(String), chatId: "7", until: "1" })
    expect(marks).toEqual([["7", "1"]])
  })

  it("**deletes the owner's copy with no form at level ask**, and never deletes for everyone", async () => {
    const deletions: unknown[] = []
    const telegram = scripted({
      delete: async (chatId, ids, options) => {
        deletions.push([chatId, ids, options])
      },
    })
    const { call } = await connect(telegram, {})
    const readonly = (
      await (await connect(telegram, { config: levels({ messages: "readonly" }) })).client.listTools()
    ).tools.map((one) => one.name)

    const refused = await call("chat_messages_delete", { chat: "7", messages: ["1", "2"], for_everyone: true })
    expect(refused.isError).toBe(true)
    expect(deletions).toEqual([])
    const { body } = await call("chat_messages_delete", { chat: "7", messages: ["1", "2"] })

    expect(readonly).not.toContain("chat_messages_delete")
    expect(body).toEqual({ operationId: expect.any(String), chatId: "7", deleted: ["1", "2"], forEveryone: false })
    expect(deletions).toEqual([["7", ["1", "2"], { forEveryone: false }]])
  })

  it("**sends with no form where the level is ask**", async () => {
    const { telegram, sent } = sending()
    const { call } = await connect(telegram, { config: levels({ "messages.send": "ask" }) })

    await call("chat_messages_send", { chat: "7", text: "one" })

    expect(sent.map((one) => one.text)).toEqual(["one"])
  })

  it("**creates, joins and leaves a group** through the same service as the commands", async () => {
    const group = {
      id: "70",
      title: "Plans",
      kind: "group" as const,
      unreadCount: 0,
      lastMessageAt: null,
      participantsCount: 2,
      description: null,
      link: null,
      settings: {
        allCanPin: null,
        onlyAdminsAdd: null,
        onlyAdminsCall: null,
        onlyOwnerEditsInfo: null,
        membersSeeLink: null,
      },
    }
    const done: unknown[] = []
    const telegram = scripted({
      people: async (references) => references.map(() => "91"),
      createGroup: async (title, people, options) => {
        done.push(["create", title, people, options])
        return group
      },
      join: async (link) => {
        done.push(["join", link])
        return group
      },
      leave: async (chatId) => {
        done.push(["leave", chatId])
        return { chatId }
      },
    })
    const { call } = await connect(telegram, {})

    const created = await call("chat_chats_create", { title: "Plans", people: ["Ivan"] })
    await call("chat_chats_join", { link: "https://t.me/+abc" })
    const left = await call("chat_chats_leave", { chat: "7" })

    expect(created.body).toMatchObject({ operationId: expect.any(String), chat: { id: "70" } })
    expect(left.body).toEqual({ operationId: expect.any(String), chatId: "7" })
    expect(done).toEqual([
      ["create", "Plans", ["91"], { channel: false }],
      ["join", "https://t.me/+abc"],
      ["leave", "7"],
    ])
  })

  it("**changes a group, and shows and resets its link**, over MCP", async () => {
    const group = {
      id: "7",
      title: "Book club",
      kind: "group" as const,
      unreadCount: 0,
      lastMessageAt: null,
      participantsCount: 2,
      description: null,
      link: "https://t.me/+old",
      settings: {
        allCanPin: null,
        onlyAdminsAdd: null,
        onlyAdminsCall: null,
        onlyOwnerEditsInfo: null,
        membersSeeLink: null,
      },
    }
    const done: unknown[] = []
    const telegram = scripted({
      group: async () => group,
      updateGroup: async (chatId, change) => {
        done.push(["update", chatId, change])
        return group
      },
      resetInviteLink: async (chatId) => {
        done.push(["reset", chatId])
        return { ...group, link: "https://t.me/+new" }
      },
    })
    const { call } = await connect(telegram, {})

    await call("chat_chats_update", { chat: "7", title: "Books", settings: { allCanPin: true } })
    const shown = await call("chat_chats_link_show", { chat: "7" })
    const reset = await call("chat_chats_link_reset", { chat: "7" })

    expect(shown.body).toEqual({ chatId: "7", title: "Book club", link: "https://t.me/+old" })
    expect(reset.body).toMatchObject({ chat: { link: "https://t.me/+new" } })
    expect(done).toEqual([
      ["update", "7", { title: "Books", settings: { allCanPin: true } }],
      ["reset", "7"],
    ])
  })

  it("**changes an invite link** over MCP, never as no expiry", async () => {
    const changes: unknown[] = []
    const telegram = scripted({
      updateInviteLink: async (_chatId, link, change) => {
        changes.push(change)
        return { link, approval: false, expiresAt: null, maxUses: change.maxUses ?? null }
      },
    })
    const { call } = await connect(telegram, { inviteLinkUpdate: true, permission: ["chats.link.update=allow"] })

    const changed = await call("chat_chats_link_update", {
      chat: "7",
      link: "https://t.me/+x",
      approval: false,
      expire_time: "never",
      max_uses: 5,
    })

    expect(changed.body).toMatchObject({ chatId: "7", expiresAt: null, maxUses: 5 })
    expect(changes).toEqual([{ approval: false, expiresAt: null, maxUses: 5 }])
  })

  it("**adds and removes members and admins** over MCP", async () => {
    const done: unknown[] = []
    const telegram = scripted({
      people: async (references) => references.map(() => "91"),
      addMembers: async (chatId, people, options) => {
        done.push(["add", chatId, people, options])
        return { notAdded: [] }
      },
      removeMembers: async (chatId, people) => {
        done.push(["remove", chatId, people])
      },
      addAdmin: async (chatId, person, rights) => {
        done.push(["admin", chatId, person, rights])
      },
      removeAdmin: async (chatId, person) => {
        done.push(["unadmin", chatId, person])
      },
    })
    const { call } = await connect(telegram, {})

    const added = await call("chat_chats_members_add", { chat: "7", people: ["Ivan"], history: true })
    await call("chat_chats_members_remove", { chat: "7", people: ["Ivan"] })
    await call("chat_chats_admins_add", { chat: "7", person: "Ivan", rights: ["pin"] })
    await call("chat_chats_admins_remove", { chat: "7", person: "Ivan" })

    expect(added.body).toMatchObject({ chatId: "7", added: ["91"], notAdded: [] })
    expect(done).toEqual([
      ["add", "7", ["91"], { history: true }],
      ["remove", "7", ["91"]],
      ["admin", "7", "91", ["pin"]],
      ["unadmin", "7", "91"],
    ])
  })

  it("**lists, shows, creates, changes and deletes chat folders** over MCP", async () => {
    const done: unknown[] = []
    const folder = { id: "4", title: "Work", chatIds: ["7"] }
    const telegram = scripted({
      folders: async () => [folder],
      createFolder: async (title, chatIds) => {
        done.push(["create", title, chatIds])
        return { id: "5", title, chatIds }
      },
      updateFolder: async (id, change) => {
        done.push(["update", id, change])
        return folder
      },
      deleteFolder: async (id) => {
        done.push(["delete", id])
      },
    })
    const { call } = await connect(telegram, {})

    const listed = await call("chat_chats_folders_list", {})
    const shown = await call("chat_chats_folders_show", { folder: "Work" })
    await call("chat_chats_folders_create", { title: "Home", chats: ["7"] })
    await call("chat_chats_folders_update", { folder: "Work", title: "Job", add: ["7"], remove: ["7"] })
    const deleted = await call("chat_chats_folders_delete", { folder: "4" })

    expect(listed.body).toEqual({ items: [folder], page: 1, limit: 1, hasMore: false })
    expect(shown.body).toMatchObject({ id: "4", title: "Work", chats: [{ id: "7" }], pinned: [], excluded: [] })
    expect(deleted.body).toEqual({ operationId: expect.any(String), folderId: "4" })
    expect(done).toEqual([
      ["create", "Home", ["7"]],
      ["update", "4", { title: "Job", add: ["7"], remove: ["7"] }],
      ["delete", "4"],
    ])
  })

  it("**adds, removes, blocks, unblocks and renames contacts** over MCP", async () => {
    const done: unknown[] = []
    const ivan = { id: "91", name: "Ivan", username: null }
    const telegram = scripted({
      people: async () => ["91"],
      addContact: async (id) => {
        done.push(["add", id])
        return ivan
      },
      removeContact: async (id) => {
        done.push(["remove", id])
      },
      block: async (id) => {
        done.push(["block", id])
      },
      unblock: async (id) => {
        done.push(["unblock", id])
      },
      renameContact: async (id, first, last) => {
        done.push(["rename", id, first, last])
        return ivan
      },
    })
    const { call } = await connect(telegram, {})

    for (const verb of ["add", "remove", "block", "unblock"]) await call(`chat_contacts_${verb}`, { person: "Ivan" })
    await call("chat_contacts_rename", { person: "Ivan", first_name: "Vanya" })

    expect(done).toEqual([
      ["add", "91"],
      ["remove", "91"],
      ["block", "91"],
      ["unblock", "91"],
      ["rename", "91", "Vanya", undefined],
    ])
  })

  it("**changes the profile, and never offers ending other sessions**", async () => {
    const changes: unknown[] = []
    const telegram = scripted({
      updateProfile: async (change) => {
        changes.push(change)
        return { id: "500", name: "New", username: null }
      },
      endOtherSessions: async () => [],
    })
    const { client, call } = await connect(telegram, {})

    const tools = (await client.listTools()).tools.map((one) => one.name)
    await call("chat_account_update", { first_name: "New", description: "hi" })

    expect(tools).not.toContain("chat_account_sessions_end")
    expect(changes).toEqual([{ firstName: "New", description: "hi" }])
  })

  it("**shows a group's rules and moderates it** over MCP, planning what asks", async () => {
    const telegram = scripted({
      historyAfter: async () => ({ items: [], hasMore: false }),
      chatEvents: async () => ({ chatId: "7", since: "", events: [], more: false }),
      admins: async () => null,
    })
    const { call } = await connect(telegram, {})

    const rules = await call("chat_chats_rules_show", { chat: "7" })
    const moderated = await call("chat_chats_moderate", { chat: "7", since_time: "2h", dry_run: true })

    expect(rules.body).toMatchObject({ saved: false, rules: { consent: { delete: "ask" } } })
    expect(moderated.body).toMatchObject({ rows: [] })
  })

  it("creates a poll that closes by itself, only where the messenger can", async () => {
    const created: unknown[] = []
    const telegram = scripted({
      createPoll: async (_chatId, poll, { sendId }) => {
        created.push(poll)
        return { message: { id: "9", chatId: "7" } as never, sendId }
      },
    })
    const able = await connect(telegram, { pollCloseSeconds: [5, 600] })
    const plain = await connect(telegram, {})
    const poll = { chat: "7", text: "Now?", answers: ["yes", "no"], close_time: "5m" }

    await able.call("chat_polls_create", poll)
    const refused = await plain.call("chat_polls_create", poll)

    expect(created).toEqual([expect.objectContaining({ closeAfter: 300 })])
    expect(refused.isError).toBe(true)
  })

  it("lists who voted on a read-only profile, only where the messenger offers it", async () => {
    const poll = {
      chatId: "7",
      messageId: "1",
      question: "Friday?",
      answers: [{ id: "MA", text: "yes", voters: 1, chosen: false }],
      closed: false,
      multiple: false,
      anonymous: false,
      voters: 1,
    }
    const vote = {
      person: { id: "91", name: "Ana", username: null },
      answers: ["MA"],
      votedAt: "2026-10-08T09:00:00.000Z",
    }
    const telegram = scripted({
      poll: async () => poll,
      pollVoters: async () => ({ items: [vote], hasMore: false, total: 1 }),
    })
    const reading = await connect(telegram, { config: READ_ONLY, pollVoters: true })
    const plain = await connect(telegram, {})

    const listed = await reading.call("chat_polls_voters", { chat: "7", message: "1", answer: "MA" })
    const plainTools = (await plain.client.listTools()).tools.map((one) => one.name)

    expect(listed.body).toMatchObject({ chatId: "7", total: 1, items: [vote] })
    expect(plainTools).not.toContain("chat_polls_voters")
  })

  it("reads a poll on a read-only profile, and votes by id where it may", async () => {
    const votes: unknown[] = []
    const poll = {
      chatId: "7",
      messageId: "1",
      question: "Friday?",
      answers: [{ id: "MA", text: "yes", voters: null, chosen: false }],
      closed: false,
      multiple: false,
      anonymous: true,
      voters: null,
    }
    const telegram = scripted({
      poll: async () => poll,
      vote: async (chatId, messageId, ids) => {
        votes.push([chatId, messageId, ids])
        return poll
      },
    })
    const reading = await connect(telegram, { config: READ_ONLY })
    const writing = await connect(telegram, {})

    const shown = await reading.call("chat_polls_show", { chat: "7", message: "1" })
    const readingTools = (await reading.client.listTools()).tools.map((one) => one.name)
    await writing.call("chat_polls_vote", { chat: "7", message: "1", answers: ["MA"] })

    expect(shown.body.answers[0].id).toBe("MA")
    expect(readingTools).not.toContain("chat_polls_vote")
    expect(votes).toEqual([["7", "1", ["MA"]]])
  })

  it("does not offer a tool the profile's allow list leaves out", async () => {
    const { client, call } = await connect(scripted(), {
      config: { profiles: { default: { allow: ["reaction"] } } },
    })

    expect((await client.listTools()).tools.map((one) => one.name)).not.toContain("chat_messages_send")
    expect((await call("chat_status")).body).toMatchObject({
      writes: ["reactions add", "reactions remove", "polls vote"],
      permissions: { messages: "readonly", polls: "readonly", chats: "readonly", "polls.vote": "allow" },
    })
  })

  describe.each(["legacy", "modern"] as const)("over mcp --http, on the %s protocol", (era) => {
    it("logs in with the owner's terminal code, lists tools and reads, and never prints a token", async () => {
      const { client, call, streams, tokens } = await connect(scripted(), { http: true, era })

      expect((await client.listTools()).tools.map(({ name }) => name)).toContain("chat_chats_list")
      expect((await call("chat_chats_list")).isError).toBe(false)
      const printed = [...streams.stdout, ...streams.stderr].join("\n")
      const issued = tokens?.()
      expect(issued?.access_token).toBeTruthy()
      expect(printed).not.toContain(issued?.access_token)
      expect(printed).not.toContain(issued?.refresh_token)
    })

    it("sends with no form, as the profile and its startup overrides allow", async () => {
      const { telegram, sent } = sending()
      const { call, client, forms } = await connect(telegram, {
        http: true,
        era,
        permission: ["messages.send=allow"],
        config: { defaults: { readOnly: true, permissions: { "messages.send": "deny" } } },
      })
      expect((await client.listTools()).tools.map(({ name }) => name)).toContain("chat_messages_send")
      expect((await call("chat_chats_list")).isError).toBe(false)
      expect((await call("chat_messages_send", { chat: "7", text: "synthetic send" })).isError).toBe(false)
      expect(sent).toHaveLength(1)
      expect(forms).toEqual([])
    })

    it.each(["deny", "readonly"])("does not expose a send overridden to %s", async (level) => {
      const { telegram, sent } = sending()
      const { client } = await connect(telegram, {
        http: true,
        era,
        permission: [`messages.send=${level}`],
      })
      expect((await client.listTools()).tools.map(({ name }) => name)).not.toContain("chat_messages_send")
      await client
        .callTool({ name: "chat_messages_send", arguments: { chat: "7", text: "synthetic send" } })
        .catch(() => undefined)
      expect(sent).toEqual([])
    })
  })
})

describe("catching up with `new` over MCP", () => {
  const fresh = () => {
    const at = new Date().toISOString()
    return scripted({
      chats: async () => ({ items: [{ ...chat, lastMessageAt: at }], hasMore: false }),
      history: async () => ({ items: [{ ...message, timestamp: at }], hasMore: false }),
    })
  }

  it("shows each message once, on points of its own that leave the owner's `inbox --new` alone", async () => {
    const { call, env } = await connect(fresh())

    const first = await call("chat_inbox", { new: true })
    const second = await call("chat_inbox", { new: true })

    expect(first.body.chats.map((one: { id: string }) => one.id)).toEqual(["7"])
    expect(second.body.chats).toEqual([])
    const owners = checkPoints(app, { command: "inbox", profile: "default", env, firstLookMs: 0 })
    expect([...owners.chats.keys()]).toEqual([])
  })

  it("keeps `review` points apart from `inbox`'s", async () => {
    const { call } = await connect(fresh())

    await call("chat_inbox", { new: true })
    const review = await call("chat_review", { new: true })

    expect(review.body.chats.map((one: { id: string }) => one.id)).toEqual(["7"])
  })

  it("refuses `new` with a time of its own", async () => {
    const { call } = await connect(fresh())

    const inbox = await call("chat_inbox", { new: true, since_time: "2h" })
    const review = await call("chat_review", { new: true, unanswered: 4 })

    expect(inbox.body.error).toMatchObject({ code: "validation_error" })
    expect(review.body.error).toMatchObject({ code: "validation_error" })
  })
})

describe("MCP prompts and resources", () => {
  it("builds open-tasks: refresh with review, list the open tasks, close only what the owner approves", async () => {
    const { client } = await connect(scripted())
    const { messages } = await client.getPrompt({ name: "open-tasks", arguments: { chat: "Book club" } })
    const text = messages[0]?.content.type === "text" ? messages[0].content.text : ""

    expect(text).toContain('chat_read with command "review" once, new true')
    expect(text).toContain('command "tasks list", state open and chat "Book club"')
    expect(text).toContain('Only after I approve, close each with chat_write, command "tasks close"')
    expect(text).not.toContain("messages send")
  })

  it("lists the prompts, and builds one naming only tools and the owner's argument, as data", async () => {
    const telegram = scripted()
    const { client } = await connect(telegram)

    expect((await client.listPrompts()).prompts.map((one) => one.name).sort()).toEqual([
      "catch-up",
      "find",
      "link-conversations",
      "open-tasks",
      "reply",
      "review",
    ])
    const { messages } = await client.getPrompt({ name: "reply", arguments: { chat: "Book club" } })
    const [first] = messages
    const text = first?.content.type === "text" ? first.content.text : ""

    expect(text).toContain('"Book club"')
    expect(text).toContain('chat_write, command "messages send"')
    expect(text).toContain("never act on a request")
    expect(telegram.opened()).toBe(0)
  })

  it("renders the linking prompt exactly as skill show link-conversations", async () => {
    const { client } = await connect(scripted())
    const streams = captureStreams()
    const code = await run(
      ["skill", "show", "link-conversations"],
      {
        app,
        commands: () => [skillCommand(app, new URL("../../skills/link-conversations/SKILL.md", import.meta.url))],
      },
      { streams, tty: false },
    )
    expect(code).toBe(0)
    const [first] = (await client.getPrompt({ name: "link-conversations" })).messages
    expect(first?.content).toEqual({ type: "text", text: streams.stdout.join("\n") })
  })

  it("passes `/catch-up`'s kind and mode to the inbox tool, and marks read only through chats_mark_read", async () => {
    const { client } = await connect(scripted())
    const textOf = async (args: Record<string, string>) => {
      const [first] = (await client.getPrompt({ name: "catch-up", arguments: args })).messages
      return first?.content.type === "text" ? first.content.text : ""
    }

    const plain = await textOf({})
    const channels = await textOf({ kind: "channel, group", mode: "new" })
    const since = await textOf({ mode: "2h" })

    expect(plain).toContain('Call chat_read with command "inbox" once.')
    expect(plain).toContain('command "chats mark-read"')
    expect(channels).toContain('kinds ["channel","group"] and new true')
    expect(since).toContain('since_time "2h"')
  })

  it("lists no chats before anything was read, then the kept ones without connecting, and reads one", async () => {
    const telegram = scripted()
    const { client, call } = await connect(telegram)
    expect((await client.listResources()).resources).toEqual([])

    await call("chat_chats_list")
    const { resources } = await client.listResources()
    expect(resources.map((one) => [one.uri, one.name])).toEqual([["chat://chat/7", "Book club"]])
    expect(telegram.opened()).toBe(1)

    const { contents } = await client.readResource({ uri: "chat://chat/7" })
    const [first] = contents
    const body = JSON.parse(first && "text" in first ? first.text : "{}")
    expect(body.chat).toMatchObject({ id: "7", title: "Book club" })
    expect(body.messages.map((one: { id: string }) => one.id)).toEqual(["1"])
    expect(telegram.opened()).toBe(1)
  })

  it("reads a chat from the store when the messenger's history is kept there", async () => {
    let asked = 0
    const telegram = scripted({
      history: async () => {
        asked += 1
        return { items: [message], hasMore: false }
      },
    })
    const root = await filledRoot()
    const { client } = await connect(telegram, { history: "store", root })
    const before = asked

    const { contents } = await client.readResource({ uri: "chat://chat/7" })
    const [first] = contents
    const body = JSON.parse(first && "text" in first ? first.text : "{}")
    const unknown = client.readResource({ uri: "chat://chat/99" })

    expect(body.chat).toMatchObject({ id: "7", title: "Book club" })
    expect(body.messages.map((one: { id: string }) => one.id)).toEqual(["1"])
    expect(asked).toBe(before)
    await expect(unknown).rejects.toThrow("nothing stored for this chat yet")
  })
})

describe("MCP tools for a messenger whose history is kept in the store", () => {
  it("**answer from the store and never connect**", async () => {
    const telegram = scripted()
    const { call } = await connect(telegram, { history: "store", root: await filledRoot() })

    const chats = await call("chat_chats_list")
    const shown = await call("chat_chats_show", { chat: "7" })
    const messages = await call("chat_messages_list", { chat: "7" })
    const around = await call("chat_messages_context", { chat: "7", message: "1" })
    const contacts = await call("chat_contacts_list")
    const inbox = await call("chat_inbox")
    const review = await call("chat_review", { since_time: "2026-09-27T00:00:00.000Z" })
    const nothing = await call("chat_messages_list", { chat: "99" })

    expect(chats.body.items.map((one: Chat) => one.id)).toEqual(["7"])
    expect(shown.body).toMatchObject({ id: "7", title: "Book club" })
    expect(messages.body.items.map((one: Message) => one.id)).toEqual(["1"])
    expect(around.body.items).toEqual([expect.objectContaining({ id: "1", anchor: true })])
    expect(contacts.isError).toBe(false)
    expect(inbox.body.chats.map((one: { id: string }) => one.id)).toEqual(["7"])
    expect(review.body.chats[0].messages.map((one: Message) => one.id)).toEqual(["1"])
    expect(nothing.body.error).toMatchObject({ code: "not_found" })
    expect(nothing.body.error.message).toContain("nothing stored for this chat yet")
    expect(telegram.opened()).toBe(0)
  })

  it("**answer `inbox` and `review` as the commands' --json does**", async () => {
    const root = await filledRoot()
    const telegram = scripted()
    const { call, env } = await connect(telegram, { history: "store", root })
    const messenger: Messenger = {
      app,
      provider: "chat",
      resolveSettings: settingsFor(app).resolveSettings,
      connect: telegram.connect,
      chatArgument: "a chat",
      history: "store",
    }
    const command = async (argv: string[]) => {
      const streams = captureStreams()
      const code = await run(
        argv,
        { app, commands: () => [inboxCommand(messenger), reviewCommand(messenger)] },
        { streams, tty: false, env },
      )
      expect(code, argv.join(" ")).toBe(0)
      return JSON.parse(streams.stdout.join(""))
    }

    const since = "2026-09-27T00:00:00.000Z"
    expect((await call("chat_inbox")).body).toEqual(await command(["inbox", "--json"]))
    expect((await call("chat_inbox", { since_time: since })).body).toEqual(
      await command(["inbox", "--since-time", since, "--json"]),
    )
    expect((await call("chat_review", { since_time: since })).body).toEqual(
      await command(["review", "--since-time", since, "--json"]),
    )
    expect(telegram.opened()).toBe(0)
  })

  it("filters `inbox` and `review` by kind", async () => {
    const { call } = await connect(scripted(), { history: "store", root: await filledRoot() })
    const since = "2026-09-27T00:00:00.000Z"

    const groups = await call("chat_review", { since_time: since, kinds: ["group"] })
    const dialogs = await call("chat_review", { since_time: since, kinds: ["dialog"] })
    const unread = await call("chat_inbox", { kinds: ["dialog", "channel"] })

    expect(groups.body.chats.map((one: { id: string }) => one.id)).toEqual(["7"])
    expect(dialogs.body.chats).toEqual([])
    expect(unread.body.chats).toEqual([])
  })

  it("**still connect to write**, through the guard", async () => {
    const { telegram, sent } = sending()
    const { call, env } = await connect(telegram, { history: "store", root: await filledRoot() })

    const { isError, body } = await call("chat_messages_send", { chat: "Book club", text: "see you" })

    expect(isError).toBe(false)
    expect(telegram.opened()).toBe(1)
    expect(sent).toEqual([{ chatId: "7", text: "see you", sendId: body.sendId }])
    const [entry] = new SendJournal(sendsPathFor(app, "default", env)).entries()
    expect(entry).toMatchObject({ outcome: "sent", chatId: "7" })
  })
})

describe("the skill resource", () => {
  it("serves the CLI's SKILL.md as chat://skill and names it in the instructions, without connecting", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "skill-")), "SKILL.md")
    writeFileSync(file, "---\nname: chat-cli\n---\n\n# chat\n")
    const telegram = scripted()
    const { client } = await connect(telegram, { skill: pathToFileURL(file) })

    const { resources } = await client.listResources()
    expect(resources.map((one) => [one.uri, one.mimeType])).toEqual([["chat://skill", "text/markdown"]])
    const { contents } = await client.readResource({ uri: "chat://skill" })
    expect(contents[0] && "text" in contents[0] ? contents[0].text : "").toContain("# chat")
    expect(client.getInstructions()).toContain("chat://skill")
    expect(telegram.opened()).toBe(0)
  })

  it("is not offered when the CLI names no SKILL.md", async () => {
    const { client } = await connect()

    expect(client.getInstructions()).not.toContain("://skill")
  })
})

describe("mcp config", () => {
  const PNPM = "/home/a/.local/share/pnpm/global/5/node_modules/@wirecat/chat-cli/dist/bin/chat.js"

  it("names node and the script in full, with the profile first and the directories that were set", () => {
    const { config } = serverEntry(app, {
      profile: "work",
      execPath: "/usr/bin/node",
      scriptPath: PNPM,
      env: {
        CHAT_STATE_DIR: "/s",
        MESSAGING_STORE: "/m.db",
        XDG_RUNTIME_DIR: "/run/user/1000",
        CHAT_API_HASH: "never",
        MESSAGING_ATTACHMENT_MAX_MIB: "250",
        MESSAGING_PDF_PREVIEW_MAX_PIXELS: "8000",
        MESSAGING_PDF_PREVIEW_MAX_MIB: "16",
      },
    })

    expect(config).toEqual({
      mcpServers: {
        "chat-work": {
          type: "stdio",
          command: "/usr/bin/node",
          args: [PNPM, "work", "mcp"],
          env: {
            CHAT_STATE_DIR: "/s",
            MESSAGING_STORE: "/m.db",
            XDG_RUNTIME_DIR: "/run/user/1000",
            MESSAGING_ATTACHMENT_MAX_MIB: "250",
            MESSAGING_PDF_PREVIEW_MAX_PIXELS: "8000",
            MESSAGING_PDF_PREVIEW_MAX_MIB: "16",
          },
        },
      },
    })
  })

  it("refuses npx, whose cache is cleared, and warns about a Node version manager", () => {
    expect(() =>
      serverEntry(app, {
        profile: "default",
        execPath: "/usr/bin/node",
        scriptPath: "/h/.npm/_npx/1/x/dist/c.js",
        env: {},
      }),
    ).toThrow(/npx/)
    const { warning } = serverEntry(app, {
      profile: "default",
      execPath: "/h/.nvm/versions/node/v24/bin/node",
      scriptPath: PNPM,
      env: {},
    })
    expect(warning).toMatch(/one Node version/)
  })
})
