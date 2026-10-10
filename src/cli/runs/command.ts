import { CliError } from "@wirecat/cli-core"
import { Command, Option } from "commander"
import type { AppIdentity } from "../app.js"
import { environmentOf, outputFor } from "../context.js"
import { positiveCount, renderPage } from "../paging.js"
import { findRun, listRuns, readEvents, runsDirFor } from "./run.js"
import { searchRuns } from "./search.js"

/** Reading the log is not itself worth recording, so **nothing here starts a run**. */
export const runsCommand = (app: AppIdentity): Command => {
  const command = new Command("runs").description("recorded runs — what this tool did, and when")
  const dir = (from: Command) => runsDirFor(app, environmentOf(from).env ?? process.env)
  const runOrRefuse = (from: Command, id: string) => {
    const found = findRun(dir(from), id)
    if (!found) throw new CliError("not_found", `no recorded run "${id}" — \`${app.command} runs list\` shows them`)
    return found
  }

  command
    .command("list")
    .description("recorded runs, newest first")
    .option("--limit <n>", "how many to show", positiveCount("--limit"), 20)
    .action(function (this: Command) {
      const { limit } = this.opts<{ limit: number }>()
      const output = outputFor(this)
      const { renderer } = output
      const runs = listRuns(dir(this))
      renderPage(
        { ...output, settings: { page: 1, limit, all: false } },
        { items: runs.slice(0, limit), hasMore: runs.length > limit },
        undefined,
        () => "more recorded runs — increase `--limit` to show them",
      )
      if (runs.length === 0) renderer.note("nothing recorded — a run is kept with `--record`, or when it fails")
    })

  command
    .command("show")
    .argument("<run-id>", `an id from \`${app.command} runs list\``)
    .description("one run: what it was, and one line per operation")
    .action(function (this: Command, id: string) {
      const { renderer } = outputFor(this)
      const found = runOrRefuse(this, id)
      renderer.result({ ...found.metadata, directory: found.dir, events: readEvents(found.dir).map(readable) })
    })

  command
    .command("search")
    .description("search recorded diagnostic metadata and events; no message contents")
    .argument("[query]", "case-insensitive literal diagnostic text")
    .addOption(new Option("--status <status>", "run outcome").choices(["success", "failed", "partial", "running"]))
    .option("--error-code <code>", "one stable error code")
    .option("--operation <name>", "one operation, such as messages.download")
    .option("--profile <name>", "one recorded profile")
    .option("--since-time <time>", "runs starting on or after an ISO time or 2h / 1d ago")
    .option("--limit <n>", "matches per page, at most 100", positiveCount("--limit"), 20)
    .option("--page <n>", "result page", positiveCount("--page"), 1)
    .action(function (this: Command, query?: string) {
      outputFor(this).renderer.result(
        searchRuns(dir(this), {
          ...this.opts(),
          since: this.opts().sinceTime,
          ...(query === undefined ? {} : { query }),
        }),
      )
    })

  command
    .command("path")
    .argument("<run-id>", `an id from \`${app.command} runs list\``)
    .description("the directory holding one run")
    .action(function (this: Command, id: string) {
      outputFor(this).renderer.result({ path: runOrRefuse(this, id).dir })
    })

  return command
}

/** Drops what the logger puts on every line and `show` already prints once above the events. */
const readable = ({ level, runId, command, profile, ...event }: Record<string, unknown>) => event
