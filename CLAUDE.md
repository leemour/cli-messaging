# cli-messaging — working rules

The messenger-neutral half of tg-cli and max-cli, published as `@wirecat/cli-messaging`. Start with
the one page that covers what you are about to touch:

- [`docs/dev/ARCHITECTURE.md`](docs/dev/ARCHITECTURE.md) — the modules, the store and its migrations,
  the command skeleton, who consumes it.
- [`docs/dev/CONVENTIONS.md`](docs/dev/CONVENTIONS.md) — max-cli's conventions, and what differs here.
- [`docs/dev/TESTING.md`](docs/dev/TESTING.md) — the sandbox, the coverage floor, no real waits.
- [`docs/dev/BACKLOG.md`](docs/dev/BACKLOG.md) — open work; [`docs/dev/COORDINATION.md`](docs/dev/COORDINATION.md) — migration numbers and releases across sessions.

## The constraints that shape everything

1. **Nothing here knows a messenger.** No provider library, no adapter; `biome.json` refuses them.
2. **The store is the owner's system of record.** Migrations are forward-only and cannot be undone.
   No test and no branch build may open the real file — `MESSAGING_STORE` points elsewhere.
3. **Other sessions work here at the same time.** Work in a worktree off `origin/main`, rebase before
   pushing, and take a migration number in [COORDINATION.md](docs/dev/COORDINATION.md#store-migrations) before writing it.
4. **A change reaches tg-cli and max-cli only through a release.** Both pin an exact version.
5. **Release when a consumer needs the merged code; there is no fixed gap between releases** —
   [README, "How often, and what may break"](README.md#how-often-and-what-may-break).
   `bin/release` publishes the next free version through GitHub; stable-export breaks still
   follow the README policy.

## Comments

Sparse, and only *why*. No comment restating the line, no banners, no narrating the change.

## Documents

They state the current facts only: rewrite a changed fact, delete a finished plan or done backlog
item; the changelog keeps history ([`CONVENTIONS.md`](docs/dev/CONVENTIONS.md)).

## Deletions

Never delete or clean up mid-task. Append a line to `CLEANUP.md` at the root — the path, why, the
date — and do the removals in one batch after the owner confirms. Never kill a process by name — find the PID, confirm it is yours, kill that PID.

## Committing

Conventional commits. Before committing:

```sh
pnpm standards:check && pnpm lint
```

A branch off `main`, in a worktree, and a pull request. A user-visible change gets a line under
`## Unreleased` in [`CHANGELOG.md`](CHANGELOG.md). `bin/release` publishes; when the version is
already taken it moves to the next free one and renames the changelog heading with it.

## Development check budget

Keep commit and push hooks fast. Ordinary development and PRs use standards
verification, lint, Markdown, and secret detection. Full typechecking, tests,
coverage, builds, parity, browser and platform suites run for releases or an
explicit manual validation. See the
[shared policy](https://github.com/WireCatLabs/community/blob/main/standards/README.md#ci-and-hooks).
