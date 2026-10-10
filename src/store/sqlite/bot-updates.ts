import { CliError } from "@wirecat/cli-core"
import type { AccountKey } from "../store.js"
import { accountPk, findAccountPk } from "./accounts.js"
import type { StoreContext } from "./open.js"

export interface BotUpdate {
  id: number
  externalId: string
  kind: string
  /** `null` once the update was handled more than 30 days ago (`LOG_RETENTION`). */
  payload: unknown
  receivedAt: number
  handledAt: number | null
  error: string | null
  replayedAt: number | null
}

export interface BotUpdateStore {
  save(
    account: AccountKey,
    update: { externalId: string; kind: string; payload: unknown; receivedAt?: number },
  ): boolean
  handled(account: AccountKey, externalId: string): void
  failed(account: AccountKey, externalId: string, error: string): void
  replayed(account: AccountKey, externalId: string): void
  recent(account: AccountKey, limit?: number): BotUpdate[]
}

export const botUpdateStoreOver = (context: StoreContext, afterSave: () => void = () => {}): BotUpdateStore => {
  const { database, now } = context
  const change = (account: AccountKey, externalId: string, column: "handled_at" | "replayed_at") => {
    const accountId = findAccountPk(context, account)
    if (accountId === undefined) throw new CliError("not_found", "no stored bot update with that id")
    const changed = database
      .prepare(
        `UPDATE bot_updates SET ${column}=?${column === "handled_at" ? ", error=NULL" : ""} WHERE account_id=? AND external_id=?`,
      )
      .run(now(), accountId, externalId).changes
    if (!changed) throw new CliError("not_found", "no stored bot update with that id")
  }
  return {
    save: (account, update) => {
      if (!update.externalId || !update.kind)
        throw new CliError("validation_error", "an update needs its external id and kind")
      if (update.receivedAt !== undefined && (!Number.isSafeInteger(update.receivedAt) || update.receivedAt < 0))
        throw new CliError("validation_error", "receivedAt is a nonnegative epoch timestamp")
      const payload = JSON.stringify(update.payload)
      if (payload === undefined) throw new CliError("validation_error", "an update needs a JSON payload")
      const saved =
        database
          .prepare(
            "INSERT INTO bot_updates (account_id, external_id, kind, payload, received_at, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(account_id, external_id) DO NOTHING",
          )
          .run(accountPk(context, account), update.externalId, update.kind, payload, update.receivedAt ?? now(), now())
          .changes > 0
      afterSave()
      return saved
    },
    handled: (account, externalId) => change(account, externalId, "handled_at"),
    failed: (account, externalId, error) => {
      const accountId = findAccountPk(context, account)
      if (
        accountId === undefined ||
        !database
          .prepare("UPDATE bot_updates SET handled_at=NULL, error=? WHERE account_id=? AND external_id=?")
          .run(error, accountId, externalId).changes
      )
        throw new CliError("not_found", "no stored bot update with that id")
    },
    replayed: (account, externalId) => change(account, externalId, "replayed_at"),
    recent: (account, limit = 100) => {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000)
        throw new CliError("validation_error", "update limit takes 1–1000")
      const accountId = findAccountPk(context, account)
      if (accountId === undefined) return []
      return database
        .prepare("SELECT * FROM bot_updates WHERE account_id=? ORDER BY received_at DESC, id DESC LIMIT ?")
        .all(accountId, limit)
        .map((row) => ({
          id: Number(row.id),
          externalId: String(row.external_id),
          kind: String(row.kind),
          payload: JSON.parse(String(row.payload)),
          receivedAt: Number(row.received_at),
          handledAt: row.handled_at == null ? null : Number(row.handled_at),
          replayedAt: row.replayed_at == null ? null : Number(row.replayed_at),
          error: row.error == null ? null : String(row.error),
        }))
    },
  }
}
