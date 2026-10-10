import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CliError, captureStreams } from "@wirecat/cli-core"
import { Command } from "commander"
import { describe, expect, it } from "vitest"
import { type BaseContext, baseContext } from "../context.js"
import { run } from "../program.js"
import { settingsFor } from "../settings.js"
import { runsCommand } from "./command.js"
import { listRuns, runsDirFor } from "./run.js"

const app = { command: "app", appName: "app-cli", envPrefix: "APP", description: "A test CLI", version: "1.2.3" }
const { resolveSettings } = settingsFor(app)

const TITLE = "Family Secrets"
const BODY = "the pin is 4321"

type Action = (context: BaseContext) => Promise<unknown>

const call = async (argv: string[], action: Action = async () => {}, config?: string) => {
  const root = mkdtempSync(join(tmpdir(), "runs-recording-"))
  const env = { APP_STATE_DIR: join(root, "state"), APP_CONFIG_DIR: join(root, "config") }
  if (config !== undefined) {
    mkdirSync(env.APP_CONFIG_DIR, { recursive: true })
    writeFileSync(join(env.APP_CONFIG_DIR, "config.json"), config)
  }
  const streams = captureStreams()
  const definition = {
    app,
    commands: () => [
      new Command("messages").addCommand(
        new Command("send")
          .argument("<chat>")
          .argument("<text>")
          .action(async function (this: Command) {
            const context = baseContext(this, resolveSettings)
            context.renderer.result(
              await context.run(async (events) => {
                events({ event: "request", operation: "messages.send", ids: { chat: "777" } })
                const answer = await action(context)
                events({ event: "response", operation: "messages.send", durationMs: 5, outcome: "ok" })
                return answer ?? { sent: true }
              }),
            )
          }),
      ),
      runsCommand(app),
    ],
  }
  const code = await run(argv, definition, { streams, tty: false, env })
  const runsDir = runsDirFor(app, env)
  return { code, streams, runsDir, env }
}

const everythingUnder = (dir: string): string =>
  readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => readFileSync(join(entry.parentPath, entry.name), "utf8"))
    .join("\n")

describe("a recorded run", () => {
  it("**keeps ids and timings and never the chat or the text typed**", async () => {
    const { code, streams, runsDir } = await call(["messages", "send", TITLE, BODY, "--record", "--json"])

    expect(code).toBe(0)
    expect(streams.stdout).toHaveLength(1)
    expect(JSON.parse(streams.stdout[0] ?? "")).toEqual({ sent: true })

    const [metadata] = listRuns(runsDir)
    expect(metadata).toMatchObject({ command: "messages send", status: "success", requests: 1, cliVersion: "1.2.3" })
    const kept = everythingUnder(runsDir)
    expect(kept).toContain('"chat":"777"')
    expect(kept).not.toContain(TITLE)
    expect(kept).not.toContain(BODY)
  })

  it("is not kept when it succeeds without --record", async () => {
    const { runsDir } = await call(["messages", "send", TITLE, BODY])

    expect(listRuns(runsDir)).toEqual([])
  })

  it("is kept when it fails, with the code a script branches on and never the sentence", async () => {
    const { code, runsDir } = await call(["messages", "send", TITLE, BODY], async () => {
      throw new CliError("provider_error", `Telegram refused "${BODY}"`, { providerError: "PEER_ID_INVALID" })
    })

    expect(code).toBe(11)
    expect(listRuns(runsDir)).toHaveLength(1)
    const [metadata] = listRuns(runsDir)
    expect(metadata).toMatchObject({
      status: "failed",
      errorCode: "provider_error",
      providerError: "PEER_ID_INVALID",
      keptBecauseFailed: true,
    })
    expect(everythingUnder(runsDir)).not.toContain(BODY)
  })

  it("is not kept when it fails with --no-record", async () => {
    const { runsDir } = await call(["messages", "send", TITLE, BODY, "--no-record"], async () => {
      throw new CliError("provider_error", "refused")
    })

    expect(listRuns(runsDir)).toEqual([])
  })

  it("**finishes as a timeout, not as running, when --timeout ends it**", async () => {
    const { code, runsDir } = await call(
      ["messages", "send", TITLE, BODY, "--record", "--timeout", "50ms"],
      (context) => {
        return new Promise((_, reject) => {
          context.track({ close: async () => reject(new CliError("network_error", "closed")) })
        })
      },
    )

    expect(code).toBe(9)
    expect(listRuns(runsDir)[0]).toMatchObject({ status: "failed", errorCode: "timeout" })
  })

  it("shows its events on stderr with --trace and keeps nothing", async () => {
    const { streams, runsDir } = await call(["messages", "send", TITLE, BODY, "--trace"])

    expect(streams.stderr.map((line) => JSON.parse(line).operation)).toEqual(["messages.send", "messages.send"])
    expect(listRuns(runsDir)).toEqual([])
  })
})

describe("a failure before the command runs", () => {
  it("is kept, naming the command and never what was typed", async () => {
    const { code, runsDir } = await call(["messages", "send", TITLE, "--bogus"])

    expect(code).not.toBe(0)
    expect(listRuns(runsDir)).toHaveLength(1)
    expect(listRuns(runsDir)[0]).toMatchObject({
      command: "messages send",
      status: "failed",
      errorCode: "validation_error",
      keptBecauseFailed: true,
    })
    expect(everythingUnder(runsDir)).not.toContain(TITLE)
  })

  it("is kept for a profile with no command after it", async () => {
    const { code, runsDir } = await call(["work"])

    expect(code).toBe(2)
    expect(listRuns(runsDir)[0]).toMatchObject({ command: "app", profile: "work", errorCode: "validation_error" })
  })

  it("is kept when the configuration will not load", async () => {
    const { code, runsDir } = await call(["messages", "send", TITLE, BODY], undefined, "{ not json")

    expect(code).not.toBe(0)
    expect(listRuns(runsDir)).toHaveLength(1)
    expect(listRuns(runsDir)[0]).toMatchObject({ command: "messages send", status: "failed" })
  })

  it("is not kept with --no-record, nor for --help", async () => {
    expect(listRuns((await call(["messages", "send", TITLE, "--bogus", "--no-record"])).runsDir)).toEqual([])
    expect(listRuns((await call(["messages", "--help"])).runsDir)).toEqual([])
  })
})

describe("the runs command", () => {
  it("lists, shows and locates a recorded run without starting one of its own", async () => {
    const { runsDir, env } = await call(["messages", "send", TITLE, BODY, "--record"])
    const [metadata] = listRuns(runsDir)
    const read = async (argv: string[]) => {
      const streams = captureStreams()
      const code = await run(argv, { app, commands: () => [runsCommand(app)] }, { streams, tty: false, env })
      return { code, answer: streams.stdout[0] ? JSON.parse(streams.stdout[0]) : undefined }
    }

    expect((await read(["runs", "list", "--json"])).answer).toMatchObject({
      items: [{ runId: metadata?.runId }],
      hasMore: false,
    })
    const shown = (await read(["runs", "show", metadata?.runId ?? "", "--json"])).answer
    expect(shown.events.map((event: { event: string }) => event.event)).toEqual(["request", "response"])
    expect(shown.events[0]).not.toHaveProperty("runId")
    expect((await read(["runs", "path", metadata?.runId ?? "", "--json"])).answer.path).toContain(runsDir)
    expect(listRuns(runsDir)).toHaveLength(1)
    expect((await read(["runs", "path", "no-such-run"])).code).toBe(6)
    expect(listRuns(runsDir).map((one) => one.command)).toContain("runs path")
  })
})

it("records failed batch IDs on a partial run without retaining error payloads", async () => {
  const { code, runsDir } = await call(["messages", "send", TITLE, BODY, "--json"], async () => ({
    batch: {
      failed: 1,
      failures: [{ id: "50", stage: "download", attachment: 2, error: { code: "rate_limited", message: BODY } }],
    },
  }))
  expect(code).toBe(0)
  expect(listRuns(runsDir)[0]).toMatchObject({
    status: "partial",
    partial: { failed: 1, failures: [{ id: "50", stage: "download", attachment: 2, errorCode: "rate_limited" }] },
  })
  expect(everythingUnder(runsDir)).not.toContain(BODY)
})
