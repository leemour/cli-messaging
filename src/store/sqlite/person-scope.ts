import { CliError } from "@wirecat/cli-core"
import type { StoreContext } from "./open.js"

export const personSeenInAccounts = (
  { database }: Pick<StoreContext, "database">,
  uid: string,
  accountIds: readonly number[],
): boolean => {
  const id = Number(uid)
  if (
    !/^[1-9]\d*$/.test(uid) ||
    !Number.isSafeInteger(id) ||
    !accountIds.length ||
    accountIds.length > 1000 ||
    accountIds.some((account) => !Number.isSafeInteger(account) || account <= 0)
  )
    throw new CliError(
      "validation_error",
      "Person scope requires a positive safe person ID and 1–1000 positive safe account IDs",
    )
  return Boolean(
    database
      .prepare(
        "SELECT 1 FROM persons p JOIN identity_links l ON l.person_id=p.id JOIN account_identities a ON a.identity_id=l.identity_id WHERE p.id=? AND a.account_id IN (SELECT value FROM json_each(?)) LIMIT 1",
      )
      .get(id, JSON.stringify(accountIds)),
  )
}
