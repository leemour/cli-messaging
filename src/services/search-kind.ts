import { CliError } from "@wirecat/cli-core"
import type { AccountKey } from "../store/store.js"

export type SearchKind = "messages" | "mail"

export const NO_MAIL = "no_mail"

export const MAIL = "email"
/** Notes stored as messages before store version 25: `search notes` reads their own table now. */
const OLD_NOTES = "notes"

/**
 * The accounts a `search messages` or `search mail` reads, from those the query chose. `explicit` is the
 * source the owner named, so asking `search messages` for mail is an error rather than an empty answer.
 */
export const accountsOfKind = (
  kind: SearchKind | undefined,
  chosen: AccountKey[],
  held: readonly AccountKey[],
  explicit: string | undefined,
  command = "tg",
): AccountKey[] => {
  if (kind === undefined) return chosen
  if (kind === "messages") {
    if (explicit === MAIL)
      throw new CliError("validation_error", `mail is searched with \`${command} search mail\`, not search messages`)
    return chosen.filter(({ provider }) => provider !== MAIL && provider !== OLD_NOTES)
  }
  if (explicit !== undefined && explicit !== MAIL && explicit !== "all")
    throw new CliError(
      "validation_error",
      `search mail reads mail only — \`${command} search messages\` searches ${explicit}`,
    )
  const mail = held.filter(({ provider }) => provider === MAIL)
  if (mail.length === 0)
    throw new CliError("not_found", "no mail in the store yet — `memo mail import --since <date>` imports it", {
      reason: NO_MAIL,
    })
  return mail.map(({ provider, account }) => ({ provider, account }))
}
