# Handoff — tg, max and memo onto cli-messaging 0.221.0, and lint inside worktrees (2026-10-11)

## 1. What this is

`@wirecat/cli-messaging` 0.221.0 is on npm: `store reset` (with `--no-backup`), log pruning on store open, and the
exported `ORGANIZATION_KINDS`, `PROJECT_TYPES` and `SCOPES`. tg-cli 0.45.0, max-cli 0.44.0 and cli-memo 0.6.0 still
pin 0.218.0. Separately, `biome.json` in tg-cli, max-cli, cli-memo, cli-tasks and community excludes
`!**/.worktrees`, which also matches a worktree's own path, so lint inside a worktree checks no file. The fix is
checked and sits uncommitted in a worktree of each repository. This work needs a session allowed to write in
those repositories; a session started from cli-meetings is not (its edit hook allows cli-meetings, cli-messaging
and cli-core only).

## 2. Orient in one call

```sh
{ A=/home/leemour/Projects/AI
  echo "== waiting lint fixes"; for r in tg-cli max-cli cli-memo cli-tasks community; do w=$A/$r/.worktrees/lint-from-worktrees
    echo "-- $r: $(git -C $w branch --show-current) upstream=$(git -C $w rev-parse --abbrev-ref @{u} 2>/dev/null)"; git -C $w diff --stat; done
  echo "== the script that writes the bad pattern"; sed -n '52,60p' $A/community/.worktrees/lint-from-worktrees/scripts/adopt-standards.py
  echo "== pins"; for r in tg-cli max-cli cli-memo; do git -C $A/$r fetch -q
    echo "$r: $(git -C $A/$r show origin/main:package.json | grep -E '"version"|cli-messaging"' | tr -d ' \n')"; done
  npm view @wirecat/cli-messaging version
  echo "== what 0.219.0-0.221.0 change for callers"; git -C $A/cli-messaging fetch -q --tags
  git -C $A/cli-messaging show v0.221.0:CHANGELOG.md | sed -n '/^## 0.221.0/,/^## 0.218.0/p' | grep -E '^##|^- \*\*|^- `'
  echo "== memo's copies of the store's lists"; git -C $A/cli-memo show origin/main:src/knowledge/command.ts | sed -n '59,60p;94,96p'
  echo "== parity rows still planned for this bump"; git -C $A/cli-messaging show origin/main:parity.json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const p=JSON.parse(s);for(const[k,v]of Object.entries(p.commands)){const d=w=>Object.values(w?.planned??{}).some(n=>n.includes("next cli-messaging bump"));if(d(v))console.log(k);for(const[o,w]of Object.entries(v.options??{}))if(d(w))console.log(k,o)}})'
} > ~/.cache/consumers-0221-orient.txt 2>&1
```

Then read `~/.cache/consumers-0221-orient.txt`. It shows: each waiting lint fix (branch, upstream, the one-line
diff); the two lines in community's `adopt-standards.py` that put the pattern back; each CLI's version and pin;
what 0.219.0 to 0.221.0 change for callers; memo's hard-coded copies of the three lists; and the parity rows the
bump completes.

## 3. Read in this order (only if the orient output is not enough)

1. `<repo>/CLAUDE.md` of each repository you touch — its full check and release rules.
2. `cli-messaging/CHANGELOG.md` sections 0.219.0 to 0.221.0 — every change the bump brings.
3. `community/scripts/adopt-standards.py:50-60` — where the pattern is written for every adopting repository.

## 4. Do

1. **Commit the lint fixes.** In each `<repo>/.worktrees/lint-from-worktrees` the only change is
   `"!**/.worktrees"` → `"!.worktrees"` in `biome.json`. Commit (community needs `git commit -s`), run the
   repository's full check from that worktree (lint must now report files, not 0), push with
   `git push origin HEAD:fix/lint-from-worktrees`, open a pull request, merge when green. In community also change
   `adopt-standards.py` lines 53 and 58 to write `!.worktrees` and to replace an existing `!**/.worktrees` in place,
   or the next adopt run brings the bug back. No changelog line: callers see nothing.
2. **tg-cli and max-cli onto 0.221.0, together.** Exact pin `@wirecat/cli-messaging` 0.221.0, `pnpm install`, the
   full check, regenerated docs (`pnpm generate` where it exists), a changelog line: `store reset` (with
   `--no-backup`) is available, and the store prunes old logs on open (agent calls after 90 days, handled
   bot-update payloads after 30). Check: each repository's full check, and `parity:check` exit 0.
3. **cli-memo onto 0.221.0, with the store's lists.** Same pin; replace the hard-coded help text at
   `src/knowledge/command.ts:59-60, 94-96` with `ORGANIZATION_KINDS`, `PROJECT_TYPES` and `SCOPES` from
   `@wirecat/cli-messaging/store` (joined for help, and used to validate). Changelog line. Check: memo's full check.
4. **Release** tg-cli, max-cli and cli-memo through each repository's `bin/release`, after their pull requests
   merge; the owner has allowed releases. memo goes out after tg and max: it must not prune a store its
   messengers' older builds still use.
5. **The parity rows.** Once tg and max `main` both have `store reset` and `--no-backup`, the `planned` marks in
   cli-messaging's `parity.json` go (one pull request there, announced in issue #849; see "What bites" 2).

Decision yours: whether the lint fix and the bump share one pull request per repository. Lean: separate, so
the bump can be reverted alone.

## 5. What bites

1. **The lint-fix branches track `origin/main`.** A plain `git push` could go to `main`. Always push with an
   explicit `HEAD:<branch>`.
2. **cli-messaging has two writers.** Before merging into its `main` or releasing it, read the latest comments
   on <https://github.com/WireCatLabs/cli-messaging/issues/849> and post one line there.
3. **Log pruning is new behaviour on the owner's data.** From 0.219.0, opening the store deletes agent-call rows
   older than 90 days and empties handled bot-update payloads older than 30 days. All three CLIs share one
   store, so they move to 0.221.0 in the same release window.
4. **Pull requests run only a fast standards check**; run each full check yourself. tg-cli and max-cli refuse a
   release within two hours of their last one (`bin/release`).
5. **The main checkouts are stale** (tg-cli's has an unresolved conflict in `CLEANUP.md`): work only in worktrees
   off `origin/main`, never in the main checkouts.
6. **In zsh, never name a shell variable `path`** — it is `PATH`.

## 6. Do not touch

- Real stores (`messages.db`, `wirecat.db`), logins and the keyring.
- cli-messaging's code: only the `parity.json` rows in step 5.
- zoom-cli: it is on cli-messaging 0.219.0 and needs nothing from 0.220.0 or 0.221.0.

## 7. Check

```sh
cd <worktree> && pnpm install --frozen-lockfile && <the full check from the repository's CLAUDE.md>
```
