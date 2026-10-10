import { createHash } from "node:crypto"
import { CliError } from "@wirecat/cli-core"
import {
  matches,
  TASK_KINDS,
  TASK_ORIGINS,
  TASK_STATES,
  type Task,
  type TaskFilter,
  type TaskStore,
} from "@wirecat/cli-tasks"
import type { CacheDatabase, SqlValue } from "../driver.js"
import { actorOfOrigin, originOfActor } from "./actors.js"
import { atomic } from "./atomic.js"
import { linkKind } from "./link-kinds.js"
import { taskRowOf, thingOf } from "./things.js"

export { taskIdOf, taskRowOf } from "./things.js"

export const TASK_VERDICTS = ["useful", "not_useful"] as const

/** `TaskStore` for `@wirecat/cli-tasks`, plus what the new task table adds: an answer and a verdict. */
export interface StoreTaskStore extends TaskStore {
  /** A question's answer: its text as the resolution, where it came from as an `answered-by` link. */
  answer(id: string, input: { resolution: string; by?: string }): Promise<void>
  /** The owner's judgement of a task an agent or a rule raised. */
  judge(id: string, verdict: (typeof TASK_VERDICTS)[number] | null): Promise<void>
  /** What the task package calls a task — its id, or a key like `IN1A2B3C4D-3` — as the row's `tasks.id`. */
  rowOf(id: string): number | undefined
}

const COLUMNS =
  "t.id AS row_id, t.package_id, t.source_locator, t.source_kind, t.source_group, t.type, t.status, t.close_reason, t.source, t.created_at, t.due_at, t.closed_at, " +
  "t.closed_by_type, t.closed_by_id, p.name AS account"

/** One inbox project per task account (`telegram:100`): derived from the account text alone, no `-` in it. */
export const inboxKey = (account: string): string =>
  `IN${createHash("sha256").update(account).digest("hex").slice(0, 8).toUpperCase()}`

/** The task account (`provider:account`) a task row belongs to: its inbox project's name. */
export const taskAccountOf = (database: CacheDatabase, rowId: number): string | undefined => {
  const row = database
    .prepare("SELECT p.key, p.name FROM tasks t JOIN projects p ON p.id = t.project_id WHERE t.id = ?")
    .get(rowId)
  // Only an inbox project speaks for an account: a project the owner named `telegram:500` does not.
  return row && String(row.key) === inboxKey(String(row.name)) ? String(row.name) : undefined
}

export const taskStoreOver = (database: CacheDatabase, now: () => number = Date.now): StoreTaskStore => {
  const inbox = (account: string, create: boolean): number | undefined => {
    const key = inboxKey(account)
    const found = database.prepare("SELECT id FROM projects WHERE key = ?").get(key)
    if (!create) return found ? Number(found.id) : undefined
    const [provider, external] = [account.slice(0, account.indexOf(":")), account.slice(account.indexOf(":") + 1)]
    const owning = database
      .prepare("SELECT id FROM accounts WHERE provider = ? AND external_id = ?")
      .get(provider, external)
    const accountId = owning ? Number(owning.id) : null
    // A task can arrive before its messenger saved the account; the project learns it on a later task.
    if (found) {
      if (accountId !== null)
        database
          .prepare("UPDATE projects SET account_id = ? WHERE id = ? AND account_id IS NULL")
          .run(accountId, Number(found.id))
      return Number(found.id)
    }
    const at = now()
    return Number(
      database
        .prepare(
          "INSERT INTO projects (key, name, description, type, account_id, scope, tasks_count, status, created_at, updated_at) " +
            "VALUES (?, ?, ?, 'personal', ?, 'personal', 0, 'active', ?, ?) RETURNING id",
        )
        .get(key, account, `What waits on the owner in ${account}`, accountId, at, at)?.id,
    )
  }
  const select = (where: string) =>
    database.prepare(`SELECT ${COLUMNS} FROM tasks t JOIN projects p ON p.id = t.project_id WHERE ${where}`)
  const toTask = (row: Record<string, unknown>): Task => {
    const task: Task = {
      id: String(row.package_id),
      source: String(row.source_locator),
      sourceKind: String(row.source_kind),
      account: String(row.account),
      group: String(row.source_group),
      kind: oneOf(TASK_KINDS, row.type, "kind"),
      state: oneOf(TASK_STATES, row.status, "state"),
      origin: oneOf(TASK_ORIGINS, row.source, "origin"),
      createdAt: new Date(Number(row.created_at)),
    }
    if (row.close_reason !== null) task.reason = String(row.close_reason)
    if (row.due_at !== null) task.dueAt = new Date(Number(row.due_at))
    if (row.closed_at !== null) task.closedAt = new Date(Number(row.closed_at))
    const closedBy = originOfActor(database, row.closed_by_type, row.closed_by_id)
    if (closedBy) task.closedBy = closedBy
    return task
  }
  const required = (id: string) => {
    const row = taskRowOf(database, id)
    if (row === undefined) throw new CliError("not_found", `no task ${id}`)
    return row
  }

  return {
    rowOf: (id) => taskRowOf(database, id),
    get: async (id) => {
      const row = taskRowOf(database, id)
      if (row === undefined) return undefined
      const found = select("t.id = ?").get(row)
      return found && toTask(found)
    },
    findBySource: async (account, source) => {
      const project = inbox(account, false)
      if (project === undefined) return []
      return select("t.project_id = ? AND t.source_locator = ? ORDER BY t.created_at, t.id")
        .all(project, source)
        .map(toTask)
    },
    insert: async (task) => {
      atomic(database, () => {
        const project = inbox(task.account, true) as number
        const counted = database
          .prepare(
            "UPDATE projects SET tasks_count = tasks_count + 1, updated_at = ? WHERE id = ? RETURNING key, tasks_count",
          )
          .get(now(), project)
        const number = Number(counted?.tasks_count)
        const author = actorOfOrigin(database, task.origin)
        const closedBy = task.closedBy ? actorOfOrigin(database, task.closedBy) : undefined
        database
          .prepare(
            "INSERT INTO tasks (project_id, number, key, title, type, status, due_at, closed_at, closed_by_type, closed_by_id, " +
              "close_reason, author_type, author_id, source, package_id, source_locator, source_kind, source_group, created_at, updated_at) " +
              "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          )
          .run(
            project,
            number,
            `${String(counted?.key)}-${number}`,
            `${task.kind} — ${task.source}`,
            task.kind,
            task.state,
            time(task.dueAt),
            time(task.closedAt),
            closedBy?.type ?? null,
            closedBy?.id ?? null,
            task.reason ?? null,
            author.type,
            author.id,
            task.origin,
            task.id,
            task.source,
            task.sourceKind,
            task.group,
            task.createdAt.getTime(),
            now(),
          )
      })
    },
    update: async (task) => {
      const row = taskRowOf(database, task.id)
      if (row === undefined) throw new CliError("not_found", `no task ${task.id}`)
      const closedBy = task.closedBy ? actorOfOrigin(database, task.closedBy) : undefined
      database
        .prepare(
          "UPDATE tasks SET status = ?, close_reason = ?, due_at = ?, closed_at = ?, closed_by_type = ?, closed_by_id = ?, " +
            "updated_at = ? WHERE id = ?",
        )
        .run(
          task.state,
          task.reason ?? null,
          time(task.dueAt),
          time(task.closedAt),
          closedBy?.type ?? null,
          closedBy?.id ?? null,
          now(),
          row,
        )
    },
    list: async (filter) => listTasks(filter, select, toTask, inbox),
    answer: async (id, { resolution, by }) => {
      const text = resolution.trim()
      if (!text || text.length > 2000) throw new CliError("validation_error", "an answer takes 1–2000 characters")
      const row = required(id)
      const at = now()
      atomic(database, () => {
        database.prepare("UPDATE tasks SET resolution = ?, updated_at = ? WHERE id = ?").run(text, at, row)
        if (!by) return
        database
          .prepare(`DELETE FROM links WHERE from_type = 'task' AND from_id = ? AND kind = ${linkKind("answered-by")}`)
          .run(row)
        // A message the store has not saved yet keeps its locator as the written target.
        const thing = thingOf(database, by)
        database
          .prepare(
            "INSERT INTO links (from_type, from_id, to_type, to_id, kind, source, target_text, confirmed, created_at, author, updated_at) " +
              `VALUES ('task', ?, ?, ?, ${linkKind("answered-by")}, 'owner', ?, 1, ?, 'rule', ?)`,
          )
          .run(row, thing?.type ?? null, thing?.id ?? null, thing ? null : by.slice(0, 500), at, at)
      })
    },
    judge: async (id, verdict) => {
      if (verdict !== null && !TASK_VERDICTS.includes(verdict))
        throw new CliError("validation_error", `a verdict is one of ${TASK_VERDICTS.join(", ")}`)
      database.prepare("UPDATE tasks SET verdict = ?, updated_at = ? WHERE id = ?").run(verdict, now(), required(id))
    },
  }
}

const listTasks = (
  filter: TaskFilter,
  select: (where: string) => ReturnType<CacheDatabase["prepare"]>,
  toTask: (row: Record<string, unknown>) => Task,
  inbox: (account: string, create: boolean) => number | undefined,
): Task[] => {
  const where: string[] = ["t.deleted_at IS NULL"]
  const values: SqlValue[] = []
  if (filter.account !== undefined) {
    const project = inbox(filter.account, false)
    if (project === undefined) return []
    where.push("t.project_id = ?")
    values.push(project)
  }
  if (filter.state !== undefined) {
    where.push("t.status = ?")
    values.push(filter.state)
  }
  if (filter.kind !== undefined) {
    where.push("t.type = ?")
    values.push(filter.kind)
  }
  if (filter.group !== undefined) {
    where.push("t.source_group = ?")
    values.push(filter.group)
  }
  if (filter.createdBefore) {
    where.push("t.created_at < ?")
    values.push(filter.createdBefore.getTime())
  }
  // matches() again: the SQL narrows, the package's own filter stays the definition.
  return select(`${where.join(" AND ")} ORDER BY t.created_at, t.id`)
    .all(...values)
    .map(toTask)
    .filter((task) => matches(task, filter))
}

const time = (date: Date | undefined): number | null => (date ? date.getTime() : null)

const oneOf = <T extends string>(values: readonly T[], value: unknown, column: string): T => {
  if (typeof value === "string" && (values as readonly string[]).includes(value)) return value as T
  throw new CliError("configuration_error", `the store holds a task with an unknown ${column} "${String(value)}"`)
}
