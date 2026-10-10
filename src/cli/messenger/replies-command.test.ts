import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { captureStreams } from "@wirecat/cli-core"
import { afterEach, describe, expect, it, vi } from "vitest"
import { defaultRule } from "../../replies/rules.js"
import { openStore } from "../../store/store.js"
import { run } from "../program.js"
import { settingsFor } from "../settings.js"
import { rememberAccount } from "./accounts.js"
import type { Messenger } from "./context.js"
import type { MessengerAdapter } from "./port.js"
import { repliesCommand } from "./replies-command.js"

const app = {
  command: "chat",
  appName: "chat-cli",
  envPrefix: "CHAT",
  description: "A test messenger",
  version: "1.0.0",
}
afterEach(() => vi.unstubAllGlobals())

const sendsNothing = async (): Promise<MessengerAdapter> => {
  throw new Error("replies test must never connect, let alone send")
}

const messenger: Messenger = {
  app,
  provider: "chat",
  resolveSettings: settingsFor(app).resolveSettings,
  connect: sendsNothing,
  chatArgument: "a chat",
}

const setUp = async () => {
  const root = mkdtempSync(join(tmpdir(), "replies-test-"))
  const env = {
    CHAT_STATE_DIR: join(root, "state"),
    CHAT_CONFIG_DIR: join(root, "config"),
    MESSAGING_STORE: join(root, "m.db"),
  }
  rememberAccount(app, "default", "500", env)
  const store = await openStore({ path: env.MESSAGING_STORE })
  const account = { provider: "chat", account: "500" }
  const at = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString()
  const dialog = { kind: "dialog" as const, unreadCount: 0, lastMessageAt: at(1), participantsCount: null }
  const said = (id: string, minutes: number) => ({
    id,
    chatId: "11",
    senderId: "11",
    senderName: "Ana Example",
    timestamp: at(minutes),
    editedAt: null,
    text: "are you there?",
    outgoing: false,
    attachments: [],
    replyTo: null,
    forwardedFrom: null,
    reactions: null,
  })
  await store.saveChats(account, [{ ...dialog, id: "11", title: "Ana" }])
  await store.saveMessages(account, "11", [said("1", 30), said("2", 20)], { via: "test" })
  await store.close()
  mkdirSync(env.CHAT_CONFIG_DIR, { recursive: true })
  const rule = {
    ...defaultRule("away"),
    reply: { template: "Thanks, {firstName} — later today.", model: "fill-only", asReply: true },
    limits: { perChat: "5/1d", perPerson: "1/1d" },
  }
  writeFileSync(
    join(env.CHAT_CONFIG_DIR, "default.replies.json"),
    JSON.stringify({ audience: { reply: "listed", allow: { people: ["11"] } }, rules: [rule] }),
  )
  return { env, root }
}

const replies = async (argv: string[], env: NodeJS.ProcessEnv) => {
  const streams = captureStreams()
  const code = await run(argv, { app, commands: () => [repliesCommand(messenger)] }, { streams, tty: false, env })
  return { code, stdout: streams.stdout, stderr: streams.stderr }
}

describe("replies test", () => {
  it("previews ai instructions and fallback without a request, and calls only with --ai and consent", async () => {
    const { env } = await setUp()
    const path = join(env.CHAT_CONFIG_DIR, "default.replies.json")
    const file = JSON.parse(readFileSync(path, "utf8"))
    file.rules[0].reply = { template: "{% ai %}Greet {{ sender.firstName }}{% else %}Later{% endai %}", asReply: true }
    writeFileSync(path, JSON.stringify(file))
    writeFileSync(
      join(env.CHAT_CONFIG_DIR, "config.json"),
      JSON.stringify({
        profiles: {
          default: {
            models: { replies: { provider: "openai", model: "test-model", baseUrl: "https://example.test/v1" } },
          },
        },
      }),
    )
    const fetcher = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            choices: [{ finish_reason: "stop", message: { content: "Hello Ana" } }],
            usage: { total_tokens: 3 },
          }),
        ),
    )
    vi.stubGlobal("fetch", fetcher)
    expect((await replies(["replies", "consents", "grant", "--json"], env)).code).toBe(0)
    const preview = await replies(["replies", "test", "--since-time", "1d", "--json"], env)
    expect(JSON.parse(preview.stdout.join("")).rules[0].would[0]).toMatchObject({
      text: "Later",
      blocks: [{ instruction: "Greet Ana", fallback: "Later" }],
    })
    expect(fetcher).not.toHaveBeenCalled()
    const modeled = await replies(["replies", "test", "--ai", "--json"], env)
    expect(modeled.code).toBe(0)
    expect(JSON.parse(modeled.stdout.join("")).rules[0].would[0].text).toBe("Hello Ana")
    expect(fetcher).toHaveBeenCalledTimes(1)
    const configPath = join(env.CHAT_CONFIG_DIR, "config.json")
    const config = JSON.parse(readFileSync(configPath, "utf8"))
    config.profiles.default.permissions = { messages: "deny" }
    writeFileSync(configPath, JSON.stringify(config))
    expect((await replies(["replies", "test", "--ai", "--json"], env)).code).not.toBe(0)
    expect(fetcher).toHaveBeenCalledTimes(1)
    delete config.profiles.default.permissions
    writeFileSync(configPath, JSON.stringify(config))
    expect((await replies(["replies", "test", "--ai", "--offline", "--json"], env)).code).toBe(2)
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect((await replies(["replies", "consents", "deny", "11", "--json"], env)).code).toBe(0)
    const denied = await replies(["replies", "test", "--ai", "--json"], env)
    expect(JSON.parse(denied.stdout.join("")).rules[0].would[0].text).toBe("Later")
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it("shows, grants, revokes and manages profile chat opt-outs without a connection", async () => {
    const { env } = await setUp()
    const invoke = (args: string[]) => replies(["replies", "consents", ...args, "--json"], env)
    expect(JSON.parse((await invoke(["show"])).stdout.join(""))).toEqual({ provider: null, deniedChats: [] })
    expect((await invoke(["grant"])).code).toBe(3)
    expect((await invoke(["deny", ""])).code).toBe(2)
    for (const command of ["deny", "deny", "allow", "allow"]) {
      const result = await invoke([command, "900719925474099399"])
      expect(result.code).toBe(0)
      expect(JSON.parse(result.stdout.join(""))).toEqual({
        provider: null,
        deniedChats: command === "deny" ? ["900719925474099399"] : [],
      })
    }
    writeFileSync(
      join(env.CHAT_CONFIG_DIR, "config.json"),
      JSON.stringify({
        profiles: { default: { models: { replies: { provider: "anthropic", model: "test-model" } } } },
      }),
    )
    const granted = await invoke(["grant"])
    expect(JSON.parse(granted.stdout.join("")).provider).toBe("anthropic:https://api.anthropic.com")
    expect((await invoke(["revoke"])).code).toBe(0)
    expect(JSON.parse((await invoke(["show"])).stdout.join("")).provider).toBeNull()
  })
  it("**says what a rule would answer, counting its limits, and sends, connects and saves nothing**", async () => {
    const { env } = await setUp()
    const before = readdirSync(env.CHAT_STATE_DIR).sort()

    const { code, stdout } = await replies(["replies", "test", "--json"], env)

    expect(code).toBe(0)
    const answer = JSON.parse(stdout.join(""))
    const [away] = answer.rules
    expect(away.would).toEqual([
      expect.objectContaining({
        locator: "msg:chat/500/11/1",
        to: { id: "11", name: "Ana Example" },
        text: "Thanks, Ana — later today.",
      }),
    ])
    expect(away.skipped).toEqual({ "the person's limit is reached": 1 })
    expect(answer.botUnknown).toBe(1)
    expect(readdirSync(env.CHAT_STATE_DIR).sort()).toEqual(before)
  })

  it("refuses a rule it does not have, naming the ones it has", async () => {
    const { env } = await setUp()

    const { code, stderr } = await replies(["replies", "test", "nope"], env)

    expect(code).not.toBe(0)
    expect(stderr.join("")).toContain("away")
  })
})
