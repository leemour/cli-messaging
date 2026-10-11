import { mkdtempSync, readdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CliError, captureStreams } from "@wirecat/cli-core"
import { Command, Option } from "commander"
import { afterEach, describe, expect, it, vi } from "vitest"
import { baseContext, environmentOf } from "./context.js"
import { createProgram, type ProgramDefinition, run } from "./program.js"
import { startRecording } from "./runs/recording.js"
import { listRuns } from "./runs/run.js"
import { settingsFor } from "./settings.js"

const app = { command: "app", appName: "app-cli", envPrefix: "APP", description: "A test CLI", version: "1.2.3" }
const { resolveSettings } = settingsFor(app)

/** An error as another copy of cli-core builds it: the same name and code, a different class. */
const foreignFailure = (code: string, message: string) =>
  Object.assign(new Error(message), { name: "CliError", code, details: { candidates: [{ id: "1" }] } })

const definition = (action: (command: Command) => Promise<void>) => ({
  app,
  commands: () => [
    new Command("chats").addCommand(
      new Command("list").action(async function (this: Command) {
        await action(this)
      }),
    ),
  ],
})

const call = async (argv: string[], action: (command: Command) => Promise<void> = async () => {}) => {
  const streams = captureStreams()
  const code = await run(argv, definition(action), { streams, tty: false, env: process.env })
  return { code, stdout: streams.stdout, stderr: streams.stderr }
}

describe("running a messenger CLI", () => {
  it("**knows a CliError built by another copy of cli-core**, and keeps its code and details", async () => {
    const { code, stdout, stderr } = await call(["chats", "list"], async () => {
      throw foreignFailure("validation_error", '"Va" matches 2 chats')
    })

    expect(code).toBe(2)
    expect(stdout).toEqual([])
    expect(JSON.parse(stderr[0] ?? "").error).toMatchObject({
      code: "validation_error",
      candidates: [{ id: "1" }],
    })
  })

  it("answers a profile with no command after it with a validation error, not help on stdout", async () => {
    const { code, stdout, stderr } = await call(["personal"])

    expect(code).toBe(2)
    expect(stdout).toEqual([])
    expect(stderr[0]).toContain("read as a profile name")
  })

  it("**shows the help at a terminal when no command is given**, and a validation error to a script", async () => {
    const terminal = captureStreams()
    const code = await run(
      [],
      definition(async () => {}),
      { streams: terminal, tty: true, env: process.env },
    )
    const script = await call([])
    const json = captureStreams()
    await run(
      ["--json"],
      definition(async () => {}),
      { streams: json, tty: true, env: process.env },
    )

    expect(code).toBe(2)
    expect(terminal.stdout).toEqual([])
    expect(terminal.stderr.join("\n")).toContain("Usage:")
    expect(terminal.stderr.join("\n")).not.toContain("(outputHelp)")
    expect(script.code).toBe(2)
    expect(JSON.parse(script.stderr[0] ?? "").error.message).toContain("give a command")
    expect(JSON.parse(json.stderr[0] ?? "").error.message).toContain("give a command")
  })

  it("**shows a group's own help at a terminal** when it is given no subcommand", async () => {
    const terminal = captureStreams()
    const code = await run(
      ["chats"],
      definition(async () => {}),
      { streams: terminal, tty: true, env: process.env },
    )
    const help = terminal.stderr.join("\n")

    expect(code).toBe(2)
    expect(terminal.stdout).toEqual([])
    expect(help).toContain("Usage: app chats")
    expect(help).toMatch(/^\s+list\b/m)
    expect(help).not.toContain("(outputHelp)")
  })

  it("hands the first word to the command as its profile", async () => {
    let profile = ""
    await call(["work", "chats", "list"], async (command) => {
      profile = baseContext(command, resolveSettings).settings.profile
    })
    expect(profile).toBe("work")
  })

  it("writes a subcommand's help to the injected stdout, not the terminal", async () => {
    const { code, stdout } = await call(["chats", "--help"])

    expect(code).toBe(0)
    expect(stdout.join("\n")).toContain("list")
  })

  it("says which word was read as a profile when the command after it is unknown", async () => {
    const { code, stderr } = await call(["chat", "list"])

    expect(code).toBe(2)
    expect(JSON.parse(stderr[0] ?? "").error.message).toContain('"chat" is not a command')
  })

  it("**closes what the command tracked when --timeout expires**, then reports a timeout", async () => {
    let closed = false
    const { code, stderr } = await call(["--timeout", "20ms", "chats", "list"], async (command) => {
      const context = baseContext(command, resolveSettings)
      await context.run(async () => {
        context.track({
          close: async () => {
            closed = true
          },
        })
        await new Promise(() => {})
      })
    })

    expect(closed).toBe(true)
    expect(code).toBe(9)
    expect(JSON.parse(stderr[0] ?? "").error.code).toBe("timeout")
  })
})

describe("the default whole-command deadline", () => {
  const hanging = async (env: NodeJS.ProcessEnv) => {
    let started: () => void = () => {}
    const reached = new Promise<void>((resolve) => {
      started = resolve
    })
    const action = async (command: Command) => {
      await baseContext(command, resolveSettings).run(async () => {
        started()
        await new Promise(() => {})
      })
    }
    const streams = captureStreams()
    const done = run(["chats", "list"], definition(action), { streams, tty: false, env })
    await reached
    return { done }
  }

  afterEach(() => vi.useRealTimers())

  it("ends an ordinary command after 30 s, and leaves a background fetch job running", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
    const ordinary = await hanging({ ...process.env })
    await vi.advanceTimersByTimeAsync(31_000)
    vi.useRealTimers()
    expect(await ordinary.done).toBe(9)

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
    const job = await hanging({ ...process.env, APP_BACKFILL_JOB: "20261011T000000-abcdef" })
    await vi.advanceTimersByTimeAsync(31_000)
    vi.useRealTimers()
    // A command the deadline ended settles within milliseconds of real time; give it far longer.
    const outcome = await Promise.race([
      job.done.then(() => "ended"),
      new Promise((resolve) => setTimeout(() => resolve("running"), 1_000)),
    ])
    expect(outcome).toBe("running")
  })
})

describe("consumer lifecycle in the shared shell", () => {
  const execute = async (argv: string[], overrides: Partial<ProgramDefinition>) => {
    const streams = captureStreams()
    const code = await run(
      argv,
      { ...definition(async () => {}), ...overrides },
      {
        streams,
        tty: false,
        env: process.env,
      },
    )
    return { code, stdout: streams.stdout, stderr: streams.stderr }
  }

  it("configures local root options and preserves injected help for added commands", () => {
    const output: string[] = []
    const program = createProgram(
      {
        ...definition(async () => {}),
        configure: (root) => {
          root.option("--serve", "start the connection server")
          root.addCommand(new Command("local").description("a local command"))
        },
      },
      { out: (line) => output.push(line) },
    )
    program.commands.find((command) => command.name() === "local")?.outputHelp()
    expect(output.join("\n")).toContain("a local command")
    expect(program.options.some((option) => option.long === "--serve")).toBe(true)
  })

  it("prepares legacy context with the shared streams before a profile's action", async () => {
    const contexts = new WeakMap<Command, unknown>()
    let root: Command | undefined
    const result = await execute(["work", "chats", "list", "--serve"], {
      configure: (program) => {
        program.option("--serve", "start the connection server")
      },
      prepare: async (program, environment) => {
        await Promise.resolve()
        root = program
        contexts.set(program, environment)
      },
      commands: () => [
        new Command("chats").addCommand(
          new Command("list").action(function (this: Command) {
            if (!root) throw new Error("context was not prepared")
            expect(contexts.get(root)).toBe(environmentOf(this))
            expect(this.optsWithGlobals()).toMatchObject({ profile: "work", serve: true })
            environmentOf(this).streams?.data('{"ok":true}')
          }),
        ),
      ],
    })
    expect(result).toMatchObject({ code: 0, stdout: ['{"ok":true}'], stderr: [] })
  })

  it.each(["--help", "--version"])("does not settle a failure for %s", async (flag) => {
    const onFailure = vi.fn()
    const prepare = vi.fn()
    const result = await execute([flag], { onFailure, prepare })
    expect(result.code).toBe(0)
    expect(result.stdout.length).toBeGreaterThan(0)
    expect(onFailure).not.toHaveBeenCalled()
    expect(prepare).not.toHaveBeenCalled()
  })

  it("reports a preparation failure without executing the command", async () => {
    const action = vi.fn()
    const onFailure = vi.fn()
    const error = new CliError("permission_error", "synthetic refusal")
    const result = await execute(["chats", "list", "--no-record"], {
      ...definition(action),
      prepare: () => {
        throw error
      },
      onFailure,
    })
    expect(result.stdout).toEqual([])
    expect(JSON.parse(result.stderr[0] ?? "").error.code).toBe("permission_error")
    expect(action).not.toHaveBeenCalled()
    expect(onFailure).toHaveBeenCalledWith(error, expect.any(Command))
  })

  it("awaits consumer settlement and does not create a second fallback run", async () => {
    const state = mkdtempSync(join(tmpdir(), "shell-settlement-"))
    const env = { ...process.env, APP_STATE_DIR: state }
    const streams = captureStreams()
    const error = new CliError("validation_error", "synthetic command failure")
    let finished = false
    const code = await run(
      ["chats", "list"],
      {
        ...definition(async () => {
          throw error
        }),
        onFailure: async (failure) => {
          await startRecording({
            app,
            command: "chats list",
            profile: "default",
            record: true,
            keepFailed: true,
            trace: false,
            format: "json",
            streams,
            env,
          }).fail(failure)
          finished = true
        },
      },
      { streams, env, tty: false },
    )
    expect(code).toBe(2)
    expect(finished).toBe(true)
    expect(readdirSync(join(state, "runs"))).toHaveLength(1)
    expect(streams.stdout).toEqual([])
    expect(JSON.parse(streams.stderr[0] ?? "").error.code).toBe("validation_error")
  })

  it("preserves the original failure when settlement throws, without exposing handler text", async () => {
    const result = await execute(["chats", "list", "--no-record"], {
      ...definition(async () => {
        throw new CliError("not_found", "synthetic missing item")
      }),
      onFailure: async () => {
        throw new Error("synthetic private handler content")
      },
    })
    expect(result.code).toBe(6)
    expect(result.stdout).toEqual([])
    expect(result.stderr).toHaveLength(1)
    expect(JSON.parse(result.stderr[0] ?? "").error).toMatchObject({ code: "not_found", settlementFailed: true })
    expect(result.stderr.join("\n")).not.toContain("private handler content")
  })

  it("settles a missing-command failure without preparing resources", async () => {
    const prepare = vi.fn()
    const onFailure = vi.fn()
    const result = await execute(["work"], { prepare, onFailure })
    expect(result.code).toBe(2)
    expect(result.stdout).toEqual([])
    expect(prepare).not.toHaveBeenCalled()
    expect(onFailure).toHaveBeenCalledOnce()
  })
})

describe.each(["max", "tg"])("shared shell contract for %s", (name) => {
  it("uses identical machine output and failure codes with a provider definition", async () => {
    const streams = captureStreams()
    const provider: ProgramDefinition = {
      app: { ...app, command: name },
      commands: () => [
        new Command("messages").addCommand(
          new Command("list").action(function (this: Command) {
            const environment = environmentOf(this)
            if (this.optsWithGlobals().offline) throw new CliError("not_found", "nothing recorded")
            environment.streams?.data('{"items":[],"hasMore":false}')
          }),
        ),
      ],
    }
    const options = { streams, tty: false, env: process.env }
    expect(await run(["messages", "list", "--json", "--no-record"], provider, options)).toBe(0)
    expect(streams.stdout).toEqual(['{"items":[],"hasMore":false}'])
    expect(streams.stderr).toEqual([])
    streams.stdout.length = 0
    expect(await run(["messages", "list", "--offline", "--no-record"], provider, options)).toBe(6)
    expect(streams.stdout).toEqual([])
    expect(JSON.parse(streams.stderr[0] ?? "")).toMatchObject({
      error: { code: "not_found", message: "nothing recorded", retryable: false, actions: expect.any(Array) },
    })
  })
})

describe("the runner's configuration seam", () => {
  it.each(["bot", "chats"])(
    "keeps early %s failures with the matching scope and configured profile",
    async (resource) => {
      const state = mkdtempSync(join(tmpdir(), "shell-scope-"))
      const env = { ...process.env, APP_STATE_DIR: state }
      const streams = captureStreams()
      const scopes: unknown[] = []
      const provider: ProgramDefinition = {
        app,
        configuration: {
          resolveSettings: (_flags, options) => {
            scopes.push(options?.kind)
            return {
              profile: "configured",
              keepFailedRuns: options?.kind === "bot",
              keepRunsForDays: 7,
              skillHint: false,
            }
          },
        },
        commands: () => [
          new Command(resource).addCommand(
            new Command("show").action(() => {
              throw new CliError("validation_error", "synthetic early failure")
            }),
          ),
        ],
      }
      const code = await run(["--timeout", "1s", "--quiet", resource, "show"], provider, { env, streams, tty: false })
      expect(code).toBe(2)
      expect(scopes).toEqual([resource === "bot" ? "bot" : "personal"])
      const runs = listRuns(join(state, "runs"))
      expect(runs).toHaveLength(resource === "bot" ? 1 : 0)
      if (resource === "bot")
        expect(runs[0]).toMatchObject({ profile: "configured", command: "bot show", errorCode: "validation_error" })
      expect(streams.stdout).toEqual([])
      expect(JSON.parse(streams.stderr[0] ?? "").error.code).toBe("validation_error")
    },
  )
})

it("does not blame a profile when a known resource has an unknown subcommand", async () => {
  const result = await call(["work", "chats", "missing"])
  expect(result.code).toBe(2)
  expect(result.stderr.join("\n")).toContain("unknown command 'missing'")
  expect(result.stderr.join("\n")).not.toContain("read as a profile name")
})

describe("machine failures", () => {
  const cases = [
    ["unknown root", ["missing", "operation"]],
    ["unknown child", ["items", "missing"]],
    ["unknown option", ["items", "show", "synthetic", "--missing"]],
    ["missing operand", ["items", "show"]],
    ["missing option value", ["items", "show", "synthetic", "--mode"]],
    ["invalid choice", ["items", "show", "synthetic", "--mode", "missing"]],
    ["missing command", []],
  ] as const

  it.each(cases)("returns one JSON validation failure for %s without running the action", async (_, words) => {
    for (const tty of [true, false]) {
      for (const format of ["--json", "--jsonl"]) {
        const action = vi.fn()
        const prepare = vi.fn()
        const streams = captureStreams()
        const code = await run(
          [...words, format, "--no-record"],
          {
            app,
            prepare,
            commands: () => [
              new Command("items").addCommand(
                new Command("show")
                  .argument("<name>")
                  .addOption(new Option("--mode <mode>").choices(["compact", "full"]))
                  .action(action),
              ),
            ],
          },
          { streams, tty, env: process.env },
        )
        expect(code).toBe(2)
        expect(streams.stdout).toEqual([])
        expect(streams.stderr).toHaveLength(1)
        expect(JSON.parse(streams.stderr[0] ?? "").error).toMatchObject({ code: "validation_error" })
        expect(action).not.toHaveBeenCalled()
        expect(prepare).not.toHaveBeenCalled()
      }
    }
  })

  it.each(["--json", "--jsonl"])("keeps an explicit %s error structured with a TTY", async (format) => {
    const streams = captureStreams()
    const code = await run(
      ["chats", "list", format, "--no-record"],
      definition(async () => {
        throw new CliError("not_found", "synthetic missing item", { candidates: [{ id: "7" }] })
      }),
      { streams, tty: true, env: process.env },
    )
    expect(code).toBe(6)
    expect(streams.stdout).toEqual([])
    expect(streams.stderr).toHaveLength(1)
    expect(JSON.parse(streams.stderr[0] ?? "").error).toMatchObject({
      code: "not_found",
      candidates: [{ id: "7" }],
    })
  })

  it("does not treat a literal --json after the delimiter as an output flag", async () => {
    const streams = captureStreams()
    const code = await run(
      ["item", "--no-record", "--", "--json"],
      {
        app,
        commands: () => [
          new Command("item").argument("<name>").action(() => {
            throw new CliError("not_found", "synthetic missing item")
          }),
        ],
      },
      { streams, tty: true, env: process.env },
    )
    expect(code).toBe(6)
    expect(streams.stderr).toHaveLength(1)
    expect(streams.stderr[0]).toContain("✗ synthetic missing item")
    expect(streams.stderr[0]).toContain("Check the item ID or path")
  })

  it("uses JSON for a preparation failure before command options have been parsed", async () => {
    const streams = captureStreams()
    const action = vi.fn()
    const code = await run(
      ["chats", "list", "--json", "--no-record"],
      {
        ...definition(action),
        prepare: () => {
          throw new CliError("permission_error", "synthetic refusal")
        },
      },
      { streams, tty: true, env: process.env },
    )
    expect(code).toBe(5)
    expect(streams.stderr).toHaveLength(1)
    expect(JSON.parse(streams.stderr[0] ?? "").error.code).toBe("permission_error")
    expect(action).not.toHaveBeenCalled()
  })
})

it("bounds an unresponsive failure handler while preserving the original error", async () => {
  vi.useFakeTimers()
  const streams = captureStreams()
  try {
    const pending = run(
      ["chats", "list", "--json", "--no-record"],
      {
        ...definition(async () => {
          throw new CliError("not_found", "synthetic failure")
        }),
        onFailure: async () => new Promise(() => {}),
      },
      { streams, tty: false, env: process.env },
    )
    await vi.advanceTimersByTimeAsync(1000)
    expect(await pending).toBe(6)
    expect(JSON.parse(streams.stderr[0] ?? "{}").error).toMatchObject({ code: "not_found", settlementFailed: true })
  } finally {
    vi.useRealTimers()
  }
})
