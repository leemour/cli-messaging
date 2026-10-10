# Handoff — memo's mail into the store's mail tables (2026-10-11)

## 1. What this is

cli-memo (`/home/leemour/Projects/AI/cli-memo`, `WireCatLabs/cli-memo`) imports mail through Himalaya and stores
every email as an ordinary message of an `email` account: a thread is a chat, an attachment's text is a fake
message, and folders and coverage live in sync-state keys. This package
(`/home/leemour/Projects/AI/cli-messaging`) has dedicated mail tables (`email_threads`, `emails`,
`email_recipients`, `mailboxes`, `email_mailboxes`) behind `store.mail`, which nobody calls yet. Goal: memo
writes mail through `store.mail`, and every memo feature that reads mail (search, context, answers, tags,
knowledge) reads it from there. The owner decided this on 2026-10-11; old mail comes back by importing again,
nothing is migrated.

## 2. Orient in one call

```sh
{ M=/home/leemour/Projects/AI/cli-messaging; E=/home/leemour/Projects/AI/cli-memo
  git -C $M fetch -q; git -C $E fetch -q
  echo "== versions"; npm view @wirecat/cli-messaging version; git -C $E show origin/main:package.json | grep -E '"version"|cli-messaging"'
  echo "== store.mail: input, filter, API"; git -C $M show origin/main:src/store/sqlite/emails.ts | sed -n '20,50p;120,145p'
  echo "== mail tables"; git -C $M show origin/main:docs/storage/schema.md | sed -n '536,666p' | grep -E '^### |^\| `'
  echo "== what a link and a tag can point at"; git -C $M show origin/main:src/store/sqlite/things.ts | sed -n '12,28p'
  git -C $M show origin/main:src/store/sqlite/tags.ts | sed -n '12,16p'; git -C $M show origin/main:src/store/sqlite/knowledge.ts | sed -n '28,32p'
  echo "== searchAll's mail kind"; git -C $M show origin/main:src/services/search-all.ts | sed -n '70,100p'
  echo "== memo import"; git -C $E show origin/main:src/mail/import.ts | sed -n '115,125p;179,200p;205,216p'
  echo "== memo readers of mail"; git -C $E grep -n -E '"email"|provider === "email"|mail_coverage|mail_message_folders|mail_attachments' origin/main -- src | grep -v test
  echo "== coordination"; git -C $M show origin/main:docs/dev/COORDINATION.md | sed -n '13,30p'
} > ~/.cache/memo-mail-orient.txt 2>&1
```

Then read `~/.cache/memo-mail-orient.txt`. It shows: the published cli-messaging version and memo's pin; what
`store.mail` takes and returns (`EmailInput`, a `MailFilter` with only account, limit and offset, the six
methods); the mail tables and their columns; that `TABLES`, `TagTarget` and `KnowledgeTarget` have no `email`
type; how `searchAll` finds mail today (messages of email accounts); memo's import (members, attachment fake messages, folder scope and
`dropMissing`); every memo line that reads mail as messages; and the rule for
merging and releasing this package.

## 3. Read in this order (only if the orient output is not enough)

1. `cli-memo/src/mail/import.ts` (244 lines) — the whole write path you replace, including folder scope and the
   deletion proof (`dropMissing`, near line 210).
2. `cli-messaging/src/store/sqlite/emails.ts:133-460` — how `saveThread` resolves recipients to identities, adds
   mailboxes and indexes words; where a new filter or method goes.
3. `cli-memo/src/search/command.ts:55-135, 280-310` — the unified and `search mail` paths that must find mail in
   the new tables.
4. `cli-messaging/src/store/sqlite/attachments.ts:1-60` — attachments are written for `message` only; the
   schema already allows `attachable_type = 'email'`.
5. `cli-messaging/docs/dev/KNOWLEDGE.md` — which reference resolves to what, for links and tags to an email.

## 4. Do

Two repositories, in this order; one branch and pull request per step, off `origin/main`, in a worktree.

1. **cli-messaging: fill what memo needs from `store.mail`.**
   - Lookup: `MailFilter` gains what memo filters by — participant identity or address, thread external id,
     date range, mailbox — plus a list of an account's mailboxes.
   - Mailboxes: membership only grows today (`emails.ts:47`). Add a way to set an email's mailboxes for the
     folders one scan covered, or memo cannot prove a deletion.
   - Attachments: attachment rows with `attachable_type = 'email'` and their extracted text, instead of fake
     messages.
   - Search: mail found by `searchAll` and the Lucene query, and by stems (`email_stems` has no code yet);
     chunked for vectors if memo embeds mail today (`embedChanged`).
   - Links and tags: `email` (and the thread) in `TABLES`, `TagTarget` and `KnowledgeTarget`.

   Decision yours: how much of this is one pull request. The lean cut is lookup, mailboxes and attachments
   first (memo can then write), search second (memo can then read). A new column or table is migration 2 —
   "What bites" 1. Check: `pnpm lint && pnpm typecheck && pnpm test:coverage && pnpm docs:check && pnpm schema:check`.
   Release with `bin/release` after announcing in issue #849 — "What bites" 2.
2. **cli-memo: write mail through `store.mail`.** Pin the new cli-messaging. `importMail` builds an `EmailInput`
   per email and calls `saveThread` per thread; cc is included (the members list leaves it out today); folders
   become mailboxes; attachments become email attachments; the `mail_message_folders:*` and
   `mail_attachments:*` sync-state keys go. Keep `mail_folder_scope` and `mail_coverage` unless the store now
   answers them. Check: memo's full check from its `CLAUDE.md`.
3. **cli-memo: read mail from the mail tables.** Search (`unifiedSearch`, `search mail`, `search all`), person
   context ("no mail address linked"), answers' "email" evidence, tags on an email or a thread, and the
   shared-domain organization suggestions. Decision yours: memo keeps the `email` account row (the store keys
   mail by `account_id`) but writes no chats or messages for mail. Check: memo's full check, plus a test that
   imports a synthetic mailbox and reads it back through every command above.
4. **Release** each package after its pull request merges; the owner has allowed releases.

## 5. What bites

1. **The schema is frozen at version 1.** A column or table is migration 2: change `scripts/schema/spec.mjs`,
   then `pnpm schema:render` and `schema.ts`, until `pnpm schema:check` passes; `src/store/upgrade.test.ts` must
   keep passing. Never run `bin/regen-initial-migration`.
2. **Two sessions write to this package.** Before merging into `main` or releasing, read the latest comments
   on <https://github.com/WireCatLabs/cli-messaging/issues/849> and post one line there. Release only through
   `bin/release`, which holds a machine-wide lock; a hand-started `release.yml` skips it.
3. **One scan sees one folder.** That is why mailbox membership only grows; a removal must be limited to the
   folders the scan covered, or a mail in two folders drops out of one it is still in.
4. **The email rows of `involvements` are empty** until something writes `store.mail`; `contacts timeline`
   then shows mail with no extra work (`src/store/sqlite/involvement-queue.ts:45-57`).
5. **Pull requests run only a fast standards check.** Run each repository's full check yourself first.
6. **In zsh, never name a shell variable `path`** — it is `PATH`. Push a worktree branch with
   `git push origin HEAD:<branch>`: the sandbox can mask `.git/config`, so `-u` may not record the upstream.

## 6. Do not touch

- Real stores (`messages.db`, `wirecat.db`), the mail account's login and the keyring. Tests use temporary
  stores (`MESSAGING_STORE`) and a synthetic mailbox with invented people.
- tg-cli, max-cli, zoom-cli: no mail there.
- `docs/storage/schema.md` by hand: it is rendered from the spec.

## 7. Check

```sh
# cli-messaging worktree
pnpm install --frozen-lockfile && pnpm lint && pnpm typecheck && pnpm test:coverage && pnpm docs:check && pnpm schema:check
# cli-memo worktree
pnpm install --frozen-lockfile && <the full check from cli-memo's CLAUDE.md>
```
