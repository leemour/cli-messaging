import { mkdtempSync, readdirSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { openCache } from "../open.js"
import { openStore } from "../store.js"
import { ENTITY_TABLES, isEntityType } from "./entity-types.js"

const sources = (directory: string): string[] =>
  readdirSync(directory, { recursive: true, encoding: "utf8" })
    .filter((file) => /\.(ts|sql)$/.test(file) && !file.endsWith(".test.ts") && !file.endsWith(".generated.ts"))
    .map((file) => readFileSync(join(directory, file), "utf8"))

const POINTER_LITERALS = [
  /\b\w+_type\s*(?:=|IN\s*\()\s*((?:'\w+'\s*,?\s*)+)/g,
  /\b\w+_type, \w+_id\) VALUES \(('\w+')/g,
  /\b\w+Type: "(\w+)"/g,
]

describe("the entity types a pointer may hold", () => {
  it("include every type the store's code and triggers write or compare", () => {
    const written = new Set<string>()
    for (const text of [...sources("src/store"), ...sources("drizzle")])
      for (const pattern of POINTER_LITERALS)
        for (const [, found = ""] of text.matchAll(pattern))
          for (const type of found.match(/\w+/g) ?? []) written.add(type)

    expect(written.size).toBeGreaterThan(10)
    expect([...written].filter((type) => !isEntityType(type))).toEqual([])
  })

  it("each name a table keyed by id", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "entity-")), "store.db")
    await (await openStore({ path })).close()
    const database = await openCache(path)
    const keyed = (table: string) =>
      database.prepare("SELECT 1 FROM pragma_table_info(?) WHERE name = 'id' AND pk = 1").get(table) !== undefined
    expect(Object.values(ENTITY_TABLES).filter((table) => !keyed(table))).toEqual([])
    database.close()
  })
})
