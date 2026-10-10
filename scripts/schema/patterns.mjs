const singular = (t) => t.replace(/ies$/, "y").replace(/sses$/, "ss").replace(/s$/, "")
export const patternNote = (table, col) => {
  const n = col.name
  if (n === "created_at") return "when this row was saved here"
  if (n === "updated_at") return "when this row last changed here"
  if (n === "deleted_at") return "when it disappeared at the source; the row stays, sync never hard-deletes"
  if (n === "external_id") return "the source's own id for it"
  if (n === "metadata") return "JSON: what the source sends that has no column of its own and is not searched"
  if (n === "normalized_text") return "the text folded for search: lower case, accents removed; filled by the indexer"
  if (n === "external_created_at") return "when the source says it was created"
  if (n === "external_updated_at") return "when the source says it last changed"
  if (n === "account_id") return "the integration account it came through"
  if (n === "position") return "order within its parent, from 0"
  if (n === "revision")
    return "edit counter, raised on every change; an edit names the revision it read, so two writers cannot overwrite each other"
  if (n === "indexable_type") return "which table the waiting row belongs to"
  if (/_type$/.test(n)) return `the kind of thing \`${n.replace(/_type$/, "_id")}\` points at: a singular table name`
  if (/_id$/.test(n) && !col.ref) {
    const base = n.replace(/_id$/, "")
    if (table.cols.some((x) => x.name === `${base}_type`)) return `the row in the \`${base}_type\` table`
  }
  if (col.ref) return `the \`${singular(col.ref.split(".")[0])}\` it belongs to`
  return undefined
}
