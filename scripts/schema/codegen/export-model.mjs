import { writeFileSync } from "node:fs"

const dir = process.env.SPEC_DIR
const m = await import(`${dir}/spec.mjs`)
const out = m.model().flatMap((g) => g.tables.map((t) => ({ group: g.key, ...t, fkIndexes: m.indexes(t) })))
writeFileSync(process.argv[2], JSON.stringify(out, null, 1))
console.log(out.length)
