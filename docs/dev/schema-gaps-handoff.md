# Handoff — the store's tables nobody uses yet (2026-10-11)

## 1. What this is

The store (`wirecat.db`, schema version 1, [`docs/storage/schema.md`](../storage/schema.md)) was designed ahead of
its callers. Some of it is filled and read by tg-cli, max-cli, cli-memo, cli-tasks and zoom-cli; the parts below
have a store API and no caller, or a table and no API. Each section is one independent job: pick one, ship it,
leave the rest. Two neighbours have their own handoffs and are not repeated here: mail
([memo-mail-handoff.md](memo-mail-handoff.md)) and meetings in `search all` (branch `feat/search-all-meetings`
while open).

## 2. Orient in one call

```sh
{ M=/home/leemour/Projects/AI/cli-messaging; git -C $M fetch -q
  echo "== the sub-stores"; git -C $M show origin/main:src/store/store.ts | sed -n '586,604p'
  echo "== who calls each (outside tests)"
  for api in botUpdates decisions memories proposedActions 'agentActions.list'; do
    printf '%s: ' "$api"; git -C $M grep -l "\.$api" origin/main -- src | grep -v -E '\.test\.|store\.ts' | tr '\n' ' '; echo; done
  echo "== tasks: the port vs the table"; git -C $M show origin/main:src/store/sqlite/tasks.ts | sed -n '22,28p'
  git -C $M show origin/main:docs/storage/schema.md | sed -n '1136,1310p' | grep -E '^### |^\| `'
  echo "== chunk kinds written"; git -C $M grep -n -E "kind: \"|source_type|chunkable" origin/main -- src/store/sqlite/note-index.ts src/store/sqlite/vectors.ts | head -12
  echo "== bot watch"; git -C $M show origin/main:src/cli/bot/watch.ts | sed -n '95,130p'
  echo "== coordination"; git -C $M show origin/main:docs/dev/COORDINATION.md | sed -n '13,30p'
} > ~/.cache/schema-gaps-orient.txt 2>&1
```

Then read `~/.cache/schema-gaps-orient.txt`. It shows: the store's sub-stores; which of the unused ones have any
caller; what the task port exposes against the task tables' columns; which kinds of text get chunked for search
by meaning; where `bot watch` takes deliveries; and the rule for merging and releasing this package.

## 3. Read in this order (only for the job you picked)

1. Tasks — `src/store/sqlite/tasks.ts` (247 lines) and `@wirecat/cli-tasks` `src/store.ts` / `src/model.ts`:
   what the port carries, and which task columns no method writes.
2. Bot updates — `src/store/sqlite/bot-updates.ts` (91 lines) and `src/cli/bot/watch.ts`: the store's
   save/handled/failed/replayed calls and the loop that should make them.
3. Memories, decisions, proposed actions — `src/store/sqlite/memories.ts:55`, `decisions.ts:41`,
   `proposed-actions.ts:46`: each interface, and its section in `docs/storage/schema.md` (memories ~859,
   decisions ~1255, proposed actions ~1281).
4. Search coverage — `src/store/sqlite/note-index.ts:23-50` and `src/store/sqlite/vectors.ts`: how a kind gets
   chunks and stems; `docs/storage/schema.md` "Chunks, embeddings and search state" (~1429).
5. Agent log — `src/store/sqlite/agent-actions.ts:38` and `src/mcp/server.ts:109-114`: what is recorded per call.

## 4. Do (one job per pull request)

1. **Tasks beyond the four message kinds.** Nothing writes `task_events` or `task_assignments`, sets `priority`
   or `parent_id`, creates `bug` / `feature` / `chore` tasks, or reads a `verdict` back. The port
   (`@wirecat/cli-tasks` 0.3.0) knows only question, request, mention and promise. Decision yours, with the
   owner: which caller needs which field first — the lean start is types and assignees on the port plus a
   `tasks add --type --assignee` command, and nothing else until something reads it. A port change is a
   cli-tasks minor release first, then this package takes it.
2. **Bot updates.** `bot watch` takes deliveries but never calls `store.botUpdates`, so the table is empty and a
   redelivery after a restart is not recognised. Record each update (`save`), mark it `handled` or `failed`, and
   skip one already handled. Log pruning (30 days for handled payloads) then has something to prune. Check: a
   test that feeds the same update twice through `watch` and handles it once.
   *Done in `feat/bot-watch-updates`; tg-cli still has to fill the id — [bot-update-ids-handoff.md](bot-update-ids-handoff.md).*
3. **Reading the agent log.** `agent_actions` gets a row per MCP call and nothing reads it. Decision yours, with
   the owner: a command (`store agents` or under `mcp`) and/or a read-only MCP tool; parity marks for tg and max.
4. **Memories, decisions, proposed actions.** Tables and APIs exist; no command, no MCP tool, no consumer. Each
   needs an owner decision before code: who writes a memory (an agent through MCP?), who records a decision,
   and whether an agent may propose an action that the owner approves later. Bring the three questions to the
   owner with a recommendation; build only what is answered.
5. **Search coverage.** Chunks exist for conversations, documents, notes and memories only; attachments,
   meeting transcripts, events and tasks get none, and `meeting_stems` / `memory_stems` have no code (email is
   in the mail handoff). Decision yours: one kind per pull request, meeting transcripts first (zoom-cli already
   fills them).
6. **Links and tags to a meeting.** `TABLES` (`src/store/sqlite/things.ts:14-28`), `TagTarget` and
   `KnowledgeTarget` have no `meeting`; add it with a resolver test. Email is in the mail handoff.
   *Done in `feat/meeting-link-targets`: links already resolved `meeting:` references; annotations and
   tags now take a meeting. `TagTarget` stays the messenger's chat/contact/message tags.*

## 5. What bites

1. **The schema is frozen at version 1.** A column or table is migration 2: change `scripts/schema/spec.mjs`,
   then `pnpm schema:render` and `schema.ts`, until `pnpm schema:check` passes; `src/store/upgrade.test.ts` must
   keep passing. Never run `bin/regen-initial-migration`. None of the jobs above should need one.
2. **Two sessions write to this package.** Before merging into `main` or releasing, read the latest comments on
   <https://github.com/WireCatLabs/cli-messaging/issues/849> and post one line there. Release only through
   `bin/release`.
3. **A new command or option is a parity row.** Mark it `planned` for tg and max ("each CLI's next
   cli-messaging bump") with a catalogue meaning, run `pnpm parity:render`; the Parity workflow runs on the pull
   request.
4. **Pull requests run only a fast standards check.** Run the full check yourself first.
5. **In zsh, never name a shell variable `path`** — it is `PATH`. Push a worktree branch with
   `git push origin HEAD:<branch>`.

## 6. Do not touch

- Mail tables and memo's mail: [memo-mail-handoff.md](memo-mail-handoff.md).
- `search all --meetings`: its own branch while open.
- Real stores, logins and the keyring; tests use temporary stores (`MESSAGING_STORE`) and invented people.

## 7. Check

```sh
pnpm install --frozen-lockfile && pnpm lint && pnpm typecheck && pnpm test:coverage && pnpm docs:check && pnpm schema:check
```
