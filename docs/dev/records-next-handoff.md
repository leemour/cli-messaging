# Handoff — decisions, task fields and meeting notes in memo (2026-10-11)

Supersedes [schema-gaps-handoff.md](schema-gaps-handoff.md) for everything still open.

## 1. What this is

The shared store (`wirecat.db`, [docs/storage/schema.md](../storage/schema.md)) has tables nobody used.
Memories, proposed actions and the agent log now have commands in `memo` (cli-memo) and tools in `memo mcp`.
What belongs to no messenger lives in memo, never in tg or max (owner's rule). Three jobs remain, each one
pull request in cli-messaging (store side, if needed) and one in cli-memo (commands and MCP tools).

## 2. Orient in one call

```sh
{ M=/home/leemour/Projects/AI/cli-messaging C=/home/leemour/Projects/AI/cli-memo T=/home/leemour/Projects/AI/cli-tasks
  for r in $M $C $T; do git -C $r fetch -q; done
  echo "== decisions store"; git -C $M show origin/main:src/store/sqlite/decisions.ts | sed -n '10,50p'
  echo "== store exports"; git -C $M show origin/main:src/store/index.ts | grep -n 'decisions.js\|memories.js\|proposed-actions.js'
  echo "== memo mcp: the tool shape and one write tool"; git -C $C show origin/main:src/mcp/server.ts | sed -n '24,55p'
  echo "== memo memories: the command to copy"; git -C $C show origin/main:src/memories/memories.ts
  echo "== task port"; git -C $T show origin/main:src/model.ts | sed -n '1,32p'; git -C $T show origin/main:src/service.ts | sed -n '1,12p'
  echo "== tasks table"; git -C $M show origin/main:docs/storage/schema.md | sed -n '1197,1266p' | grep -E '^### |^\| `'
  echo "== memo notes --about"; git -C $C show origin/main:src/notes/command.ts | sed -n '178,215p'
} > ~/.cache/records-next-orient.txt 2>&1
```

Then read `~/.cache/records-next-orient.txt`. It shows: the decisions store and what `./store` exports; how a
memo MCP tool is defined (copy it for decisions); the memories helper that sets "owner confirmed, agent
proposed"; the cli-tasks port and the task columns no method writes; and where `memo notes add --about` parses
its subject.

## 3. Read in this order (only if the orient output is not enough)

1. `cli-memo/src/memories/command.ts` — the command layout `memo decisions` copies, option by option.
2. `cli-memo/src/records/command.test.ts` — how a memo command is tested against a temporary store.
3. `cli-messaging/src/store/sqlite/tasks.ts:121-180` — how a port task becomes a `tasks` row; where a new
   field would be written.
4. `cli-messaging/src/services/proposal-tasks.ts` — the one caller that makes a task from something that is not
   a message; the pattern a source-less owner task follows.
5. `cli-memo/src/tags/command.ts`, `targetOptions` and `mutate` — how `--meeting <id> --provider --account`
   selects a meeting, for the notes job.

## 4. Do

1. **`memo decisions`, for the owner and for agents** (owner's call: agents may record them too). Commands
   `memo decisions add|list|show|accept|reverse`; MCP tools `decisions_add`, `decisions_list`,
   `decisions_show` in `memo mcp`. The store already does the rule: the owner's decision is accepted at once,
   an agent's (`{ bot: "memo-mcp" }`) waits as proposed; only the owner accepts or reverses, so those stay
   command-only. Store side: export `DECISION_STATUSES` from `./store` (memo offers it as `--status` choices),
   a one-line cli-messaging pull request and release first. Check: a memo test that an MCP `decisions_add` is
   `proposed` and authored by the bot, `memo decisions accept` makes it `accepted`, and a superseding decision
   ends the older one.
2. **Task fields beyond the four message kinds** (owner's call: types, assignees, priority, parent and the
   rest, now). Columns that exist and nothing writes: `tasks.type` values `bug|feature|chore`, `priority`
   (0 urgent … 4 low), `parent_id`, `description`, `task_assignments` (assignee, reviewer, watcher),
   `task_events` (created, status, assigned, due, priority, moved), `verdict` read back. Order: the cli-tasks
   port (`Task`, `NewTask`, `TaskStore`) gains the fields — a cli-tasks minor release; then cli-messaging's
   `StoreTaskStore` writes and reads them and records a `task_events` row per change; then
   `memo tasks add|update|assign` takes them. Decisions yours: (a) a bug or feature has no message source —
   lean to a task with a title and `source: "owner"` in the owner's project, not an account inbox, because a
   bug belongs to a project; (b) whether `memo tasks add` keeps its `<source>` argument and adds `--title`, or a
   separate `memo tasks create`. Ask the owner for the command wording before writing it (STANDARD.md "Before
   creating a command"). Check: a store test per field round-trip, and one `task_events` row per change.
3. **`memo notes add --about` takes a meeting by id.** It needs `meeting:<account id>/<meeting id>`, and
   no command prints the account's store id. Add `--meeting <id>` with `--provider`/`--account` beside
   `--about`, resolved the way `memo tags` does it, to the same `meeting:` reference. Check: the existing
   meeting test in `cli-memo/src/tags/command.test.ts` extended to add the note with `--meeting`.
4. **Try `memo mcp` from a real agent.** Run `memo mcp` from a Claude Code MCP config
   (`{ "command": "memo", "args": ["mcp"] }`) against a store copied to a temporary path
   (`MESSAGING_STORE=<copy>`), add one memory and one proposal, and check both appear in `memo agents log`.
   Nothing to merge; report what broke.

## 5. What bites

1. **memo pins the exact cli-messaging version tg and max pin** (cli-memo `CLAUDE.md`, rule 4). A store change
   ships only after tg-cli and max-cli move to that release. Batch every store change a job needs into one
   cli-messaging release, then post in [issue #849](https://github.com/WireCatLabs/cli-messaging/issues/849).
2. **Two or more sessions merge and release cli-messaging.** Before merging or releasing, read the latest
   #849 comments and post one line. Release only with `bin/release`. A rebase can drop your CHANGELOG entry into a
   section already released: check that it sits under `## Unreleased` after every rebase. `pnpm docs:check`
   allows only Added, "Changed — may break callers", Fixed, Security and Removed as headings.
3. **cli-messaging code reaches the store only through `src/store/store.ts`** (a lint fence since #917).
4. **No unknown reference may break a listing.** A new reference type (a decision on a meeting, a task made
   from a proposal) once made every annotation listing throw; when a list maps a stored pointer back to a
   reference, test it with the new type present.
5. **pnpm re-sorts `devDependencies`** on `pnpm add`. Edit `package.json` by hand and run `pnpm install`.
6. **In zsh a glob that matches nothing aborts the whole command**, including an `rm` after it; never name a
   shell variable `path`. Push a worktree branch with `git push origin HEAD:<branch>`.

## 6. Do not touch

- **Meeting word search (`meeting_stems`) and meeting search** — Codex root owns them
  ([#849](https://github.com/WireCatLabs/cli-messaging/issues/849), 03:13 UTC).
- **Mail tables and memo's mail import** — the memo-mail session's
  ([memo-mail-handoff.md](memo-mail-handoff.md)).
- **tg-cli and max-cli releases** — the release sessions do them; ask in #849 for a dependency bump.
- **Real stores, logins and the keyring.** Tests use temporary stores (`MESSAGING_STORE`) and invented people.

## 7. Check

```sh
# cli-messaging
pnpm install --frozen-lockfile && pnpm lint && pnpm typecheck && pnpm test:coverage && pnpm docs:check && pnpm schema:check
# cli-memo
pnpm install --frozen-lockfile && pnpm lint && pnpm typecheck && pnpm test:coverage && pnpm docs:lint && pnpm docs:spell
# cli-tasks
pnpm install --frozen-lockfile && pnpm lint && pnpm typecheck && pnpm test
```
