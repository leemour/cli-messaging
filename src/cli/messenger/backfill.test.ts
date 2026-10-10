import { type ChildProcess, spawn } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { CliError, captureStreams } from "@wirecat/cli-core"
import { describe, expect, it, onTestFinished } from "vitest"
import type { Message } from "../../domain/models.js"
import { run } from "../program.js"
import { settingsFor } from "../settings.js"
import { storeCommand } from "./archive-commands.js"
import { jobsDir, listJobs, readJob, type SpawnJob, saveJob, updateJob } from "./backfill-jobs.js"
import type { Fetching, Messenger } from "./context.js"
import type { MessengerAdapter, ServerReads } from "./port.js"

const app = { command: "chat", appName: "chat-cli", envPrefix: "CHAT", description: "A test", version: "1.0.0" }

const message = (id: number): Message => ({
  id: String(id),
  chatId: "7",
  senderId: "9",
  senderName: "Olga",
  timestamp: new Date(Date.UTC(2026, 0, 1) + id * 60_000).toISOString(),
  editedAt: null,
  text: `message ${id}`,
  outgoing: false,
  attachments: [],
  replyTo: null,
  forwardedFrom: null,
  reactions: null,
})

/** A chat whose messages are 1..newest; `wait` makes the first request refuse with a FloodWait. */
const chatOf = (state: {
  newest: number
  asked: (string | undefined)[]
  wait?: number
}): MessengerAdapter & ServerReads =>
  ({
    self: () => "500",
    close: async () => {},
    history: async (_chat: string, { limit, before }: { limit: number; before?: string }) => {
      state.asked.push(before)
      if (state.wait !== undefined) {
        const retryAfterMs = state.wait
        delete state.wait
        throw new CliError("rate_limited", "wait", { retryAfterMs })
      }
      const upper = before === undefined ? state.newest : Number(before) - 1
      const low = Math.max(1, upper - limit + 1)
      const items = upper < 1 ? [] : Array.from({ length: upper - low + 1 }, (_, index) => message(low + index))
      return { items, hasMore: low > 1 }
    },
  }) as unknown as MessengerAdapter & ServerReads

const setup = () => {
  const root = mkdtempSync(join(tmpdir(), "backfill-"))
  return { CHAT_STATE_DIR: join(root, "state"), MESSAGING_STORE: join(root, "m.db") }
}

const call = async (
  argv: string[],
  connection: MessengerAdapter,
  env: NodeJS.ProcessEnv,
  { fetching, ...extra }: { spawnJob?: SpawnJob; signal?: AbortSignal; fetching?: Fetching } = {},
) => {
  const messenger: Messenger = {
    app,
    provider: "chat",
    resolveSettings: settingsFor(app).resolveSettings,
    connect: async () => connection,
    chatArgument: "a chat",
    ...(fetching ? { fetching } : {}),
  }
  const streams = captureStreams()
  const code = await run(
    argv,
    { app, commands: () => [storeCommand(messenger)] },
    {
      streams,
      tty: false,
      env,
      ...extra,
    },
  )
  return {
    code,
    answer: streams.stdout[0] ? JSON.parse(streams.stdout[0]) : undefined,
    stdout: streams.stdout,
    stderr: streams.stderr.join("\n"),
  }
}

/** As MAX pages: ids past 2^53, and `before` a time that the page includes. */
const timedChatOf = (
  count: number,
  asked: { before?: string; reactions?: false }[],
  idOf = (index: number) => String(116762160362694500n + BigInt(index)),
  timeOf = (index: number) => message(index + 1).timestamp,
): MessengerAdapter =>
  ({
    self: () => "500",
    close: async () => {},
    history: async (_chat: string, window: { limit: number; before?: string; reactions?: false }) => {
      asked.push({
        ...(window.before ? { before: window.before } : {}),
        ...(window.reactions === false ? { reactions: false } : {}),
      })
      const all = Array.from({ length: count }, (_, index) => ({
        ...message(index + 1),
        id: idOf(index),
        timestamp: timeOf(index),
      }))
      const upTo = window.before === undefined ? all : all.filter((one) => one.timestamp < String(window.before))
      const items = upTo.slice(-window.limit)
      return { items, hasMore: items.length >= window.limit }
    },
  }) as unknown as MessengerAdapter

describe("store fetch", () => {
  it("**fetches by send time where ids pass 2^53**, at the messenger's own page and pause, without reactions", async () => {
    const env = setup()
    const asked: { before?: string; reactions?: false }[] = []
    const fetching: Fetching = { page: 3, pause: "1ms", maxPages: 10, orderBy: "time" }

    const { code, answer } = await call(["store", "fetch", "7", "--json"], timedChatOf(7, asked), env, { fetching })

    expect(code).toBe(0)
    expect(answer).toMatchObject({ complete: true })
    expect(asked.every((one) => one.reactions === false)).toBe(true)
    expect(asked[1]?.before).toBe(new Date(Date.parse(message(5).timestamp) + 1).toISOString())
    const estimate = await call(["store", "fetch", "7", "--estimate", "--json"], timedChatOf(7, []), env, { fetching })
    expect(estimate.code).toBe(2)
  })

  it("**keeps both of two messages sent in one millisecond when a page ends between them**", async () => {
    const fetching: Fetching = { page: 3, pause: "1ms", maxPages: 10, orderBy: "time" }
    const sameMoment = (index: number) => message(index === 3 ? 5 : index + 1).timestamp

    const { code, answer } = await call(
      ["store", "fetch", "7", "--json"],
      timedChatOf(7, [], undefined, sameMoment),
      setup(),
      { fetching },
    )

    expect(code).toBe(0)
    expect(answer).toMatchObject({ fetched: 7, complete: true })
  })

  it("**ends when the messenger keeps giving back the same page**, by id or by time, rather than run for ever", async () => {
    for (const orderBy of ["id", "time"] as const) {
      const asked: unknown[] = []
      const fetching: Fetching = { page: 3, pause: "1ms", maxPages: 10, orderBy }
      const sameEveryTime = {
        ...timedChatOf(7, [], undefined),
        history: async (_chat: string, window: unknown) => {
          asked.push(window)
          return { items: [message(1), message(2), message(3)], hasMore: true }
        },
      }

      const { code, answer } = await call(["store", "fetch", "7", "--json"], sameEveryTime, setup(), { fetching })

      expect(code).toBe(0)
      expect(answer).toMatchObject({ fetched: 3 })
      expect(asked.length).toBeLessThanOrEqual(orderBy === "id" ? 2 : 3)
    }
  })

  it("**steps past a millisecond that holds more than a page** instead of asking for it again", async () => {
    const asked: { before?: string; reactions?: false }[] = []
    const fetching: Fetching = { page: 3, pause: "1ms", maxPages: 10, orderBy: "time" }
    const crowded = (index: number) => message(index < 5 ? 5 : index + 1).timestamp

    const { code } = await call(["store", "fetch", "7", "--json"], timedChatOf(7, asked, undefined, crowded), setup(), {
      fetching,
    })

    expect(code).toBe(0)
    expect(asked.length).toBeLessThan(6)
  })

  it("fetches by send time a chat whose ids are words", async () => {
    const fetching: Fetching = { page: 3, pause: "1ms", maxPages: 10, orderBy: "time" }
    const words = timedChatOf(7, [], (index) => `msg-${index}`)

    const { code, answer } = await call(["store", "fetch", "7", "--json"], words, setup(), { fetching })

    expect(code).toBe(0)
    expect(answer).toMatchObject({
      complete: true,
      ranges: [{ from: Date.parse(message(1).timestamp), to: Date.parse(message(7).timestamp) }],
    })
  })

  it("**stops at --limit keeping what it read, and the next run fetches only what is missing**", async () => {
    const env = setup()
    const state = { newest: 250, asked: [] as (string | undefined)[] }

    const first = await call(["store", "fetch", "7", "--limit", "200", "--pause", "1ms", "--json"], chatOf(state), env)
    expect(first.answer).toEqual({ chat: "7", fetched: 200, complete: false, ranges: [{ from: 51, to: 250 }] })

    state.newest = 260
    state.asked = []
    const second = await call(["store", "fetch", "7", "--pause", "1ms", "--json"], chatOf(state), env)
    expect(second.answer).toEqual({ chat: "7", fetched: 150, complete: true, ranges: [{ from: 1, to: 260 }] })
    // The newest page, then straight past the 51..250 already held.
    expect(state.asked).toEqual([undefined, "51"])
  })

  it("**--page-size sets each request and --limit stops at that many messages**, the last request asking for the rest", async () => {
    const state = { newest: 250, asked: [] as (string | undefined)[] }

    const { answer } = await call(
      ["store", "fetch", "7", "--limit", "120", "--page-size", "50", "--pause", "1ms", "--json"],
      chatOf(state),
      setup(),
    )

    expect(answer).toMatchObject({ fetched: 120, complete: false, ranges: [{ from: 131, to: 250 }] })
    expect(state.asked).toHaveLength(3)
  })

  it("**refuses a --page-size above what the messenger returns**, and allows it where no cap is known", async () => {
    const state = { newest: 250, asked: [] as (string | undefined)[] }

    const refused = await call(["store", "fetch", "7", "--page-size", "200", "--json"], chatOf(state), setup())
    const uncapped = await call(
      ["store", "fetch", "7", "--page-size", "200", "--pause", "1ms", "--json"],
      chatOf(state),
      setup(),
      { fetching: { page: 30, pause: "1ms", maxPages: 10 } },
    )

    expect(refused.code).toBe(2)
    expect(refused.stderr).toMatch(/--page-size takes at most 100/)
    expect(uncapped.answer).toMatchObject({ complete: true, ranges: [{ from: 1, to: 250 }] })
  })

  it("**a fetch after a wrong start mark reads below it**, and the chat stops reading as complete", async () => {
    const env = setup()
    const state = { newest: 250, asked: [] as (string | undefined)[] }
    const cutShort = {
      ...chatOf(state),
      history: async (chat: string, window: { limit: number; before?: string }) => ({
        ...(await chatOf(state).history(chat, window)),
        hasMore: false,
      }),
    } as MessengerAdapter
    const wrong = await call(["store", "fetch", "7", "--pause", "1ms", "--json"], cutShort, env)
    expect(wrong.answer).toMatchObject({ complete: true, ranges: [{ from: 151, to: 250 }] })

    state.asked = []
    const again = await call(["store", "fetch", "7", "--limit", "200", "--pause", "1ms", "--json"], chatOf(state), env)
    expect(state.asked).toEqual([undefined, "151"])
    expect(again.answer).toMatchObject({ complete: false, ranges: [{ from: 51, to: 250 }] })
  })

  it("**--last stops once the newest n messages are held**, and refuses --since-time beside it", async () => {
    const env = setup()
    const state = { newest: 250, asked: [] as (string | undefined)[] }

    const { answer } = await call(
      ["store", "fetch", "7", "--last", "120", "--pause", "1ms", "--json"],
      chatOf(state),
      env,
    )
    const both = await call(["store", "fetch", "7", "--last", "5", "--since-time", "1d", "--json"], chatOf(state), env)

    expect(answer).toMatchObject({ fetched: 200, complete: false, reachedLast: true, ranges: [{ from: 51, to: 250 }] })
    expect(both.code).toBe(2)
  })

  it("sits out a short wait the provider asks for", async () => {
    const state = { newest: 30, asked: [] as (string | undefined)[], wait: 5 }
    const { code, answer } = await call(["store", "fetch", "7", "--pause", "1ms", "--json"], chatOf(state), setup())

    expect(code).toBe(0)
    expect(answer).toMatchObject({ fetched: 30, complete: true })
  })

  it("stops at a long wait with what it had read kept", async () => {
    const env = setup()
    const state = { newest: 250, asked: [] as (string | undefined)[] }
    await call(["store", "fetch", "7", "--limit", "100", "--pause", "1ms"], chatOf(state), env)

    const refused = await call(["store", "fetch", "7", "--pause", "1ms"], chatOf({ ...state, wait: 10 * 60_000 }), env)
    expect(refused.code).toBe(0)
    const asked = state.asked.length
    const remembered = await call(["store", "fetch", "7", "--pause", "1ms"], chatOf(state), env)
    expect(remembered.code).toBe(0)
    expect(state.asked).toHaveLength(asked)

    rmSync(join(env.CHAT_STATE_DIR, "flood"), { recursive: true })
    rmSync(join(env.CHAT_STATE_DIR, "pace"), { recursive: true })
    const resumed = await call(["store", "fetch", "7", "--pause", "1ms", "--json"], chatOf(state), env)
    expect(resumed.answer).toMatchObject({ complete: true, ranges: [{ from: 1, to: 250 }] })
  })

  it("**--since-time stops after the page that reaches an older message**", async () => {
    const state = { newest: 250, asked: [] as (string | undefined)[] }
    const since = new Date(Date.UTC(2026, 0, 1) + 180 * 60_000).toISOString()
    const { answer } = await call(
      ["store", "fetch", "7", "--since-time", since, "--pause", "1ms", "--json"],
      chatOf(state),
      setup(),
    )

    expect(answer).toEqual({
      chat: "7",
      fetched: 100,
      complete: false,
      reachedSince: true,
      ranges: [{ from: 151, to: 250 }],
    })
    expect(state.asked).toEqual([undefined])
    expect((await call(["store", "fetch", "7", "--since-time", "7"], chatOf(state), setup())).code).not.toBe(0)
    expect(
      (await call(["store", "fetch", "7", "--since-time", since, "--estimate"], chatOf(state), setup())).code,
    ).not.toBe(0)
  })

  it("keeps no old name: backfill and --pace are unknown", async () => {
    const state = { newest: 5, asked: [] as (string | undefined)[] }
    expect((await call(["backfill", "7"], chatOf(state), setup())).code).not.toBe(0)
    expect((await call(["store", "fetch", "7", "--pace", "1ms"], chatOf(state), setup())).code).not.toBe(0)
    expect(state.asked).toEqual([])
  })
})

describe("store fetch in the background", () => {
  const spawned = (pid: number) => {
    const calls: { argv: string[]; env: NodeJS.ProcessEnv; log: string }[] = []
    const spawnJob: SpawnJob = (argv, env, log) => {
      calls.push({ argv, env, log })
      return pid
    }
    return { calls, spawnJob }
  }
  const idle = chatOf({ newest: 0, asked: [] })
  /** A real process with the environment the job would get, standing in for the CLI it would run. */
  const sleeping = () => {
    const children: ChildProcess[] = []
    const calls: { argv: string[]; env: NodeJS.ProcessEnv }[] = []
    const spawnJob: SpawnJob = (argv, env) => {
      calls.push({ argv, env })
      const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { env })
      children.push(child)
      return child.pid ?? 0
    }
    const exited = () => new Promise((resolve) => children[0]?.on("exit", (_code, signal) => resolve(signal)))
    return {
      calls,
      spawnJob,
      children,
      exited,
      stop: () => {
        for (const child of children) child.kill()
      },
    }
  }

  it("**--all** fetches every chat in a job, the last 90 days unless told, and needs a chat or --all", async () => {
    const env = setup()
    const { calls, spawnJob } = spawned(4242)

    const started = await call(["store", "fetch", "--all", "--pause", "1ms", "--background", "--json"], idle, env, {
      spawnJob,
    })
    const neither = await call(["store", "fetch", "--json"], idle, env)
    const both = await call(["store", "fetch", "7", "--all", "--json"], idle, env)

    expect(started.answer).toMatchObject({ pid: 4242, chat: "--all" })
    expect(calls[0]?.argv.slice(0, 3)).toEqual(["store", "fetch", "--all"])
    const since = calls[0]?.argv[calls[0].argv.indexOf("--since-time") + 1] ?? ""
    expect(Date.now() - Date.parse(since)).toBeGreaterThan(89 * 86_400_000)
    expect(Date.now() - Date.parse(since)).toBeLessThan(91 * 86_400_000)
    expect([neither.code, both.code]).toEqual([2, 2])
    expect(neither.stderr).toContain("name a chat, or --all for every chat")
  })

  it("**starts a job that runs the same fetch apart, pinned to the profile, with no shell timeout**", async () => {
    const env = { ...setup(), CHAT_TIMEOUT: "30s" }
    const { calls, spawnJob, children, stop } = sleeping()
    onTestFinished(stop)

    const started = await call(
      ["store", "fetch", "7", "--limit", "300", "--last", "250", "--pause", "1ms", "--background", "--json"],
      idle,
      env,
      {
        spawnJob,
      },
    )

    expect(started.answer).toMatchObject({ pid: children[0]?.pid, chat: "7" })
    const job = started.answer.job as string
    expect(calls).toHaveLength(1)
    expect(calls[0]?.argv).toEqual([
      "store",
      "fetch",
      "7",
      "--limit",
      "300",
      "--page-size",
      "100",
      "--pause",
      "1ms",
      "--last",
      "250",
      "--no-catch-up",
      "--json",
    ])
    expect(calls[0]?.env).toMatchObject({ CHAT_PROFILE: "default", CHAT_BACKFILL_JOB: job })
    expect(calls[0]?.env.CHAT_TIMEOUT).toBeUndefined()
    expect((await call(["store", "jobs", "list", "--json"], idle, env)).answer).toEqual({
      items: [expect.objectContaining({ job, state: "running", fetched: 0, limit: 300, pageSize: 100, last: 250 })],
      page: 1,
      limit: 1,
      hasMore: false,
    })

    const again = await call(["store", "fetch", "7", "--background"], idle, env, { spawnJob })
    expect(again.code).not.toBe(0)
    expect(again.stderr).toContain(`job ${job} is already fetching 7`)
  })

  it("the job's own run records its progress and outcome, and status adds what the store holds", async () => {
    const env = setup()
    const { calls, spawnJob } = spawned(process.pid)
    const { job } = (await call(["store", "fetch", "7", "--background", "--json"], idle, env, { spawnJob })).answer

    const state = { newest: 150, asked: [] as (string | undefined)[] }
    const child = await call(calls[0]?.argv ?? [], chatOf(state), { ...env, ...calls[0]?.env })
    expect(child.code).toBe(0)

    expect((await call(["store", "jobs", "show", "--json"], idle, env)).answer).toMatchObject({
      job,
      state: "done",
      fetched: 150,
      complete: true,
      held: [{ from: 1, to: 150 }],
    })
  })

  it("a job that fails says how; one that vanished without a word has died", async () => {
    const env = setup()
    const { calls, spawnJob } = spawned(process.pid)
    const { job } = (await call(["store", "fetch", "7", "--background", "--json"], idle, env, { spawnJob })).answer
    const wait = { newest: 10, asked: [] as (string | undefined)[], wait: 10 * 60_000 }
    await call(calls[0]?.argv ?? [], chatOf(wait), { ...env, ...calls[0]?.env })

    expect((await call(["store", "jobs", "show", job, "--json"], idle, env)).answer).toMatchObject({
      state: "partial",
      issue: { code: "rate_limited", retryAfterMs: 600000, actions: expect.any(Array) },
    })

    const gone = spawned(2 ** 22 + 12345)
    const other = (await call(["store", "fetch", "8", "--background", "--json"], idle, env, gone)).answer
    expect((await call(["store", "jobs", "show", other.job, "--json"], idle, env)).answer).toMatchObject({
      state: "died",
    })
    const refused = await call(["store", "jobs", "cancel", other.job], idle, env)
    expect(refused.code).not.toBe(0)
    expect(refused.stderr).toContain("is not running — it is died")
  })

  it("cancel sends the job SIGTERM", async () => {
    const env = setup()
    const { spawnJob, exited, stop } = sleeping()
    onTestFinished(stop)
    const { job } = (await call(["store", "fetch", "7", "--background", "--json"], idle, env, { spawnJob })).answer

    const signal = exited()
    expect((await call(["store", "jobs", "cancel", job, "--json"], idle, env)).answer).toEqual({ job, cancelled: true })
    expect(await signal).toBe("SIGTERM")
    expect((await call(["store", "jobs", "show", job, "--json"], idle, env)).answer).toMatchObject({
      state: "cancelled",
    })
  })

  it("**retry starts a failed or died job again with the same command**, as a new job", async () => {
    const env = setup()
    const dead = spawned(2 ** 22 + 12345)
    const fetch = ["store", "fetch", "7", "--limit", "30", "--page-size", "10", "--pause", "1ms"]
    const first = (await call([...fetch, "--since-time", "2026-01-01", "--background", "--json"], idle, env, dead))
      .answer.job as string

    const retried = await call(["store", "jobs", "retry", first, "--json"], idle, env, dead)

    expect(retried.answer).toMatchObject({ retried: first, chat: "7", pid: 2 ** 22 + 12345 })
    expect(dead.calls[1]?.argv).toEqual(dead.calls[0]?.argv)
    expect(dead.calls[1]?.env.CHAT_BACKFILL_JOB).toBe(retried.answer.job)
    expect(retried.answer.job).not.toBe(first)

    updateJob(jobsDir(app, env), retried.answer.job, { finishedAt: new Date().toISOString(), result: { fetched: 5 } })
    const done = await call(["store", "jobs", "retry", retried.answer.job], idle, env, dead)
    expect(done.stderr).toContain("did not fail — it is done")
    expect((await call(["store", "jobs", "retry"], idle, env, dead)).stderr).toContain("name a job, or --failed")
  })

  it("retry rebuilds the command of a job recorded before jobs kept theirs", async () => {
    const env = setup()
    const dead = spawned(2 ** 22 + 12345)
    const dir = jobsDir(app, env)
    saveJob(dir, {
      id: "20260101T000000-aaaaaa",
      chat: "7",
      profile: "default",
      pid: 2 ** 22 + 12345,
      startedAt: "2026-01-01T00:00:00.000Z",
      limit: 40,
      pageSize: 20,
      last: 3,
      log: join(dir, "20260101T000000-aaaaaa.log"),
    })

    expect((await call(["store", "jobs", "retry", "20260101T000000-aaaaaa"], idle, env, dead)).code).toBe(0)
    expect(dead.calls[0]?.argv).toEqual([
      "store",
      "fetch",
      "7",
      "--limit",
      "40",
      "--page-size",
      "20",
      "--pause",
      expect.any(String),
      "--last",
      "3",
      "--json",
    ])
  })

  it("**retry --failed** retries each chat whose newest job failed or died, once", async () => {
    const env = setup()
    const dead = spawned(2 ** 22 + 12345)
    const dir = jobsDir(app, env)
    const start = async (chat: string, at: string) => {
      const { job } = (await call(["store", "fetch", chat, "--background", "--json"], idle, env, dead)).answer
      updateJob(dir, job, { startedAt: at })
      return job as string
    }
    await start("8", "2026-01-01T00:00:00.000Z")
    const newest8 = await start("8", "2026-01-02T00:00:00.000Z")
    await start("9", "2026-01-01T00:00:00.000Z")
    const done9 = await start("9", "2026-01-02T00:00:00.000Z")
    updateJob(dir, done9, { finishedAt: "2026-01-02T01:00:00.000Z", result: { fetched: 1 } })

    const retried = await call(["store", "jobs", "retry", "--failed", "--json"], idle, env, dead)

    expect(retried.answer.items).toEqual([expect.objectContaining({ retried: newest8, chat: "8" })])
    expect(dead.calls).toHaveLength(5)
  })

  it("**list --state** answers only the jobs in that state", async () => {
    const env = setup()
    const dead = spawned(2 ** 22 + 12345)
    const died = (await call(["store", "fetch", "8", "--background", "--json"], idle, env, dead)).answer.job
    const done = (await call(["store", "fetch", "9", "--background", "--json"], idle, env, dead)).answer.job
    updateJob(jobsDir(app, env), done, { finishedAt: new Date().toISOString(), result: { fetched: 1 } })

    const listed = async (state: string) =>
      (await call(["store", "jobs", "list", "--state", state, "--json"], idle, env)).answer.items.map(
        (item: { job: string }) => item.job,
      )

    expect(await listed("died")).toEqual([died])
    expect(await listed("done")).toEqual([done])
    expect(await listed("running")).toEqual([])
    expect((await call(["store", "jobs", "list", "--state", "lost"], idle, env)).code).toBe(2)
  })

  it("**clear** forgets finished jobs and their logs, and keeps a running one", async () => {
    const env = setup()
    const dir = jobsDir(app, env)
    const { spawnJob, stop } = sleeping()
    onTestFinished(stop)
    const running = (await call(["store", "fetch", "7", "--background", "--json"], idle, env, { spawnJob })).answer.job
    const died = (await call(["store", "fetch", "8", "--background", "--json"], idle, env, spawned(2 ** 22 + 12345)))
      .answer.job
    const log = readJob(dir, died)?.log ?? ""
    writeFileSync(log, "a line\n")

    const cleared = await call(["store", "jobs", "clear", "--json"], idle, env)

    expect(cleared.answer).toEqual({ cleared: [died] })
    expect(listJobs(dir).map((job) => job.id)).toEqual([running])
    expect(existsSync(log)).toBe(false)
  })

  it.skipIf(process.platform !== "linux" && process.platform !== "darwin")(
    "**a PID that is alive but no longer the job is not the job** — it is died, and cancel signals nothing",
    async () => {
      const env = setup()
      const stranger = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"])
      onTestFinished(() => {
        stranger.kill()
      })
      const { job } = (
        await call(["store", "fetch", "7", "--background", "--json"], idle, env, spawned(stranger.pid ?? 0))
      ).answer

      expect((await call(["store", "jobs", "show", job, "--json"], idle, env)).answer).toMatchObject({ state: "died" })
      expect((await call(["store", "jobs", "cancel", job], idle, env)).code).not.toBe(0)
      expect(stranger.exitCode).toBeNull()
      expect(stranger.signalCode).toBeNull()
    },
  )

  it("a stop ends the run after the page in hand, with that page kept", async () => {
    const stop = new AbortController()
    const chat = chatOf({ newest: 250, asked: [] })
    const history = chat.history.bind(chat)
    chat.history = async (...args) => {
      stop.abort()
      return history(...args)
    }

    const { answer } = await call(["store", "fetch", "7", "--pause", "1ms", "--json"], chat, setup(), {
      signal: stop.signal,
    })
    expect(answer).toMatchObject({ fetched: 100, stopped: true, ranges: [{ from: 151, to: 250 }] })
  })

  it("status and cancel name a job that does not exist", async () => {
    const env = setup()
    expect((await call(["store", "jobs", "show"], idle, env)).stderr).toContain("no background fetch jobs")
    expect((await call(["store", "jobs", "cancel", "nope"], idle, env)).stderr).toContain("no fetch job nope")
    expect((await call(["store", "jobs", "list", "--json"], idle, env)).answer).toEqual({
      items: [],
      page: 1,
      limit: 0,
      hasMore: false,
    })
  })
})

describe("store fetch --estimate", () => {
  const untouchable = {
    self: () => "500",
    close: async () => {},
    history: async () => {
      throw new Error("an estimate asked the messenger")
    },
  } as unknown as MessengerAdapter

  it("**prices what is not held at the density of what is, and asks the messenger nothing**", async () => {
    const env = setup()
    await call(["store", "fetch", "7", "--limit", "100", "--pause", "1ms"], chatOf({ newest: 250, asked: [] }), env)

    const { code, answer } = await call(
      ["store", "fetch", "7", "--estimate", "--limit", "100", "--json"],
      untouchable,
      env,
    )
    expect(code).toBe(0)
    expect(answer).toEqual({
      chat: "7",
      held: 100,
      ranges: [{ from: 151, to: 250 }],
      missing: 150,
      requests: 3,
      runs: 3,
      seconds: 4,
    })
  })

  it("a chat held from its first message costs nothing more", async () => {
    const env = setup()
    await call(["store", "fetch", "7", "--pause", "1ms"], chatOf({ newest: 50, asked: [] }), env)

    expect((await call(["store", "fetch", "7", "--estimate", "--json"], untouchable, env)).answer).toMatchObject({
      missing: 0,
      requests: 0,
    })
  })

  it("with nothing held it says so rather than guess", async () => {
    const env = setup()
    await call(["store", "fetch", "7", "--pause", "1ms"], chatOf({ newest: 5, asked: [] }), env)

    const { answer, stderr } = await call(["store", "fetch", "8", "--estimate", "--json"], untouchable, env)
    expect(answer).toMatchObject({ held: 0, missing: null, requests: null })
    expect(stderr).toContain("--limit 100")
  })
})

describe("post-fetch catch-up controls", () => {
  it("honors the existing links permission before fetching or queueing preparation", async () => {
    const base = setup()
    const root = dirname(base.MESSAGING_STORE)
    const config = join(root, "config")
    mkdirSync(config)
    writeFileSync(
      join(config, "config.json"),
      JSON.stringify({
        profiles: {
          default: {
            searchCatchUp: true,
            permissions: { "conversations.links": "readonly", "conversations.embed": "allow" },
          },
        },
      }),
    )
    const env = { ...base, CHAT_CONFIG_DIR: config }
    const state = { newest: 2, asked: [] as (string | undefined)[] }
    for (const background of [false, true]) {
      const result = await call(
        ["store", "fetch", "7", "--catch-up", "--json", ...(background ? ["--background"] : [])],
        chatOf(state),
        env,
      )
      expect(result.code).toBe(5)
      expect(state.asked).toEqual([])
    }
    expect(
      (await call(["store", "fetch", "7", "--no-catch-up", "--pause", "1ms", "--json"], chatOf(state), env)).code,
    ).toBe(0)
    expect(state.asked.length).toBeGreaterThan(0)
  })

  it("honours a profile opt-in, explicit opt-out and all preparation budgets", async () => {
    const base = setup()
    const root = dirname(base.MESSAGING_STORE)
    const config = join(root, "config")
    mkdirSync(config)
    writeFileSync(join(config, "config.json"), JSON.stringify({ profiles: { default: { searchCatchUp: true } } }))
    const env = { ...base, CHAT_CONFIG_DIR: config, CLI_COMMON_CACHE_DIR: join(root, "empty-models") }
    const state = { newest: 2, asked: [] as (string | undefined)[] }
    const enabled = await call(["store", "fetch", "7", "--json", "--pause", "1ms"], chatOf(state), env)
    expect(enabled.code).toBe(0)
    expect(enabled.answer.prepared).toMatchObject({ prepared: { modelAvailable: false, built: [{ chat: "7" }] } })
    state.newest = 3
    expect(
      (await call(["store", "fetch", "7", "--no-catch-up", "--json"], chatOf(state), env)).answer,
    ).not.toHaveProperty("prepared")
    const bounded = await call(
      [
        "store",
        "fetch",
        "7",
        "--catch-up",
        "--catch-up-messages",
        "1",
        "--catch-up-chunks",
        "1",
        "--catch-up-time",
        "1s",
        "--json",
      ],
      chatOf(state),
      env,
    )
    expect(bounded.answer).toMatchObject({ prepared: { reason: "message_bound", complete: false } })
    expect(
      (await call(["store", "fetch", "7", "--catch-up", "--catch-up-chunks", "20001", "--json"], chatOf(state), env))
        .code,
    ).toBe(2)
  })
})
