import { CliError } from "@wirecat/cli-core"
import { formatLocator } from "../domain/locator.js"
import type { Provider } from "../domain/models.js"
import { pickPerson } from "../resolve.js"
import type { AccountKey, MessageStore } from "../store/store.js"

export const TIMELINE_ITEMS = 50
export const TIMELINE_MAX = 500
export const SCOPES = ["personal", "work"] as const
export type Scope = (typeof SCOPES)[number]

export interface TimelineItem {
  at: string
  subject: string
  /** The store's own key for the subject; a locator, where there is one, is what other commands take. */
  subjectId: number
  role: string
  scope: string
  provider: Provider | null
  account: string | null
  chatId: string | null
  locator: string | null
  projectId: number | null
}

export interface PersonTimeline {
  person: { uid: string; name: string | null }
  items: TimelineItem[]
  limits: { items: number }
  hasMore: boolean
  /** Changes a large write left queued; the items leave them out until the next write recomputes them. */
  pending: number
}

export interface TimelineOptions {
  scope?: Scope
  /** ms, inclusive. */
  since?: number
  /** ms, inclusive. */
  until?: number
  limit?: number
}

/**
 * Everything one person took part in, across every identity linked to them, newest first. The index
 * is derived and nothing else keeps it current, so it is rebuilt for this one person first.
 */
export const personTimeline = async (
  store: MessageStore,
  asked: AccountKey,
  reference: string,
  { scope, since, until, limit = TIMELINE_ITEMS }: TimelineOptions = {},
): Promise<PersonTimeline> => {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > TIMELINE_MAX)
    throw new CliError("validation_error", `the limit takes 1–${TIMELINE_MAX}`)
  if (since !== undefined && until !== undefined && since > until)
    throw new CliError("validation_error", "the start of the range is after its end")
  const found = pickPerson(reference, await store.people(asked.provider, { account: asked.account }))
  const record = await store.personOf({ provider: asked.provider, id: found.id })
  if (!record) throw new CliError("not_found", `no person ${found.id} in the store`)
  const personId = Number(record.uid)
  const pending = store.involvements.pending()
  const rows = store.involvements.forPerson(personId, {
    ...(scope === undefined ? {} : { scope }),
    ...(since === undefined ? {} : { since }),
    ...(until === undefined ? {} : { until }),
    only: asked,
    limit: limit + 1,
  })
  return {
    person: { uid: record.uid, name: record.name },
    items: rows.slice(0, limit).map((row) => ({
      at: new Date(row.occurredAt).toISOString(),
      subject: row.subjectType,
      subjectId: row.subjectId,
      role: row.role,
      scope: row.scope,
      provider: row.provider,
      account: row.account,
      chatId: row.chat,
      locator:
        row.provider && row.account && row.chat && row.message
          ? formatLocator({ provider: row.provider, account: row.account, chat: row.chat, message: row.message })
          : null,
      projectId: row.projectId,
    })),
    limits: { items: limit },
    hasMore: rows.length > limit,
    pending,
  }
}
