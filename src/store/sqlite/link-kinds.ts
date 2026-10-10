/**
 * Every kind a `links` row may have. The schema doc's description of `links` names exactly these
 * (`schema.test.ts` checks it); a writer that needs a new kind adds it here first.
 */
export const LINK_KINDS = [
  "links-to",
  "about",
  "member-of",
  "labelled",
  "answered-by",
  "evidence",
  "created-from",
  "duplicate-of",
  "related-to",
  "assigned-to",
] as const

export type LinkKind = (typeof LINK_KINDS)[number]

/** The kinds `knowledge.relate` makes between people, organizations and projects. */
export const RELATION_KINDS = ["member-of", "related-to", "assigned-to"] as const satisfies readonly LinkKind[]

/** A kind as an SQL literal, so a kind written into a query is checked against the list. */
export const linkKind = (kind: LinkKind): string => `'${kind}'`
