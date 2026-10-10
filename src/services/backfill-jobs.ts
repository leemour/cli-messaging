import { spawn } from "node:child_process"
import { randomBytes } from "node:crypto"
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs"
import { dirname, join } from "node:path"
import { CliError, resolvePaths, writeSecurely } from "@wirecat/cli-core"
import { carries } from "../background/processes.js"
import type { AppIdentity } from "../cli/app.js"
import { envName } from "../cli/app.js"

export interface Job {
  id: string
  chat: string
  profile: string
  pid: number
  startedAt: string
  /** Absent on a job started before `--limit`. */
  limit?: number
  pageSize?: number
  last?: number
  /** What it was started with, after `<cli>`; absent on a job started before `store jobs retry`. */
  argv?: string[]
  log: string
  progress?: { fetched: number; chatId: string; oldest: number }
  finishedAt?: string
  result?: Record<string, unknown>
  error?: { code: string; message: string }
  cancelRequestedAt?: string
}

export const JOB_STATES = ["running", "done", "partial", "failed", "cancelled", "died"] as const
export type JobState = (typeof JOB_STATES)[number]

/** Starts `<cli> <argv>` apart from this process, writing to `log`, and answers its PID. Tests hand one in. */
export type SpawnJob = (argv: string[], env: NodeJS.ProcessEnv, log: string) => number

export const spawnDetached: SpawnJob = (argv, env, log) => {
  const out = openSync(log, "a", 0o600)
  try {
    const child = spawn(process.execPath, [realpathSync(process.argv[1] ?? ""), ...argv], {
      detached: true,
      stdio: ["ignore", out, out],
      env,
    })
    child.unref()
    return child.pid ?? 0
  } finally {
    closeSync(out)
  }
}

export const jobsDir = (app: AppIdentity, env: NodeJS.ProcessEnv): string =>
  join(resolvePaths({ appName: app.appName, prefix: app.envPrefix, env }).state, "backfill")

const jobPath = (dir: string, id: string) => join(dir, `${id}.json`)

export const saveJob = (dir: string, job: Job): void => {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  writeSecurely(jobPath(dir, job.id), `${JSON.stringify(job, null, 2)}\n`, 0o600)
}

export const readJob = (dir: string, id: string): Job | undefined => {
  if (!/^[\w-]+$/.test(id) || !existsSync(jobPath(dir, id))) return undefined
  try {
    return JSON.parse(readFileSync(jobPath(dir, id), "utf8")) as Job
  } catch {
    return undefined
  }
}

export const updateJob = (dir: string, id: string, change: Partial<Job>): void => {
  const job = readJob(dir, id)
  if (job) saveJob(dir, { ...job, ...change })
}

/** The job's record and its log. */
export const removeJob = (dir: string, job: Job): void => {
  rmSync(jobPath(dir, job.id), { force: true })
  // The record says where its log is; only a log beside it is removed.
  if (dirname(job.log) === dir) rmSync(job.log, { force: true })
}

/** Newest first. */
export const listJobs = (dir: string): Job[] =>
  existsSync(dir)
    ? readdirSync(dir)
        .filter((name) => name.endsWith(".json"))
        .flatMap((name) => readJob(dir, name.slice(0, -".json".length)) ?? [])
        .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    : []

/** A job that is gone without saying how it ended was killed, or crashed before it could — its log says which. */
export const stateOf = (job: Job): JobState => {
  if (job.finishedAt !== undefined) {
    if (job.cancelRequestedAt) return "cancelled"
    return job.error ? "failed" : job.result?.batch || job.result?.issue ? "partial" : "done"
  }
  if (isJob(job)) return "running"
  return job.cancelRequestedAt ? "cancelled" : "died"
}

/** Whether the recorded PID is still this job — its environment names it (`<PREFIX>_BACKFILL_JOB`). */
export const isJob = (job: Job): boolean => carries(job.pid, `_BACKFILL_JOB=${job.id}`)

export const startArchiveJob = (
  app: AppIdentity,
  env: NodeJS.ProcessEnv,
  profile: string,
  input: { chat: string; argv: string[]; limit: number; pageSize: number },
  spawnJob: SpawnJob = spawnDetached,
) => {
  const dir = jobsDir(app, env)
  const running = listJobs(dir).find(
    (job) => job.profile === profile && job.chat === input.chat && stateOf(job) === "running",
  )
  if (running)
    throw new CliError(
      "validation_error",
      `job ${running.id} already works on this chat; inspect store jobs show first`,
    )
  const startedAt = new Date().toISOString()
  const id = `${startedAt.replace(/[-:]/g, "").slice(0, 15)}-${randomBytes(3).toString("hex")}`
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const log = join(dir, `${id}.log`)
  const job: Job = {
    id,
    chat: input.chat,
    profile,
    pid: 0,
    startedAt,
    limit: input.limit,
    pageSize: input.pageSize,
    argv: input.argv,
    log,
  }
  saveJob(dir, job)
  const { [envName(app, "TIMEOUT")]: _timeout, ...inherited } = env
  const childEnv = { ...inherited, [envName(app, "PROFILE")]: profile, [envName(app, "BACKFILL_JOB")]: id }
  const pid = spawnJob(input.argv, childEnv, log)
  saveJob(dir, { ...job, pid })
  return { job: id, pid, chat: input.chat, log }
}
