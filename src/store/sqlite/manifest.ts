import type { Migration } from "../migrations.js"
import { GENERATED } from "./migrations.generated.js"

/**
 * Every folder drizzle-kit generated, in order, and the schema version it becomes. Consecutive
 * folders may share a version — a generated one and a `--custom` one for its triggers — and are
 * applied as one migration, one `schema_migrations` row. The initial folder holds both: the SQL drizzle-kit
 * generated and, after it, the FTS5 tables, triggers and seed rows it cannot. The version and
 * `minCompatible` are ours, not Drizzle's: `schema_migrations` is the only log, and every build
 * already installed decides by it.
 */
export interface ManifestEntry {
  name: string
  version: number
  minCompatible: number
}

/** One migration creates the whole schema; every later one is added as the next version. */
export const MANIFEST: ManifestEntry[] = [{ name: "20261010184427_initial", version: 1, minCompatible: 1 }]

export const generatedMigrations = (
  manifest: ManifestEntry[] = MANIFEST,
  generated: { name: string; statements: string[] }[] = GENERATED,
): Migration[] => {
  const migrations: Migration[] = []
  for (const entry of manifest) {
    const found = generated.find(({ name }) => name === entry.name)
    if (!found) throw new Error(`migration ${entry.name} is in the manifest and not in the bundle — run pnpm db:bundle`)
    const last = migrations.at(-1)
    if (last?.version !== entry.version) {
      migrations.push({ version: entry.version, minCompatible: entry.minCompatible, statements: [...found.statements] })
    } else if (last.minCompatible !== entry.minCompatible) {
      throw new Error(`the rows of version ${entry.version} disagree on minCompatible`)
    } else {
      last.statements.push(...found.statements)
    }
  }
  return migrations
}
