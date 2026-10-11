# Coordination between parallel sessions

Several sessions work on cli-messaging, tg-cli and max-cli at once. This page is what they share.

## Store migrations

**The next free migration version is 2.** Versions are the `version` field of `MANIFEST` in
`src/store/sqlite/manifest.ts`; the initial migration is 1. Take the next one by editing this line in a pull
request of its own, merged before the migration: the runner skips every version at or below the file's, so two
branches holding the same version would leave one migration unapplied on stores that ran the other.

Numbers from before the store rewrite (up to 29, including the one reserved for `feat/combined-search`) mean
nothing now.

## Releases

- **Announce before you merge into `main` or start a release** — in
  [issue #849](https://github.com/WireCatLabs/cli-messaging/issues/849), one line, after reading its latest
  comments and `gh run list --workflow release.yml`. Two sessions merge and release here, and on 2026-10-10
  one released 0.219.0 from a `main` one merge short of the other's work (owner's rule, 2026-10-11).
- Release only through `bin/release`: `gh workflow run release.yml` started by hand skips the lock below.
- Each session releases its own merged work: `git fetch`, `npm view`, a `chore: release` pull request
  that raises the version from what npm really has, then `bin/release`.
- `bin/release` in every repository takes one machine-wide lock (`$XDG_RUNTIME_DIR/leemour-release.lock`),
  so only one release of any package runs at a time on this machine. tg-cli and max-cli also refuse a
  release within two hours of their last one; cli-messaging has no such gap.
- To try an unreleased cli-messaging in tg-cli first, use `bin/try-messaging` in the tg worktree, never a
  committed `file:` path.

## Who owns what

Open pull requests are the source of truth for claimed work (`gh pr list` in each repository). A plan
for open work lives in `docs/dev/` beside this page; a plan whose work is merged is deleted.
