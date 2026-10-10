import { CliError } from "@wirecat/cli-core"
import type { CacheDatabase } from "../driver.js"

/** One SELECT per way of taking part: the subject's kind, the column that holds its id, and the query. */
const ARMS: [string, string, string][] = [
  [
    "message",
    "m.id",
    `
  SELECT il.person_id, m.sender_identity_id AS identity_id, 'message' AS subject_type, m.id AS subject_id,
    'sender' AS role, m.sent_at AS occurred_at, coalesce(c.scope,a.scope) AS scope, m.account_id, NULL AS project_id
    FROM messages m JOIN identity_links il ON il.identity_id=m.sender_identity_id
    JOIN chats c ON c.id=m.chat_id JOIN accounts a ON a.id=m.account_id WHERE m.deleted_at IS NULL
`,
  ],
  [
    "message",
    "m.id",
    `
  SELECT il.person_id, i.id, 'message', m.id, 'mentioned', m.sent_at, coalesce(c.scope,a.scope), m.account_id, NULL
    FROM messages m JOIN chats c ON c.id=m.chat_id JOIN accounts a ON a.id=m.account_id
    JOIN identities i ON i.provider=a.provider AND i.external_id IN (SELECT value FROM json_each(m.mentions))
    JOIN identity_links il ON il.identity_id=i.id WHERE m.deleted_at IS NULL
`,
  ],
  [
    "chat",
    "c.id",
    `
  SELECT il.person_id, cm.identity_id, 'chat', c.id, 'participant', cm.created_at,
    coalesce(c.scope,a.scope), c.account_id, NULL FROM chat_members cm
    JOIN identity_links il ON il.identity_id=cm.identity_id JOIN chats c ON c.id=cm.chat_id JOIN accounts a ON a.id=c.account_id WHERE 1
`,
  ],
  [
    "meeting",
    "m.id",
    `
  SELECT il.person_id, mp.identity_id, 'meeting', m.id, 'participant', coalesce(m.started_at,m.created_at),
    a.scope, m.account_id, NULL FROM meeting_participants mp JOIN identity_links il ON il.identity_id=mp.identity_id
    JOIN meetings m ON m.id=mp.meeting_id JOIN accounts a ON a.id=m.account_id WHERE m.deleted_at IS NULL
`,
  ],
  [
    "email",
    "e.id",
    `
  SELECT il.person_id, e.from_identity_id, 'email', e.id, 'sender', coalesce(e.sent_at,e.received_at,e.created_at),
    a.scope, e.account_id, NULL FROM emails e JOIN identity_links il ON il.identity_id=e.from_identity_id
    JOIN accounts a ON a.id=e.account_id WHERE e.deleted_at IS NULL
`,
  ],
  [
    "email",
    "e.id",
    `
  SELECT il.person_id, er.identity_id, 'email', e.id, 'recipient', coalesce(e.sent_at,e.received_at,e.created_at),
    a.scope, e.account_id, NULL FROM email_recipients er JOIN identity_links il ON il.identity_id=er.identity_id
    JOIN emails e ON e.id=er.email_id JOIN accounts a ON a.id=e.account_id WHERE e.deleted_at IS NULL
`,
  ],
  [
    "task",
    "t.id",
    `
  SELECT ta.assignee_id, NULL, 'task', t.id, 'assignee', t.created_at, coalesce(p.scope,'personal'),
    NULL, t.project_id FROM task_assignments ta JOIN tasks t ON t.id=ta.task_id JOIN projects p ON p.id=t.project_id
    WHERE ta.assignee_type='person' AND t.deleted_at IS NULL
`,
  ],
  [
    "task",
    "t.id",
    `
  SELECT t.author_id, NULL, 'task', t.id, 'author', t.created_at, coalesce(p.scope,'personal'), NULL, t.project_id
    FROM tasks t JOIN projects p ON p.id=t.project_id WHERE t.author_type='person' AND t.deleted_at IS NULL
`,
  ],
]

/** Links in both directions: what a link starts from is the subject, whichever end the person is. */
const linkArm = (linkFrom: string, linkTo: string) => `
  SELECT CASE WHEN l.to_type='person' THEN l.to_id ELSE il.person_id END AS person_id, CASE WHEN l.to_type='identity' THEN l.to_id END AS identity_id, l.from_type AS subject_type, l.from_id AS subject_id, coalesce(l.role,'linked') AS role, l.created_at AS occurred_at,
    coalesce(c.scope,a.scope,p.scope,'personal') AS scope, coalesce(m.account_id,c.account_id,e.account_id,mt.account_id,d.account_id) AS account_id, p.id AS project_id
    FROM (SELECT from_type,from_id,to_type,to_id,role,created_at,confirmed FROM links WHERE ${linkFrom}
      UNION ALL SELECT to_type,to_id,from_type,from_id,role,created_at,confirmed FROM links WHERE from_type IN ('person','identity') AND to_id IS NOT NULL AND ${linkTo}) l
    LEFT JOIN identity_links il ON l.to_type='identity' AND il.identity_id=l.to_id
    LEFT JOIN messages m ON l.from_type='message' AND m.id=l.from_id
    LEFT JOIN chats c ON c.id=CASE WHEN l.from_type='chat' THEN l.from_id ELSE m.chat_id END
    LEFT JOIN emails e ON l.from_type='email' AND e.id=l.from_id
    LEFT JOIN meetings mt ON l.from_type='meeting' AND mt.id=l.from_id
    LEFT JOIN documents d ON l.from_type='document' AND d.id=l.from_id
    LEFT JOIN tasks t ON l.from_type='task' AND t.id=l.from_id
    LEFT JOIN projects p ON p.id=CASE WHEN l.from_type='project' THEN l.from_id ELSE t.project_id END
    LEFT JOIN accounts a ON a.id=coalesce(m.account_id,c.account_id,e.account_id,mt.account_id,d.account_id)
    WHERE l.to_type IN ('person','identity') AND l.to_id IS NOT NULL AND l.confirmed=1 AND (l.from_type<>'message' OR m.deleted_at IS NULL) AND (l.from_type<>'email' OR e.deleted_at IS NULL) AND (l.from_type<>'meeting' OR mt.deleted_at IS NULL) AND (l.from_type<>'task' OR t.deleted_at IS NULL) AND (l.from_type<>'document' OR d.deleted_at IS NULL)
`

/** A thing whose rows are recomputed: its kind as `involvement_pending` names it, and its id. */
interface Subject {
  type: string
  id: number
}

/**
 * Every way of taking part, or only the ones about `subject`, each filtered by its own key so SQLite reads
 * that one row by index. The kind and id are checked before they are written into the SQL.
 */
/** Names the columns once: a UNION takes them from its first SELECT, and a subject's own arms may not lead. */
const COLUMNS =
  "SELECT NULL AS person_id, NULL AS identity_id, NULL AS subject_type, NULL AS subject_id, NULL AS role, " +
  "NULL AS occurred_at, NULL AS scope, NULL AS account_id, NULL AS project_id WHERE 0"

export const sourcesOf = (subject?: Subject): string => {
  if (subject === undefined) return [COLUMNS, ...ARMS.map(([, , sql]) => sql), linkArm("1", "1")].join(" UNION ")
  if (!/^[a-z_]+$/.test(subject.type) || !Number.isSafeInteger(subject.id))
    throw new CliError("configuration_error", `the involvement queue holds ${subject.type} ${subject.id}`)
  const { type, id } = subject
  return [
    COLUMNS,
    ...ARMS.filter(([of]) => of === type).map(([, key, sql]) => `${sql} AND ${key}=${id}`),
    linkArm(`from_type='${type}' AND from_id=${id}`, `to_type='${type}' AND to_id=${id}`),
  ].join(" UNION ")
}

export const INSERT =
  "INSERT INTO involvements (person_id, identity_id, subject_type, subject_id, role, occurred_at, scope, account_id, project_id, created_at)"

/** Most a write recomputes before it commits; a change larger than this, such as an account's scope, waits for the next write. */
export const QUEUE_CAP = 10_000

/**
 * Recomputes the queued things inside the caller's transaction, so a write leaves the index current when it
 * commits. Every write transaction calls it last (`inTransaction`, `atomic`, `inBatch`); reads never do.
 */
export const drainInvolvementQueue = (database: CacheDatabase, cap = QUEUE_CAP): number => {
  const batch = database.prepare("SELECT indexable_type AS type, id FROM involvement_pending LIMIT 500")
  const done = database.prepare("DELETE FROM involvement_pending WHERE indexable_type=? AND id=?")
  const drop = database.prepare("DELETE FROM involvements WHERE subject_type=? AND subject_id=?")
  const at = Date.now()
  let recomputed = 0
  while (recomputed < cap) {
    const subjects = batch.all().map((row) => ({ type: String(row.type), id: Number(row.id) }))
    if (subjects.length === 0) break
    for (const subject of subjects) {
      drop.run(subject.type, subject.id)
      database
        .prepare(`${INSERT} SELECT s.*, ? FROM (${sourcesOf(subject)}) s JOIN persons p ON p.id=s.person_id`)
        .run(at)
      done.run(subject.type, subject.id)
    }
    recomputed += subjects.length
  }
  return recomputed
}
