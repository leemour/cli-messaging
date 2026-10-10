import { createHash } from "node:crypto"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"
import { MIGRATIONS, migrate } from "./migrations.js"
import { openCache } from "./open.js"
import { openStore } from "./store.js"

/** What 0.218.0, the first release of this schema, shipped as version 1; a file that ran it exists now. */
const RELEASED_VERSION_1 = "2352ee51e828b5a17dd946b6b7f22540672c9986a5d61080c9d42724127dda12"

it("keeps version 1 as 0.218.0 released it", () => {
  const first = MIGRATIONS[0]
  expect([first?.version, createHash("sha256").update(JSON.stringify(first?.statements)).digest("hex")]).toEqual([
    1,
    RELEASED_VERSION_1,
  ])
})

it("upgrades a store 0.218.0 created in place, keeping its rows", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "upgrade-")), "wirecat.db")
  const old = await openCache(path)
  migrate(old, { migrations: MIGRATIONS.filter((migration) => migration.version === 1) })
  old.exec(`INSERT INTO accounts (provider, external_id, name, scope, created_at, updated_at)
      VALUES ('telegram', '100', 'Alice Example', 'personal', 1, 1);
    INSERT INTO chats (account_id, external_id, kind, title, created_at, updated_at)
      VALUES (1, '-1001', 'group', 'Garden club', 1, 1);`)
  old.close()

  const store = await openStore({ path })
  try {
    expect(await store.storedAccounts()).toMatchObject([
      { provider: "telegram", account: "100", name: "Alice Example" },
    ])
    expect((await store.chats({ provider: "telegram", account: "100" }, {})).items).toMatchObject([
      { id: "-1001", title: "Garden club" },
    ])
  } finally {
    await store.close()
  }
  const upgraded = await openCache(path)
  expect(upgraded.prepare("SELECT max(version) AS v FROM schema_migrations").get()?.v).toBe(MIGRATIONS.at(-1)?.version)
  upgraded.close()
})
