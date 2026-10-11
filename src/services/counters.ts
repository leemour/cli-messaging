import { CliError } from "@wirecat/cli-core"
import {
  COUNTER_FIELDS,
  type CounterField,
  type CounterObservations,
  counterObservationTime,
} from "../domain/counters.js"
import { formatLocator, parseLocator } from "../domain/locator.js"
import type { CounterTarget } from "../store/store.js"
import type { ServiceDeps } from "./deps.js"
import type { SearchQuery } from "./messages.js"
import { prepareLucene } from "./messages-search.js"
import { observationDuration } from "./retention.js"

export type CounterQuery = SearchQuery & {
  counters?: string
  maxAge?: string
  selection?: unknown
  maxMessages?: number
  syncTime?: string
  dryRun?: boolean
}
export const counterFields = (text = "views,reactions,comments"): CounterField[] => {
  const fields = text.split(",").map((one) => one.trim())
  if (
    !fields.length ||
    fields.some((one) => !(COUNTER_FIELDS as readonly string[]).includes(one)) ||
    new Set(fields).size !== fields.length
  )
    throw new CliError("validation_error", "--counters takes distinct views,reactions,comments names")
  return fields as CounterField[]
}
const bound = (value: number, flag: string) => {
  if (!Number.isSafeInteger(value) || value < 1 || value > 100)
    throw new CliError("validation_error", `${flag} must be 1–100`)
  return value
}
export const countersService = (deps: ServiceDeps) => {
  const select = async (query: CounterQuery) => {
    query.signal?.throwIfAborted()
    const fields = counterFields(query.counters),
      limit = bound(query.limit ?? 20, "--limit")
    const maxAge = observationDuration(query.maxAge ?? "24h", "--max-age"),
      now = Date.now()
    const store = await deps.store(),
      account = await deps.account()
    let items: CounterTarget[],
      hasMore = false
    if (query.selection !== undefined) {
      if (query.text || query.ast || query.chat || query.source || query.exact || query.timezone)
        throw new CliError("validation_error", "--selection cannot be combined with query or scope options")
      const raw = typeof query.selection === "string" ? query.selection : JSON.stringify(query.selection)
      if (!raw || Buffer.byteLength(raw) > 64 * 1024)
        throw new CliError("validation_error", "counter selection must fit within 64 KiB")
      let pinned: { kind?: unknown; version?: unknown; locators?: unknown }
      try {
        pinned = JSON.parse(raw)
      } catch {
        throw new CliError("validation_error", "invalid counter selection JSON")
      }
      if (
        pinned?.kind !== "counter-targets" ||
        pinned.version !== 1 ||
        !Array.isArray(pinned.locators) ||
        !pinned.locators.length ||
        pinned.locators.length > 100 ||
        pinned.locators.some((one) => typeof one !== "string" || one.length > 2048)
      )
        throw new CliError("validation_error", "invalid bounded counter-target selection")
      const locators = [...new Set(pinned.locators as string[])]
      hasMore = locators.length > limit
      items = []
      for (const locator of locators.slice(0, limit)) {
        const target = parseLocator(locator)
        if (target.provider !== account.provider || target.account !== account.account)
          throw new CliError("validation_error", "counter selection is outside the active account")
        const counters = await store.counterStates?.(account, target.chat, target.message, { now, maxAge })
        if (!counters?.length)
          throw new CliError("validation_error", "counter selection changed — obtain a new selection")
        items.push({
          locator: formatLocator(target),
          account,
          chatId: target.chat,
          messageId: target.message,
          counters,
        })
      }
    } else {
      if (!store.counterTargets)
        throw new CliError("validation_error", "counter queries require a newer messaging store")
      const prepared = await prepareLucene(store, account, { ...query, limit, language: "lucene" }, deps.messenger)
      const found = await store.counterTargets(prepared.execution, { now, maxAge })
      items = found.items
      hasMore = found.hasMore
    }
    return {
      store,
      account,
      fields,
      now,
      maxAge,
      items: items.map((item) => ({ ...item, counters: item.counters.filter((one) => fields.includes(one.counter)) })),
      hasMore,
    }
  }
  return {
    show: async (query: CounterQuery) => {
      const found = await select(query)
      return {
        items: found.items,
        included: found.items.length,
        hasMore: found.hasMore,
        cutoff: new Date(found.now).toISOString(),
        maxAgeMilliseconds: found.maxAge,
        selection: { kind: "counter-targets", version: 1, locators: found.items.map((one) => one.locator) },
      }
    },
    refresh: async (query: CounterQuery) => {
      if (!query.chat && query.selection === undefined)
        throw new CliError("validation_error", "refresh requires an explicit --chat or pinned --selection")
      const maxMessages = bound(query.maxMessages ?? query.limit ?? 20, "--max-messages")
      const time = observationDuration(query.syncTime ?? "30s", "--sync-time")
      if (time > 300_000) throw new CliError("validation_error", "--sync-time must not exceed 5m")
      const found = await select({ ...query, limit: Math.min(bound(query.limit ?? 20, "--limit"), maxMessages) })
      if (
        found.items.some(
          (one) => one.account.provider !== found.account.provider || one.account.account !== found.account.account,
        )
      )
        throw new CliError("validation_error", "refresh targets must belong to the active account")
      const supported = found.fields.filter((one) => deps.messenger.counterFields?.includes(one)),
        unsupported = found.fields.filter((one) => !supported.includes(one))
      const preview = {
        dryRun: true,
        targets: found.items.map((one) => one.locator),
        counters: found.fields,
        supported,
        unsupported,
        maxMessages,
        timeMilliseconds: time,
        hasMore: found.hasMore,
      }
      if (query.dryRun) return preview
      if (deps.offline) throw new CliError("validation_error", "counter refresh requires an online session")
      if (!found.store.updateCounterObservations)
        throw new CliError("validation_error", "counter refresh requires a newer messaging store")
      const request = { chatId: null, key: "stats.messages.counters.refresh" }
      await deps.guard.ask?.(request)
      deps.guard.check(request, { reserve: false })
      const controller = new AbortController(),
        timer = setTimeout(() => controller.abort(new Error("counter refresh time budget exhausted")), time)
      const signal = query.signal ? AbortSignal.any([query.signal, controller.signal]) : controller.signal
      const items: {
        locator: string
        updated: CounterField[]
        missing: CounterField[]
        status: "updated" | "missing" | "failed" | "unsupported" | "skipped"
      }[] = []
      let stopped: "complete" | "time" | "cancelled" = "complete"
      try {
        if (!supported.length || !found.items.length)
          return {
            ...preview,
            dryRun: false,
            items: found.items.map((one) => ({
              locator: one.locator,
              status: "unsupported" as const,
              updated: [],
              missing: [],
            })),
            stopped,
            complete: !unsupported.length && !found.items.length,
          }
        const work = async (adapter: Awaited<ReturnType<ServiceDeps["connection"]>>) => {
          if (!adapter.fetchCounters)
            throw new CliError("validation_error", "adapter does not support explicit counter refresh")
          for (const target of found.items) {
            if (signal.aborted) {
              stopped = query.signal?.aborted ? "cancelled" : "time"
              break
            }
            try {
              let onAbort: () => void = () => {}
              const aborted = new Promise<never>((_, reject) => {
                onAbort = () => {
                  void adapter.close().catch(() => {})
                  reject(signal.reason ?? new Error("counter refresh cancelled"))
                }
                signal.addEventListener("abort", onAbort, { once: true })
                if (signal.aborted) onAbort()
              })
              let response: CounterObservations
              try {
                response = await Promise.race([
                  adapter.fetchCounters(target.chatId, target.messageId, supported, signal),
                  aborted,
                ])
              } finally {
                signal.removeEventListener("abort", onAbort)
              }
              if (signal.aborted) {
                stopped = query.signal?.aborted ? "cancelled" : "time"
                break
              }
              const observations: CounterObservations = {}
              for (const field of supported)
                if (response[field]) {
                  counterObservationTime(response[field], Date.now())
                  observations[field] = response[field]
                }
              await found.store.updateCounterObservations?.(
                found.account,
                target.chatId,
                target.messageId,
                observations,
              )
              const states = await found.store.counterStates?.(found.account, target.chatId, target.messageId, {
                now: Date.now(),
                maxAge: found.maxAge,
              })
              const updated = supported.filter((field) => {
                const observed = observations[field]
                return (
                  observed !== undefined &&
                  states?.some(
                    (state) =>
                      state.counter === field &&
                      state.value === observed.value &&
                      state.observedAt !== null &&
                      Date.parse(state.observedAt) === Date.parse(observed.observedAt),
                  )
                )
              })
              items.push({
                locator: target.locator,
                updated,
                missing: supported.filter((one) => !updated.includes(one)),
                status: updated.length ? "updated" : Object.keys(observations).length ? "skipped" : "missing",
              })
            } catch {
              if (signal.aborted) {
                stopped = query.signal?.aborted ? "cancelled" : "time"
                break
              }
              items.push({ locator: target.locator, updated: [], missing: supported, status: "failed" })
            }
          }
        }
        if (deps.withConnection) await deps.withConnection(work)
        else await work(await deps.connection())
      } finally {
        clearTimeout(timer)
      }
      return {
        ...preview,
        dryRun: false,
        items,
        stopped,
        complete:
          stopped === "complete" &&
          !unsupported.length &&
          items.every((one) => one.status === "updated" && !one.missing.length),
      }
    },
  }
}
export type CountersService = ReturnType<typeof countersService>
