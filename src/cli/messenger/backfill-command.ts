import { randomBytes } from "node:crypto"
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { CliError } from "@wirecat/cli-core"
import { annotate } from "@wirecat/cli-core/commands"
import { Command, Option } from "commander"
import { FETCHING, type Fetched, type FetchedAll } from "../../services/archive.js"
import { momentOf } from "../../services/moment.js"
import { validateCatchUpBounds } from "../../services/search-catchup.js"
import { envName } from "../app.js"
import { type BaseEnvironment, environmentOf } from "../context.js"
import { isCliFailure } from "../failures.js"
import { renderList } from "../paging.js"
import { parseDuration } from "../settings.js"
import {
  JOB_STATES,
  type Job,
  type JobState,
  jobsDir,
  listJobs,
  readJob,
  removeJob,
  type SpawnJob,
  saveJob,
  spawnDetached,
  stateOf,
  updateJob,
} from "./backfill-jobs.js"
import { type Messenger, type MessengerContext, messengerContext, refuseLocalWrite } from "./context.js"
import { stopOnSignal } from "./patience.js"

/**
 * A chat's history into the store, newest to oldest, **resumable**: after every page the stretch it
 * covered is recorded, so a stop — Ctrl-C, `--timeout`, `--limit`, `--since-time`, `--last`, a long FloodWait — loses
 * nothing, and the next run jumps over what is already held. Needs numeric message ids, which order
 * the chat.
 */
/** How far back `store fetch --all` goes unless told: enough for most searches, bounded for big chats. */
const ALL_SINCE = "90d"
/** What a background `--all` job is listed under; no chat argument is spelled like it. */
const ALL_CHATS = "--all"

export const fetchCommand = (messenger: Messenger): Command => {
  const fetching = messenger.fetching ?? FETCHING
  return new Command("fetch")
    .description(
      "fetch a chat's history into the local store, newest first; run it again to continue; --all fetches every chat",
    )
    .argument("[chat]", messenger.chatArgument)
    .option(
      "--all",
      `every chat, most recently active first — what search needs; the last ${ALL_SINCE} unless --since-time or --last`,
    )
    .option(
      "--limit <n>",
      `at most this many messages in this run, per chat with --all; ${fetching.maxPages * fetching.page} if not given`,
      wholeNumber,
    )
    .option("--page-size <n>", `how many messages one request asks for; ${fetching.page} if not given`, wholeNumber)
    .option(
      "--pause <duration>",
      fetching.jitter
        ? "the least pause between pages, to stay under the provider's limits; each is up to twice that"
        : "pause between pages, to stay under the provider's limits",
      fetching.pause,
    )
    .option("--since-time <time>", "stop once it reaches messages older than this: ISO 8601, or 2h / 1d ago")
    .option("--last <n>", "stop once the newest n messages are held", wholeNumber)
    .option("--catch-up", "prepare local search after fetch; overrides searchCatchUp")
    .option("--no-catch-up", "skip local preparation after this fetch")
    .option("--catch-up-chunks <n>", "at most this many local vector chunks", wholeNumber)
    .option("--catch-up-messages <n>", "skip a graph rebuild larger than this many messages", wholeNumber)
    .option("--catch-up-time <duration>", "local preparation time budget, 30s by default")
    .option("--background", "run as a job that outlives this command; `store jobs show` follows it")
    .option(
      "--estimate",
      "only estimate how many messages, requests and minutes a full fetch would still take — from the store, no request",
    )
    .action(async function (this: Command, chat: string | undefined) {
      const {
        all,
        pause,
        sinceTime: since,
        last,
        background,
        estimate,
        catchUp,
        catchUpChunks,
        catchUpMessages,
        catchUpTime,
        ...sizes
      } = this.opts<{
        all?: boolean
        limit?: number
        pageSize?: number
        pause: string
        sinceTime?: string
        last?: number
        background?: boolean
        estimate?: boolean
        catchUp?: boolean
        catchUpChunks?: number
        catchUpMessages?: number
        catchUpTime?: string
      }>()
      if ((chat === undefined) === (all !== true))
        throw new CliError("validation_error", "name a chat, or --all for every chat")
      if (all && estimate) throw new CliError("validation_error", "--estimate prices one chat; not with --all")
      if (since !== undefined && last !== undefined) {
        throw new CliError("validation_error", "give --since-time or --last, not both: how far back the fetch goes")
      }
      const pageSize = sizes.pageSize ?? fetching.page
      // Above the cap every full page comes back short, and an adapter may read a short page as the chat's start.
      if (fetching.maxPageSize !== undefined && pageSize > fetching.maxPageSize) {
        throw new CliError(
          "validation_error",
          `--page-size takes at most ${fetching.maxPageSize}: ${messenger.name ?? messenger.app.command} returns no more per request`,
        )
      }
      const limit = sizes.limit ?? fetching.maxPages * fetching.page
      const pauseMs = parseDuration(pause, "--pause")
      const window = since ?? (all && last === undefined ? ALL_SINCE : undefined)
      const sinceMs = window === undefined ? undefined : momentOf(window, "--since-time")
      const context = messengerContext(this, messenger)
      const prepare = catchUp ?? context.settings.searchCatchUp ?? false
      const preparation = {
        ...(catchUpChunks === undefined ? {} : { maxChunks: catchUpChunks }),
        ...(catchUpMessages === undefined ? {} : { maxMessages: catchUpMessages }),
        ...(catchUpTime === undefined ? {} : { timeMs: parseDuration(catchUpTime, "--catch-up-time") }),
      }
      if (!prepare && (catchUpChunks !== undefined || catchUpMessages !== undefined || catchUpTime !== undefined))
        throw new CliError("validation_error", "catch-up budgets need --catch-up or searchCatchUp true")
      if (estimate) {
        if (since !== undefined || last !== undefined) {
          throw new CliError(
            "validation_error",
            "--estimate prices a full fetch; --since-time and --last do not narrow it",
          )
        }
        const named = chat as string
        const answer = await context.withServices((services) =>
          services.archive.estimate(named, { limit, pageSize, pauseMs }),
        )
        context.renderer.result(answer)
        if (answer.missing === null) {
          context.renderer.note(
            `nothing held of this chat to measure by — \`${messenger.app.command} store fetch ${chat} --limit ${pageSize}\` gives the estimate something to go on`,
          )
        } else if (answer.missing > 0) context.renderer.note("an estimate: provider waits (FloodWait) come on top")
        return
      }
      if (prepare) {
        validateCatchUpBounds(preparation)
        refuseLocalWrite(context, messenger.app.command, "conversations.links")
        refuseLocalWrite(context, messenger.app.command, "conversations.embed")
      }
      if (background) {
        const named = chat ?? ALL_CHATS
        const argv = fetchArgv(this, {
          chat: named,
          limit,
          pageSize,
          pause,
          catchUp: prepare,
          ...(catchUpChunks === undefined ? {} : { catchUpChunks }),
          ...(catchUpMessages === undefined ? {} : { catchUpMessages }),
          ...(catchUpTime === undefined ? {} : { catchUpTime }),
          ...(last === undefined ? {} : { last }),
          ...(sinceMs === undefined ? {} : { since: new Date(sinceMs).toISOString() }),
        })
        const started = launchJob(this, context, messenger, {
          chat: named,
          argv,
          limit,
          pageSize,
          ...(last === undefined ? {} : { last }),
        })
        context.renderer.result(started)
        context.renderer.note(`started — \`${messenger.app.command} store jobs show ${started.job}\` follows it`)
        return
      }
      const jobs = jobsDir(messenger.app, context.env)
      const jobId = context.env[envName(messenger.app, "BACKFILL_JOB")]
      const stop = stopOnSignal(this)
      try {
        const options = {
          limit,
          pageSize,
          pauseMs,
          catchUp: prepare ? preparation : (false as const),
          ...(sinceMs === undefined ? {} : { sinceMs }),
          ...(last === undefined ? {} : { last }),
          note: context.renderer.note,
          stop: stop.signal,
          onPage: (progress: { fetched: number; chatId: string; oldest: number }) => {
            if (jobId) updateJob(jobs, jobId, { progress })
          },
        }
        const result = await context.withServices(
          (services): Promise<Fetched | FetchedAll> =>
            chat === undefined ? services.archive.fetchAll(options) : services.archive.fetch(chat, options),
        )
        if (jobId) updateJob(jobs, jobId, { finishedAt: new Date().toISOString(), result })
        context.renderer.result(result)
      } catch (error) {
        if (jobId) {
          const code = isCliFailure(error) ? error.code : "generic_failure"
          const message = error instanceof Error ? error.message : String(error)
          updateJob(jobs, jobId, { finishedAt: new Date().toISOString(), error: { code, message } })
        }
        throw error
      } finally {
        stop.release()
      }
    })
}

/** `store jobs`: the background runs `store fetch --background` started. */
export const jobsCommand = (messenger: Messenger): Command => {
  const command = new Command("jobs").description("background fetch jobs")

  command
    .command("list")
    .description("background fetch jobs, newest first")
    .addOption(new Option("--state <state>", "only jobs in this state").choices(JOB_STATES))
    .action(function (this: Command) {
      const context = messengerContext(this, messenger)
      const { state } = this.opts<{ state?: JobState }>()
      const jobs = listJobs(jobsDir(messenger.app, context.env)).filter(
        (job) => job.profile === context.profile && (state === undefined || stateOf(job) === state),
      )
      renderList(context.renderer, context.format, jobs.map(brief))
      if (jobs.length === 0)
        context.renderer.note(`no ${state === undefined ? "" : `${state} `}background fetch jobs for this profile`)
    })

  command
    .command("show")
    .description("one background job — the newest when none is named — and what the store now holds of its chat")
    .argument("[job]", "the job id `store fetch --background` printed")
    .action(async function (this: Command, id: string | undefined) {
      const context = messengerContext(this, messenger)
      const job = findJob(messenger, context, id)
      const chatId = job.progress?.chatId
      const held =
        chatId === undefined
          ? undefined
          : await context.withServices((services) => services.archive.held(chatId)).catch(() => undefined)
      context.renderer.result({ ...brief(job), ...(held ? { held } : {}), log: job.log })
    })

  command
    .command("cancel")
    .description("stop a running background job after its current page; a later fetch resumes where it stopped")
    .argument("<job>", "the job id")
    .action(function (this: Command, id: string) {
      const context = messengerContext(this, messenger)
      const job = findJob(messenger, context, id)
      if (stateOf(job) !== "running") {
        throw new CliError("validation_error", `job ${job.id} is not running — it is ${stateOf(job)}`)
      }
      updateJob(jobsDir(messenger.app, context.env), job.id, { cancelRequestedAt: new Date().toISOString() })
      process.kill(job.pid, "SIGTERM")
      context.renderer.result({ job: job.id, cancelled: true })
    })

  command
    .command("retry")
    .description("start a partial, failed or died job again, as a new job; the fetch resumes where the store stopped")
    .argument("[job]", "the job id")
    .option("--failed", "every chat whose newest job partial, failed or died")
    .action(function (this: Command, id: string | undefined) {
      const context = messengerContext(this, messenger)
      const { failed } = this.opts<{ failed?: boolean }>()
      if ((id === undefined) === (failed !== true))
        throw new CliError("validation_error", "name a job, or --failed for every partial or failed one")
      const broken = (job: Job) => ["partial", "failed", "died"].includes(stateOf(job))
      if (id !== undefined) {
        const job = findJob(messenger, context, id)
        if (!broken(job)) throw new CliError("validation_error", `job ${job.id} did not fail — it is ${stateOf(job)}`)
        context.renderer.result(retryJob(this, context, messenger, job))
        return
      }
      const newest = new Map<string, Job>()
      for (const job of listJobs(jobsDir(messenger.app, context.env)))
        if (job.profile === context.profile && !newest.has(job.chat)) newest.set(job.chat, job)
      const items = []
      for (const job of [...newest.values()].filter(broken)) {
        try {
          items.push(retryJob(this, context, messenger, job))
        } catch (error) {
          if (!(error instanceof CliError)) throw error
          items.push({ retried: job.id, chat: job.chat, error: { code: error.code, message: error.message } })
        }
      }
      renderList(context.renderer, context.format, items)
      if (items.length === 0) context.renderer.note("no partial, failed or died jobs to retry")
    })

  annotate(command.command("clear"), { mutates: true, local: true })
    .description("forget finished jobs and remove their logs; a running job is kept")
    .action(function (this: Command) {
      const context = messengerContext(this, messenger)
      const dir = jobsDir(messenger.app, context.env)
      const finished = listJobs(dir).filter((job) => job.profile === context.profile && stateOf(job) !== "running")
      for (const job of finished) removeJob(dir, job)
      context.renderer.result({ cleared: finished.map((job) => job.id) })
    })

  return command
}

const brief = (job: Job) => ({
  job: job.id,
  chat: job.chat,
  state: stateOf(job),
  pid: job.pid,
  startedAt: job.startedAt,
  ...(job.finishedAt ? { finishedAt: job.finishedAt } : {}),
  fetched: Number(job.result?.fetched ?? job.progress?.fetched ?? 0),
  ...(job.limit === undefined ? {} : { limit: job.limit }),
  ...(job.pageSize === undefined ? {} : { pageSize: job.pageSize }),
  ...(job.last === undefined ? {} : { last: job.last }),
  ...(job.result
    ? {
        complete: job.result.complete === true,
        ...(job.result.issue ? { issue: job.result.issue } : {}),
        ...(job.result.batch ? { batch: job.result.batch } : {}),
        ...(job.result.resume ? { resume: job.result.resume } : {}),
      }
    : {}),
  ...(job.error ? { error: job.error } : {}),
})

const findJob = (messenger: Messenger, context: MessengerContext, id: string | undefined): Job => {
  const dir = jobsDir(messenger.app, context.env)
  const job = id === undefined ? listJobs(dir).find((each) => each.profile === context.profile) : readJob(dir, id)
  if (!job || job.profile !== context.profile) {
    throw new CliError(
      "not_found",
      id === undefined ? "no background fetch jobs for this profile" : `no fetch job ${id} for this profile`,
    )
  }
  return job
}

const fetchArgv = (
  command: Command,
  {
    chat,
    limit,
    pageSize,
    pause,
    since,
    last,
    catchUp,
    catchUpChunks,
    catchUpMessages,
    catchUpTime,
  }: {
    chat: string
    limit: number
    pageSize: number
    pause: string
    since?: string
    last?: number
    catchUp?: boolean
    catchUpChunks?: number
    catchUpMessages?: number
    catchUpTime?: string
  },
): string[] => {
  const { timeout } = command.optsWithGlobals<{ timeout?: string }>()
  return [
    "store",
    "fetch",
    chat,
    "--limit",
    String(limit),
    "--page-size",
    String(pageSize),
    "--pause",
    pause,
    ...(since === undefined ? [] : ["--since-time", since]),
    ...(last === undefined ? [] : ["--last", String(last)]),
    ...(catchUp === undefined ? [] : [catchUp ? "--catch-up" : "--no-catch-up"]),
    ...(catchUpChunks === undefined ? [] : ["--catch-up-chunks", String(catchUpChunks)]),
    ...(catchUpMessages === undefined ? [] : ["--catch-up-messages", String(catchUpMessages)]),
    ...(catchUpTime === undefined ? [] : ["--catch-up-time", catchUpTime]),
    "--json",
    ...(timeout ? ["--timeout", timeout] : []),
  ]
}

const launchJob = (
  command: Command,
  context: MessengerContext,
  messenger: Messenger,
  {
    chat,
    argv,
    limit,
    pageSize,
    last,
  }: { chat: string; argv: string[]; limit: number; pageSize: number; last?: number },
) => {
  const { app } = messenger
  const dir = jobsDir(app, context.env)
  const running = listJobs(dir).find(
    (job) => job.profile === context.profile && job.chat === chat && stateOf(job) === "running",
  )
  if (running) {
    throw new CliError(
      "validation_error",
      `job ${running.id} is already fetching ${chat} (PID ${running.pid}) — \`${app.command} store jobs show ${running.id}\``,
    )
  }
  const now = new Date()
  const id = `${now.toISOString().replace(/[-:]/g, "").slice(0, 15)}-${randomBytes(3).toString("hex")}`
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const log = join(dir, `${id}.log`)
  // A shell's --timeout default would cut a job short that was asked to outlive the shell.
  const { [envName(app, "TIMEOUT")]: _timeout, ...inherited } = context.env
  const env = { ...inherited, [envName(app, "PROFILE")]: context.profile, [envName(app, "BACKFILL_JOB")]: id }
  const job: Job = {
    id,
    chat,
    profile: context.profile,
    pid: 0,
    startedAt: now.toISOString(),
    limit,
    pageSize,
    ...(last === undefined ? {} : { last }),
    argv,
    log,
  }
  saveJob(dir, job)
  const spawnJob = environmentOf<BaseEnvironment & { spawnJob?: SpawnJob }>(command).spawnJob ?? spawnDetached
  const pid = spawnJob(argv, env, log)
  saveJob(dir, { ...job, pid })
  return { job: id, pid, chat, log }
}

/** A job recorded before it kept its argv: what it did keep, the pause and window back at their defaults. */
const argvOf = (command: Command, messenger: Messenger, job: Job): string[] => {
  if (job.argv) return job.argv
  const fetching = messenger.fetching ?? FETCHING
  return fetchArgv(command, {
    chat: job.chat,
    limit: job.limit ?? fetching.maxPages * fetching.page,
    pageSize: job.pageSize ?? fetching.page,
    pause: fetching.pause,
    ...(job.last === undefined ? {} : { last: job.last }),
  })
}

const retryJob = (command: Command, context: MessengerContext, messenger: Messenger, job: Job) => {
  const fetching = messenger.fetching ?? FETCHING
  const limit = job.limit ?? fetching.maxPages * fetching.page
  const started = launchJob(command, context, messenger, {
    chat: job.chat,
    argv: argvOf(command, messenger, job),
    limit,
    pageSize: job.pageSize ?? fetching.page,
    ...(job.last === undefined ? {} : { last: job.last }),
  })
  return { retried: job.id, ...started }
}

const wholeNumber = (value: string): number => {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 1) throw new CliError("validation_error", `"${value}" is not a count`)
  return parsed
}
