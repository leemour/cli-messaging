import * as v from "valibot"
import type { Messenger } from "../../cli/messenger/context.js"
import { runsDirFor } from "../../cli/runs/run.js"
import { searchRuns } from "../../cli/runs/search.js"
import { type AnyTool, READ, tool } from "../tool.js"

export const runsTools = (messenger: Messenger): Record<string, AnyTool> => ({
  runs_search: tool({
    title: "Search recorded diagnostic logs",
    description:
      "Search this profile's run metadata and safe diagnostic events, including partial batches and failed IDs. No message contents, tokens or raw job logs. Literal query plus status, error_code, operation and since_time filters; paged results. Does not connect or record its own search. Returns items, page, limit, hasMore; each run has at most100 matched events with eventsTruncated.",
    key: null,
    annotations: { ...READ, openWorldHint: false },
    input: v.object({
      query: v.optional(v.string()),
      status: v.optional(v.picklist(["success", "failed", "partial", "running"])),
      error_code: v.optional(v.string()),
      operation: v.optional(v.string()),
      since_time: v.optional(v.string()),
      limit: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(100))),
      page: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
    }),
    local: async (args, defaults) =>
      searchRuns(runsDirFor(messenger.app, defaults.env), {
        ...args,
        errorCode: args.error_code,
        since: args.since_time,
        profile: defaults.settings.profile ?? "default",
      }),
  }),
})
