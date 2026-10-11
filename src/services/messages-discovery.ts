import { CliError } from "@wirecat/cli-core"
import type { Messenger } from "../cli/messenger/context.js"
import { parseLocator } from "../domain/locator.js"
import { implicitTextTerms } from "../search/lucene/parser.js"
import { exhausted, QUERY_LIMITS, walkQuery } from "../search/lucene/types.js"
import { planQuestion, words } from "../search/question-plan.js"
import type { AccountKey, MessageStore } from "../store/store.js"
import type { FoundMessage, SearchFound, SearchQuery } from "./messages.js"
import { searchCombined } from "./messages-combined.js"
import { prepareLucene, searchLucene } from "./messages-search.js"

export const searchDiscovery = async (
  store: MessageStore,
  account: AccountKey,
  request: SearchQuery,
  messenger: Partial<Pick<Messenger, "savedChatId" | "app" | "history" | "provider">> = {},
): Promise<SearchFound> => {
  const original = await prepareLucene(store, account, request, messenger)
  const text = request.text ?? ""
  const plan = planQuestion(text, request.ast !== undefined || !!request.exact || !!request.newest)
  if (request.ast !== undefined || request.exact || request.newest || implicitTextTerms(text).size === 0)
    return searchLucene(store, account, request, messenger)
  const implicit = implicitTextTerms(text)
  if (
    !plan.changed &&
    walkQuery(original.execution.root).some(
      (node) =>
        (node.field === "text" || node.field === "exact") &&
        (node.operator !== "term" || node.field === "exact" || !implicit.has(node.span.start)),
    )
  )
    return searchLucene(store, account, request, messenger)
  const terms = [...new Set(plan.terms.concat(plan.aliases.flatMap((alias) => words(alias.split(" -> ")[1] ?? ""))))]
  if (!terms.length) return searchLucene(store, account, request, messenger)
  if (terms.length > 64) exhausted("discovery terms")
  const started = performance.now()
  const check = () => {
    if (request.signal?.aborted)
      throw new CliError("validation_error", "search was aborted", { reason: "query_aborted", complete: false })
    if (performance.now() - started > QUERY_LIMITS.milliseconds) exhausted("milliseconds")
  }
  const union = new Map<string, FoundMessage & { fused: number }>()
  let truncated = false
  const corrections = new Map<string, SearchFound["corrections"][number]>()
  const add = (items: FoundMessage[]) =>
    items.forEach((m, rank) => {
      const previous = union.get(m.locator)
      union.set(m.locator, { ...previous, ...m, fused: (previous?.fused ?? 0) + 1 / (60 + rank + 1) })
    })
  // Natural questions use one ranked partial lookup; repeated all-word lookups cannot rescue their wording gaps.
  for (const query of plan.changed ? [] : plan.queries) {
    check()
    const found = await searchCombined(store, account, { ...request, text: query, limit: 300 }, messenger, {
      candidateDepth: 300,
      rrfK: 60,
      rerank: "none",
      chatCap: 0,
    })
    add(found.items)
    for (const correction of found.corrections) corrections.set(correction.from, correction)
    truncated ||= found.hasMore || found.query.combined.truncated
  }
  check()
  const relaxed = `(${terms.join(" OR ")})${plan.scope ? ` ${plan.scope}` : ""}`
  const partialRequest = { ...request, text: relaxed, ast: undefined, limit: 300, context: 0, thread: undefined }
  const partial = await searchLucene(store, account, partialRequest, messenger)
  add(partial.items)
  truncated ||= partial.hasMore || union.size > 300
  let candidates = [...union.values()].sort((a, b) => b.fused - a.fused).slice(0, 300)
  const originals = new Set(candidates.map((m) => m.locator))
  const parentByLocator = new Map<string, FoundMessage>()
  let replyCount = 0
  if (store.directReplies && candidates.length) {
    check()
    const proposed = await store.directReplies(
      candidates.map((m) => {
        const locator = parseLocator(m.locator)
        return { account: { provider: locator.provider, account: locator.account }, chatId: m.chatId, id: m.id }
      }),
      100,
    )
    truncated ||= proposed.hasMore
    if (proposed.items.length) {
      const only = candidates
        .concat(proposed.items.map((m) => ({ ...m, fused: 0 })))
        .map((m) => {
          const { provider, account } = parseLocator(m.locator)
          return { provider, account, chatId: m.chatId, id: m.id }
        })
        .filter(
          (m) =>
            !request.only ||
            request.only.some(
              (key) =>
                key.provider === m.provider && key.account === m.account && key.chatId === m.chatId && key.id === m.id,
            ),
        )
      const eligible = await searchLucene(
        store,
        account,
        {
          ...request,
          text: plan.scope || undefined,
          ast: undefined,
          limit: 500,
          only,
          context: 0,
          thread: undefined,
        },
        messenger,
      )
      if (eligible.hasMore) exhausted("reply eligibility")
      const allowed = new Set(eligible.items.map((m) => m.locator))
      const parents = new Map(
        candidates.map((m) => [
          JSON.stringify([m.chatId, m.id, parseLocator(m.locator).account, parseLocator(m.locator).provider]),
          m,
        ]),
      )
      for (const child of proposed.items) {
        check()
        const owner = parseLocator(child.locator)
        const parent = parents.get(JSON.stringify([child.chatId, child.replyToId, owner.account, owner.provider]))
        if (!parent || !allowed.has(parent.locator) || !allowed.has(child.locator)) continue
        parentByLocator.set(child.locator, parent)
        if (!candidates.some((m) => m.locator === child.locator)) {
          candidates.push({ ...child, fused: parent.fused })
          replyCount++
        }
      }
    }
  }
  truncated ||= candidates.length > 300
  candidates = candidates.sort((a, b) => b.fused - a.fused).slice(0, 300)
  replyCount = candidates.filter((m) => !originals.has(m.locator)).length
  const stem = (w: string) => original.execution.stemmer?.stemToken(w) ?? w
  const stems = terms.map(stem)
  let bytes = 0
  candidates = candidates
    .map((m) => {
      check()
      const parent = parentByLocator.get(m.locator)
      const body = `${parent ? `${parent.text}\n` : ""}${m.text}`
      bytes += Buffer.byteLength(body)
      if (bytes > QUERY_LIMITS.bodyBytes) exhausted("bodyBytes")
      const tokens = new Set(words(body).map(stem))
      const matchedTerms = terms.filter((_, i) => tokens.has(stems[i] ?? ""))
      const missingTerms = terms.filter((_, i) => !tokens.has(stems[i] ?? ""))
      const coverage = matchedTerms.length / terms.length
      return {
        ...m,
        score: coverage * 4 + m.fused,
        discovery: {
          coverage,
          matchedTerms,
          missingTerms,
          ...(parent ? { parent: parent.locator } : {}),
        },
      }
    })
    .sort(
      (a, b) =>
        (b.score ?? 0) - (a.score ?? 0) ||
        Number(parentByLocator.has(b.locator)) - Number(parentByLocator.has(a.locator)),
    )
  check()
  const items = await Promise.all(
    candidates.slice(0, request.limit).map(async ({ fused: _fused, ...m }) => {
      if (!request.context) return m
      check()
      const owner = parseLocator(m.locator)
      return {
        ...m,
        context: await store.around({ provider: owner.provider, account: owner.account }, m.chatId, m.id, {
          before: request.context,
          after: request.context,
        }),
      }
    }),
  )
  if (!partial.query) throw new Error("Lucene discovery query metadata is missing")
  return {
    ...partial,
    corrections: items.some((m) => m.match === "corrected") ? [...corrections.values()] : [],
    items,
    hasMore: truncated || candidates.length > request.limit,
    query: {
      ...partial.query,
      discovery: {
        method: "lexical-partial",
        candidateDepth: 300,
        candidates: candidates.length,
        repliesAdded: replyCount,
        truncated,
        terms,
        queries: [...(plan.changed ? [] : plan.queries), relaxed],
      },
    },
  }
}
