# Messaging platform: cli-messaging + tg-cli — proposal

**Status 2026-09-26: reviewed, nothing built.** Owner's answers: NEED-1 → A (one store),
NEED-2 → A (max-cli untouched until Phase 4) **with a generous extraction** — "better to extract
more and override it in the adapters, so there is a proper skeleton" (§1a), NEED-3 → B (every user
registers their own `api_id`, §5).
Answers the brief's §17 (reuse map, extraction map, Telegram adapter, package boundaries, phases,
risks, spike) and adds one section the brief asked for later in the conversation: a store that is
ready for contact linking and cross-messenger context (a CRM) without building the CRM now.

Evidence levels, as in max-cli: **read in the source** (a `path:line`), **the docs describe** (not
run), **inferred** (hedged). Nothing here was run against Telegram yet.

---

## 0. The criterion everything is checked against

> After Telegram, a third messenger costs less — and neither MAX nor Telegram loses a feature to a
> lowest-common-denominator API.

Three consequences:

1. **A skeleton with hooks, a domain without guesses.** The *program* — flags, settings, profiles,
   output, run records, guard, the command set, MCP, the background process — moves into
   `cli-messaging` generously, and an adapter overrides what does not fit (owner, NEED-2). The
   *domain model* stays strict: a field goes into the shared types only when MAX and Telegram both
   have it; everything else travels as `providerMetadata`. A MAX habit found in the skeleton becomes
   a hook, never a default Telegram has to fight.
2. **The local store is a system of record, not a cache.** A backfilled group, a link between two
   identities, a note on a person — none of these can be fetched again. This is the single biggest
   difference from max-cli, and it changes the schema, the migration strategy and the file location
   (§4).
3. **The CRM is a schema property, not a feature.** Every message points at a sender identity, every
   identity points at a person, and every message has a stable locator. Notes, tags, follow-ups and
   "what did this person promise" become additive tables later. No CRM command ships now.

---

## 1. Reuse map

### From `@leemour/cli-core` — as is

Everything: streams, renderer (`pretty`/`json`/`jsonl`), closed error codes and exit codes,
keyring and `Credentials`, config loading, paths, logging with redaction, retry, clocks,
`/commands` (introspection), `/completion`, `/update`, `/testing`.

- **`paths.state` is already the XDG *data* directory** (`cli-core/src/paths.ts:35`,
  `state: … ?? base.data`). So the store needs no cli-core change to live outside the cache dir.
- braze-cli is represented by cli-core; nothing further is taken from it.

### From max-cli — copied into `cli-messaging` and generalised

max-cli already drew this line: rule `CLI-30` (ruling `NEED-147`, `ASK-24`) forbids
`src/domain/models.ts`, `src/cache/**`, `src/rendering/**`, `src/resolve.ts` from importing
anything MAX, "so the package is a move, not an untangling"
(`max-cli/docs/dev/ARCHITECTURE.md:48-53`). The plan is to **copy** those files, not move them —
max-cli stays untouched until the Telegram slice works (§8, Phase 4).

| max-cli file | In cli-messaging | Change needed |
|---|---|---|
| `src/domain/models.ts` | `domain/` | add provider, account, locator, identity, thread; drop `timeOfMessageId` (DEBT-1) |
| `src/cache/driver.ts`, `open.ts`, `drivers/*` | `store/driver` | none — the Node/Bun SQLite seam is exactly what a third runtime-agnostic user needs |
| `src/cache/schema.ts` | `store/schema` | **rewritten**, not copied (DEBT-2–DEBT-5). The FTS5-with-triggers pattern and the "ranges mean completeness" idea carry over |
| `src/cache/store.ts` | `store/` repositories | pattern carries (upsert with `coalesce`, membership deleted per chat only); SQL rewritten for composite keys |
| `src/rendering/messages.ts` | `render/` | none expected |
| `src/resolve.ts` | `resolve/` | none; `isId` already accepts `-100…` (`src/resolve.ts:5`). Add `@username` |
| `src/sends/guard.ts`, `journal.ts`, `permissions.ts`, `recipients.ts` | `guard/` | `cid?: number` → `sendId: string` (DEBT-7); drop the `Settings` import for a narrow options type; MAX-only `ChatAction` values become adapter-declared |
### 1a. The skeleton — also copied, generously (owner, NEED-2)

Measured 2026-09-26 by counting references to the MAX client, protocol, session or `MAX` names per
file. Three kinds of move:

**As is** — no MAX reference: `src/export.ts`, `src/deadline.ts`, `src/profile.ts` (profile as the
first word), `src/runs/run.ts`, `src/runs/recording.ts`, `src/report.ts`, `src/markdown.ts`,
`src/session/prompt.ts` (hidden input), `src/session/qr-terminal.ts`, `src/server/subscribe.ts`,
`src/transcribe/models.ts`, `src/commands/paging.ts`, `src/output.ts`.

**With a parameter** — one or two MAX names (the app name, the env prefix, a client type):
`src/program.ts` (root command, global flags, `run()` that never throws, the last catch),
`src/update.ts`, `src/server/lines.ts`, `src/transcribe/*` (voice notes are Ogg/Opus in Telegram
too), `src/mcp/confirm.ts` (send confirmation from the MCP server), `src/mcp/instructions.ts`,
`src/commands/watch.ts`, `src/commands/inbox.ts`.

**As a skeleton with hooks** — the shape is generic, the body knows MAX:

| max-cli | Generic part in cli-messaging | What the adapter supplies |
|---|---|---|
| `src/config.ts` (564 lines) | flag → env → file → default, strict schema, `config show\|set` | its own fields, added to the schema |
| `src/commands/context.ts` | building renderer, deadline, run record, guard, store, adapter for a command | the adapter factory |
| `src/commands/*` | `session start\|end`, `account show`, `chats list\|show`, `messages list\|show\|context\|send\|reply\|search\|export`, `contacts list\|show`, `watch`, `doctor`, `commands`, `complete`, `config`, `runs`, `sends`, `recipients`, `update`, `skill`, `mcp`, `serve` | login methods; extra commands (MAX folders, Telegram topics); a replacement for any generic command by name |
| `src/server/server.ts`, `server-connection.ts`, `start.ts` | the background process: local socket, start/stop/status, forwarding writes through the guard, pushing events to subscribers | the connection it owns and its update stream |
| `src/mcp/server.ts`, `session.ts`, `tools.ts`, `resources.ts`, `prompts.ts` | MCP server, idle-drop session, the read/search/send tools, confirmation | extra tools |
| `src/diagnose.ts`, `src/commands/doctor.ts` | generic checks: paths, keyring, store, versions | provider checks |
| `src/runs/events.ts` | the event shape and the "never a message body" rule | which ids an event names |
| `src/download.ts`, `src/upload.ts` | writing a file safely, sizes, names | fetching the bytes |

The price, said once: the skeleton is shaped from one implementation until Telegram runs on it.
That is why Telegram is built **on** it in Phase 1, not after it — every hook the Telegram adapter
needs is found while the skeleton is still new.

### From max-cli — code stays in max-cli

| max-cli | Why |
|---|---|
| `src/client.ts` (2655 lines) | the MAX adapter. Its **shape** (`account`, `chats`, `contacts`, `messages`, `live`) is the template for the adapter port |
| `src/protocol/`, `src/spec/`, `src/generated/`, `src/session/` (but the two files above), `src/domain/map.ts` | the MAX transport and mapping |
| MAX-only commands: folders, group admin, scheduled messages, account sessions, contact import | one implementation; they plug in through the adapter's extra commands |

## 2. Extraction map: where MAX leaked into "generic" code

Each of these is inside the `CLI-30` boundary and would break Telegram if copied as is.

| id | Leak | Where | Fix in cli-messaging |
|---|---|---|---|
| DEBT-1 | "a message id holds its send time (`id >> 16`)" — a MAX property | `src/domain/models.ts:267`, duplicated at `src/client.ts:2401` | stays in the MAX adapter |
| DEBT-2 | `messages_by_id` finds a message by id "without knowing which chat" | `src/cache/schema.ts:97` | ids are unique only per chat (Telegram channels) or per account (Telegram private chats); every key is composite |
| DEBT-3 | `sync_marker` — one row, MAX's login delta | `src/cache/schema.ts:73-76` | `sync_state (account, key, value)` — per account, per provider |
| DEBT-4 | the store is one file per profile, in the **cache** dir | `src/cache/index.ts:30` | one store per user, in the data dir, holding every account and provider |
| DEBT-5 | `migrate` drops and rebuilds everything but `messages` and `ranges` | `src/cache/schema.ts:234` | forward-only additive migrations — a rebuild would erase identity links and notes |
| DEBT-6 | `PersonSource` = `login \| info \| participant \| sync` | `src/cache/store.ts:6` | free text, declared by the adapter |
| DEBT-7 | `cid?: number` in the guard | `src/sends/guard.ts:26` | `sendId: string` — Telegram's `random_id` is 64-bit |
| DEBT-8 | `Attachment.fileId` / `videoId` | `src/domain/models.ts:39-40` | `providerRef` (opaque JSON) + common fields |
| DEBT-9 | `ChatKind` has no bot, forum, or saved-messages notion | `src/domain/models.ts:10` | add `saved` and `isBot`; forum = group with the `threads` capability |
| DEBT-10 | the message renderer prints `provider  max` with `-vv`, whatever the provider | `src/rendering/messages.ts:83` | the provider is a render option (found 2026-09-26, fixed in PR 0.1) |

**Stay MAX-only** (one implementation): folders, group admin, scheduled messages, account sessions,
contact import. They plug into the skeleton as the MAX adapter's extra commands (§1a).

## 3. Package boundaries

```text
 tg (tg-cli)                       max (max-cli, later)            future: wa, signal…
 src/commands/  src/mcp/           src/commands/  src/mcp/
      │ domain types only               │
      ▼                                 ▼
 src/telegram/  ← only place that      src/client.ts …
 imports @mtcute/*  (lint rule)
      │ implements the port
      ▼
 ┌──────────────────── @leemour/cli-messaging ────────────────────┐
 │ domain   Chat · Message · Identity · Person · Locator ·        │
 │          Capabilities · the adapter port (interfaces only)     │
 │ store    SQLite seam (Node/Bun) · schema · migrations ·        │
 │          repositories · ingestion (upsert, tombstones, ranges) │
 │ search   SearchProvider interface · FTS5 implementation        │
 │ guard    read-only · allow-list · recipients · hourly limit ·  │
 │          send journal · send identity                          │
 │ render   message feed · resolve   name → chat, never a guess   │
 │ testing  fake adapter · in-memory store                        │
 └────────────────────────────────────────────────────────────────┘
      ▼
 @leemour/cli-core   output · errors · exit codes · keyring · config · paths · clocks
```

- **One npm package with subpath exports** (`/store`, `/search`, `/guard`, `/testing`), like
  cli-core. Not a workspace of five packages: nothing needs them versioned apart yet.
- **Nothing in cli-messaging imports a provider library.** No `@mtcute`, no `ws`.
- tg-cli is **one package, split by directory**, as max-cli is (max-cli ruling `NEED-12`). Two lint rules, copied
  from max-cli's `biome.json`: `src/commands/` and `src/mcp/` never import `src/telegram/`
  internals or `@mtcute/*`; `@mtcute/*` is imported only under `src/telegram/`.
- During development tg-cli uses `"@leemour/cli-messaging": "link:../cli-messaging"`; publishing
  switches it to a version.

### The adapter port (sketch — the spike settles the details)

```ts
interface MessengerAdapter {
  readonly provider: Provider            // "telegram" | "max" | …
  readonly capabilities: Capabilities
  connect(): Promise<Account>            // also binds the profile to one account (max-cli MAX-12)
  close(): Promise<void>
  chats: { list(page: PageRequest): Promise<Page<Chat>>; show(ref: string): Promise<ChatCard> }
  messages: {
    history(chat: Id, window: HistoryWindow): Promise<Message[]>
    get(chat: Id, ids: Id[]): Promise<Message[]>
    send(chat: Id, draft: Draft, identity: SendIdentity): Promise<Message>
  }
  identities: { get(ids: Id[]): Promise<Identity[]> }
  updates?: { subscribe(onEvent: (event: MessageEvent) => void): Unsubscribe } // canRealtime
}
```

Optional operations are optional members, and `capabilities` says so up front — a command checks
the capability and exits with a typed error; it never calls and catches.

**Bot accounts are messengers too** (max-cli `NEED-300`, `NEED-301`, ruled 2026-09-26): the MAX
Bot API now, the Telegram Bot API later, each as its own adapter with less — no history, no chat
list from the server (only the chats the store has seen), updates by long polling or a webhook.
The port takes them without a change: `history`, `chatList: "observed"` and `realtime: "poll"` say
so, and the operations a bot lacks are simply absent.

## 4. The store: a system of record, ready for a CRM

### Where it lives

`<data dir of "cli-messaging">/messages.db`, mode 0600 — for example
`~/.local/share/cli-messaging/messages.db`. One file for every provider and every account, because
"everything I discussed with Ivan, in Telegram and in MAX" must be one query, and FTS5, foreign keys
and joins do not cross `ATTACH`ed files cleanly. This is decision **NEED-1** (§11).

The mtcute session database is **not** in this file: it is a credential (§5).

### Tests and branch builds never touch it

max-cli paid for this once: on 2026-09-22 a test run opened the owner's real cache, migrated it and
destroyed its history (max-cli `docs_ai/HANDOFF.md`, the `pnpm test` warning; fixed by its test
sandbox and by `bin/max` keeping everything in `.max/` of the worktree). A shared store makes it
worse — it is not under `tg`'s own directories, and a forward-only migration from a branch build
cannot be undone on the owner's file.

- **One environment variable names the store file**, `MESSAGING_STORE`, read in one place.
- **The tg-cli test sandbox sets it**, together with every `TG_*_DIR` and the mtcute session path,
  and a test asserts that the sandbox holds — as max-cli's `src/testing/sandbox.ts` does.
- **`bin/tg` sets it too**, to `.tg/` in the worktree. Any development run goes through `bin/tg`;
  only an installed `tg` opens the real store.

### Keys

- **Internal integer keys** (`pk`) for joins and for FTS5's `rowid`. They never leave the database.
- **Natural keys are always composite**: a chat is `(account, native_id)`, a message is
  `(chat, native_id)`, an identity is `(provider, native_id)`.
- **The external id is the locator**: `{ provider, account, chat, message }`, all strings, printed as
  `msg:telegram/<account>/<chat>/<message>`. Every search hit, every future AI answer cites
  locators; `tg messages show <locator>` opens one. A provider deep link (`https://t.me/c/…`) is
  derived from it when one exists — **inferred** that private chats and basic groups have none, to
  verify in Phase 1.

### Identity and person — the CRM foundation

```text
 account ──< chat ──< message >── sender identity >── person
                                     (provider,        (the human;
                                      native_id)        ours, ULID)
```

- **An identity is a person as one provider sees them** — a Telegram user id, a MAX contact id.
  Identities are per provider, not per account: the same Telegram user seen from two of my accounts
  is one identity. What each account knows about them (the name I saved them under, whether they
  are in my contacts) goes in `account_identities`.
- **A person is ours.** Every new identity gets its own person, 1:1, at ingestion. Linking two
  identities means pointing both at one person. Unlinking gives the identity a fresh person; notes
  stay with the person they were written on. **No provider data is ever changed by a link.**
- **Every link is recorded with how it was made**: `initial`, `manual`, `auto:phone`, `auto:self`;
  a confidence; when; by whom. Link changes are appended to `identity_link_events`, so an unlink
  loses nothing and a bad auto-link can be found and undone.
- **The owner's own identities link to one `self` person.** That makes "me" the same across
  messengers, and "messages I sent" one query.
- **A contact is a query, not a flag** — max-cli's `NEED-105`, carried over by name: someone is a
  contact of an account because a dialog with them exists (or the provider says so in
  `account_identities`), never because a column was set by hand.
- **Phone numbers are stored for matching only, as a keyed hash** (HMAC with a key kept in the
  keyring), never in plain text. That is enough for `auto:phone` linking across messengers and keeps
  max-cli's rule that a phone number never reaches a log, a fixture or a document. A CRM that must
  *show* numbers adds a plain column later, deliberately.

### Tables (sketch)

```sql
accounts            (pk, provider, native_id, name, created_at,           UNIQUE(provider, native_id))
identities          (pk, provider, native_id, username, name, is_bot, phone_hmac,
                     provider_metadata JSON, first_seen_at, updated_at,    UNIQUE(provider, native_id))
account_identities  (account_pk, identity_pk, saved_name, is_contact, updated_at)
persons             (pk, uid ULID UNIQUE, name, is_self, created_at, updated_at)
identity_links      (identity_pk PRIMARY KEY, person_pk, method, confidence, linked_at, linked_by)
identity_link_events(pk, identity_pk, from_person_pk, to_person_pk, method, at, by)

chats               (pk, account_pk, native_id, kind, title, username, parent_chat_pk,
                     unread_count, last_message_at, provider_metadata JSON, updated_at,
                     UNIQUE(account_pk, native_id))
chat_members        (chat_pk, identity_pk, role, updated_at, PRIMARY KEY(chat_pk, identity_pk))
threads             (pk, chat_pk, native_id, kind, title, UNIQUE(chat_pk, native_id))  -- forum topics

messages            (pk, chat_pk, account_pk, native_id, thread_pk, sender_identity_pk, sender_chat_pk,
                     sent_at, edited_at, deleted_at, text, entities JSON, reply_to_native_id,
                     forward JSON, grouped_id, outgoing, provider_metadata JSON,
                     ingested_at, ingested_via,                           UNIQUE(chat_pk, native_id))
message_revisions   (message_pk, text, entities JSON, edited_at, captured_at)
attachments         (pk, message_pk, position, kind, mime, name, size, width, height, duration,
                     provider_ref JSON, local_path)
reactions           (message_pk, reaction, count, mine, updated_at)

sync_ranges         (chat_pk, from_key, to_key)       -- windows held completely; absent inside = deleted
sync_state          (account_pk, key, value)          -- per-provider checkpoints
messages_fts, chats_fts, identities_fts               -- external-content FTS5, kept by triggers
schema_migrations   (version, min_compatible, applied_at)
```

Why each non-obvious piece is there:

- `account_pk` on `messages` — Telegram delete updates for private chats and basic groups carry
  message ids **without a chat** (the ids are unique per account there). An index on
  `(account_pk, native_id)` finds them. (**Inferred** from the MTProto schema; verify in Phase 2.)
- `sender_chat_pk` — a channel post, or a message sent "as the group", has a chat as its author.
- `reply_to_native_id` as text, not a foreign key — the replied-to message is often not stored yet.
  Reply chains are what research needs most; they are never dropped.
- `forward` keeps the original author, chat, date and, where possible, the original locator, so
  "original vs forwarded" is a search filter.
- `deleted_at` is a tombstone. Nothing is hard-deleted by sync.
- `message_revisions` gets a row only when an edit is seen. Cheap, and the only record of what a
  message said before it was changed.
- `sync_ranges` keys are the provider's ordering key — Telegram's message id (monotonic per chat),
  MAX's time. It generalises max-cli's `ranges` (`src/cache/schema.ts:104-109`).

**What is deliberately not created now:** notes, tags, interactions, commitments, follow-ups. They
all hang off `person_pk` or `message_pk`, both of which exist from day one. Creating them empty would
freeze a guessed shape; with additive migrations they cost one migration each when the first CRM
command is written.

### Migrations

- **Forward-only, additive, numbered.** Never drop, never rebuild. A new column is nullable or has a
  default. A test migrates every shipped version.
- **Compatibility is declared, not assumed.** `schema_migrations` carries `min_compatible`. An older
  `max` opens a newer file if its own version is at least `min_compatible` — additive changes keep
  old statements valid. Only a breaking change raises `min_compatible`, and that is a major version
  of cli-messaging. This is what lets `tg` and `max` share one file while installed at different
  versions.
- Concurrency: WAL + `busy_timeout`, as max-cli (`src/cache/driver.ts`). One background ingester
  per account at a time, enforced by a lease row (max-cli's `fetch_lease` pattern).

## 5. Telegram adapter design

### Transport

- **mtcute, pinned exactly at 0.32.x** (pre-1.0; `npm view` 2026-09-26: `@mtcute/node` 0.32.3).
- **The native dependency is a spike question.** `@mtcute/node` depends on `better-sqlite3`
  (`npm view`, 2026-09-26), a native module. pnpm 10+ does not run its install script unless allowed
  (the mtcute FAQ describes `onlyBuiltDependencies`), so a global `pnpm add -g` may install a `tg`
  without working SQLite. Two ways, chosen by measurement in the spike:
  - **A** `@mtcute/node` as is, if `npm i -g` and `pnpm add -g` into a clean prefix both work on
    Linux and macOS;
  - **B** `@mtcute/core` plus our own ~40-line storage driver over `node:sqlite` / `bun:sqlite`.
    The docs describe the interface (`ISqliteDatabase`: `exec`, `prepare`, `transaction`, `close`);
    `transaction` would be `BEGIN`/`COMMIT`. B also needs the network transport that `@mtcute/node`
    provides — **unknown** whether that is usable without `better-sqlite3`.
- The spike runs on **Node only**. Bun is measured after, not assumed.
- **Correction 2026-09-27 (measured in the spike):** neither A nor B. `pnpm add -g` left
  `better-sqlite3` without its native binding, and login failed. `@mtcute/node` stays for the network;
  its session storage runs over `node:sqlite` / `bun:sqlite` through this package's seam
  (`tg-cli/src/telegram/storage.ts`). Both global installs work. Details:
  [the spike report](https://github.com/leemour/tg-cli/blob/main/docs/plans/2026-09-27-spike-report.md).

### Auth and credentials

- `tg session start qr | phone` — max-cli's command names (`session start|end`), not `auth`. QR
  and phone + code + 2FA password; the docs describe both as `tg.start({ qrCodeHandler, password })`
  and `sendCode` / `signIn`. Prompts never echo; nothing goes on the command line.
- **The mtcute session database is a credential** — it holds the auth key. It lives in the state
  dir (`<state>/sessions/<profile>.db`), mode 0600, and is excluded from export, backup, the doctor
  report and any log. Moving only the auth key into the OS keyring is possible in principle (mtcute
  keeps auth keys in their own repository); not promised.
- **Every user registers their own `api_id` / `api_hash`** at [my.telegram.org/apps](https://my.telegram.org/apps)
  (NEED-3 → B), as [kfastov/tgcli](https://github.com/kfastov/tgcli) asks. Telegram's
  [page on obtaining an api_id](https://core.telegram.org/api/obtaining_api_id) allows one id per
  phone number and puts every account of an unofficial client "under observation". One id shared by
  every install would carry every user's behaviour, and its `api_hash` would be public in the
  package. `tg session start` asks for both the first time, `api_hash` without echo, and keeps them
  in the keyring (service `tg-cli`, per profile) next to nothing else. `TG_API_ID` / `TG_API_HASH`
  outrank the keyring, for CI — as `MAX_TOKEN` does in max-cli. Never on argv, never in a file,
  never through chat.
- **Profiles as in max-cli**: the first word (`tg work chats list`), bound to one Telegram user id on
  first login; a different account is refused (max-cli `MAX-12`).
- **Unlike max-cli, `tg` does not pretend to be an official client.** max-cli's "look like the
  official client" rule is a MAX constraint. Telegram expects a registered `api_id` and an honest
  device and app name.
- Multi-account: one profile = one account = one session file. The store holds all of them.

### Mapping

`src/telegram/map.ts` is the only file that knows mtcute's object shapes, as `src/domain/map.ts` is
in max-cli. Chat ids are mtcute's marked ids as strings (`-100…` for channels and supergroups);
every id leaves the adapter as a string. Kinds: user → `dialog` (+`isBot`), basic group and
supergroup → `group`, broadcast channel → `channel`, Saved Messages → `saved`; a forum is a group
with threads. Entities (links, mentions, formatting) are kept as JSON; the plain text is what is
indexed.

### Updates

mtcute keeps the update state (`pts`) in its session storage and catches up after a restart (the
docs describe `catchUp`). The adapter turns updates into `MessageEvent`s — new, edit, delete,
reaction — and the store ingests them. When catch-up gives up on a chat (a gap too long to replay),
the chat's `sync_ranges` are cut at that point, so "absent means deleted" is never claimed across a
gap. **Two processes must not both drive one session** (both would advance `pts`); one owns the
connection — the `max serve` pattern — and the others ask it, or run one-shot without updates.

### Sending

- **Every send has a send identity before it goes out** — a `random_id`, stored as a string in the
  send journal's `reserved` line before the request. A retry reuses it. After a timeout with no
  answer the result is `outcome_unknown` (exit 14) naming the id, and `tg messages send --send-id
  <id>` repeats it without risking a second message. This is max-cli's `cid` model
  (`max-cli/docs/dev/ARCHITECTURE.md` §6), generalised.
- **Unverified:** whether mtcute's high-level `sendText` accepts a `random_id`. If it does not, the
  adapter calls `messages.sendMessage` directly. **Unmeasured:** what Telegram answers to a repeated
  `random_id` (max-cli measured MAX's `cid` in Saved Messages across two connections; the spike does
  the same).
- **FloodWait is `rate_limited` (exit 8) with `retryAfterMs`.** Reads may sleep through a short wait
  (mtcute's flood waiter, threshold configured); a send never sleeps and never retries past it.
- The guard runs before every write, unchanged from max-cli: read-only profile, allow-list,
  recipients, hourly limit, journal without the text.

## 6. Search

- A `SearchProvider` interface in `cli-messaging/search`, not SQL in commands:
  `search(query, filters) → Page<Hit>`, where a hit is a locator, the message, the chat title, a
  snippet and a score. Filters: providers, accounts, chats, sender identity **or person**, date range,
  thread, has attachment, original vs forwarded, outgoing.
- First implementation: FTS5. **Which tokenizer is a measurement, not a decision.** max-cli chose
  `trigram` for substring matches on Cyrillic names (`src/cache/schema.ts:129-143`). On large groups
  trigram indexes are big, need three characters, and rank word queries weakly under BM25. Phase 2
  measures, on one real large group: `trigram` alone vs `trigram` for names + `unicode61
  remove_diacritics 2` for message text — index size, query time, and ranking on ~20 real queries.
- Later layers (vector retrieval, reranker, thread expansion, LLM synthesis) are further
  `SearchProvider`s or a composite over them. Not built now.
- Remote search (`messages.search` on Telegram) is a capability, `canSearchRemote`, later.

## 7. Capabilities

A `Capabilities` object in the domain from the first commit — cheap, and it stops commands assuming
every messenger can do everything. **Shipped in PR 0.1** (`src/domain/capabilities.ts`): `history`,
`chatList` (`server` | `observed`), `realtime` (`push` | `poll` | `none`), `send`, `edit`, `delete`,
`react`, `threads`. Candidates as commands need them: `schedule`, `forward`, `groups`,
`readReceipts`, `searchRemote`, `maxTextLength`.
Filled by each adapter; printed by `tg commands --json` for agents. Only the fields a command
actually checks are added; the full list grows in Phase 4 when MAX fills it too.

## 8. Phases — small, independently shippable pull requests

- **Search A1** · 🚧 `feat/search-lucene-a1` · Lucene 9.12.3 query profile, strict shared search, bounded patterns, legacy migration and executable documentation. Owner: search/archive A; approved implementation plan 2026-10-03.

**Phase 0 — spike.** Goal: prove the transport and measure the unknowns. cli-messaging starts here
with only the copies that carry no risk, so the spike already imports them and nothing is copied
twice. The store and the guard wait for Phase 1.

| PR | What |
|---|---|
| 0.1 | cli-messaging scaffold + domain, render, resolve, SQLite seam (copies from max-cli; DEBT-1, DEBT-8, DEBT-9 fixed) |
| 0.2 | tg-cli scaffold: pnpm, TypeScript, Biome, Vitest, lefthook, cli-core, cli-messaging via `link:`; the two lint rules; `bin/tg` |
| 0.3 | `tg session start qr\|phone`, `tg chats list`, `tg messages list <chat>`, `tg messages send me <text>` — no store |
| 0.4 | spike report in `tg-cli/docs/plans/`: every measurement in §9's criteria, and the A/B transport choice |

**Phase 1 — foundation.**

| PR | What |
|---|---|
| 1.1a | skeleton, part 1: program and `run()`, global flags, settings with each CLI's own fields in one strict schema, profile as the first word and its lock, command context with `--timeout`, paging. Copied from max-cli at `f1ee2ed`, with its config and profile tests. tg-cli moves onto it. **Done 2026-09-27** |
| 1.1b | run records (`--record`, `runs`) — **after 1.2**: the guard protects a live account, run records are diagnostics. `baseContext().run` records; the adapter names ids and counts; `runsCommand(app)` gives `runs list\|show\|path`. **Done 2026-09-27**. Failures before a command runs (usage errors, a config that will not load) are kept since 0.21.0. **Done 2026-09-28** |
| 1.2 | cli-messaging guard + journal, generalised (DEBT-7): the send id is a string, max-cli's numeric `cid` is still read. tg's `messages send`, `recipients` and `sends` go through it. **Done 2026-09-27** |
| 1.3 | cli-messaging store v1: §4 schema, migrations with `min_compatible`, repositories, FTS; identities get a 1:1 person. `openStore` in `./store`. Left out until a PR writes them, each one migration: `account_identities`, `chat_members`, `threads` (a message keeps `thread_native_id`), `sync_ranges` and `sync_state` (2.2), the ingester lease (2.3), `phone_hmac`'s writer and link/unlink (Phase 4). Changed from the sketch: reactions are a JSON column on `messages`, a chat author is `sender_chat_native_id`. Migration 1 is frozen by the first real write, in 2.1 — until then it may still be amended. **Done 2026-09-27** |
| 1.4a | skeleton, part 2a: the adapter port (`MessengerAdapter`) and `Messenger` in `./cli`; `account show`, `chats list`, `messages list` shared, with saving to the store, `--offline` and run events. A CLI overrides by composition — it picks the builders and adds subcommands; no hook registry. tg-cli moved onto it with no test changed. **Done 2026-09-27** |
| 1.4b | skeleton, part 2b: the new read commands — `chats show`, `messages show\|context`, `contacts list\|show` — with their adapter methods. `session start\|end` stays in each CLI: logging in is the messenger's own business |
| 1.4b-1 | `messages show\|context` (`around` on the port and the store; `show` also takes a `msg:` locator), online and `--offline`. **Done 2026-09-27** — `chats show` and `contacts` remain |
| 1.4b-2 | `chats show`: the chat as its dialog describes it, and who is in it (`null` for a channel or a hidden list; a note when fewer members come back than the chat has). Online only — the store keeps no members yet. **Done 2026-09-27** |
| 1.4b-3 | `contacts list\|show`: a contact is a one-to-one chat (max-cli `NEED-105`), so the list is a query over chats and works `--offline`; `show` is online — the person, their bio, and the chats shared with them. **Done 2026-09-27 — 1.4 is complete** |
| 1.5 | `messages send\|reply` through the guard, with the send identity and `outcome_unknown`. Shared in `messagesCommand`; a reply records `replyTo` in the journal; `reply` also takes a `msg:` locator. The guard now takes its paths from the command's environment. **Done 2026-09-27** |
| 1.6 | `doctor` (generic + Telegram checks), `commands` (with the contract version), `complete`, `config`, `runs`, `sends`, `recipients`, `update` — and a test that stdout carries one JSON value |
| 1.6a | `recipients`, `sends` and `commands` (with `contract` and which commands write) shared; tg's test runs every command with `--json` and holds stdout to one JSON value, or nothing on failure. **Done 2026-09-27** |
| 1.6b | `config show\|set\|unset` shared: every file setting with its source, a messenger's own included; profiles from the file and from remembered accounts; `--defaults` refused under a profile lock. **Done 2026-09-27** |
| 1.6c | `complete` shared (`@bomb.sh/tab`, as max-cli): chat and person ids from the message store with titles as descriptions; a Tab never connects and never creates the store. **Done 2026-09-27** |
| 1.6d | `doctor` shared: cli, config, remembered account, the store read without migrating, sends, runs, and `Messenger.diagnose` for the messenger's own facts; answers when everything is broken; `--online` connects once. **Done 2026-09-27**. `update` stays in each CLI (it needs the CLI's own install path): tg's `update` and its daily line shipped in tg 0.2.0. **Done 2026-09-28** |
| 1.7 | `watch` in the foreground, `--jsonl`. `MessengerAdapter.watch` on a connection opened `{ listen: true }` (one-shot commands keep updates off); each message saved via `update`; Ctrl-C and `--timeout` end it with exit 0; `--json` refused; a closed pipe ends it at the next write. Edits, deletions and reactions (`--events`) wait for the background process (2.3). **Done 2026-09-27** |

**How the JSON contract is versioned** (brief §6 asks for "stable and versionable"). The output
types live in cli-messaging, so the contract is cli-messaging's: adding a field is a minor version,
removing or renaming one is a major version. `tg commands --json` prints `contract: <major>` so an
agent can check it once. No version field inside each answer — max-cli's listing shape
(`{items, page, limit, hasMore}`) stays as it is.

**Phase 2 — local archive and search.** The business milestone: connect Telegram, index a few
large groups, search the whole history locally.

| PR | What |
|---|---|
| 2.1 | ingestion: every read writes to the store; `--offline` answers from it. The brief's `--source live\|local\|both` is reduced to `--offline` on purpose: max-cli ruled out a "freshness window" and the two CLIs should agree. `both` comes back with remote search (§6), where it means something  tg saves `chats`, `history`, `send` and `me` (not `resolve`, which would erase dialog fields); `--offline` answers `chats list` and `messages list`, byte-identical to the live answer. Migration 1 is frozen from here. **Done 2026-09-27** |
| 2.2 | `tg backfill <chat>` — resumable via `sync_ranges`, throttled, FloodWait-aware. Migration 2 (`sync_ranges`); `backfillCommand` shared: pages of 100 newest first, a stretch recorded after every page, held stretches skipped, `--max` and `--pace`, waits ≤ 5 min sat out. **Done 2026-09-27** |
| 2.3 | skeleton, part 3: the background process (`serve`) from max-cli's `src/server/`; the Telegram adapter supplies the connection and ingests updates (new, edit, delete, reaction) — plan: [2026-09-27-background-process.md](2026-09-27-background-process.md). 2.3a `watch --events` and 2.3b `serve` (lock file, catch-up, no auto-start) built. **Done 2026-09-27** |
| 2.4 | tokenizer measurement (§6), then `tg messages search` on the `SearchProvider`. Measured on 4,517 real messages of one large group (19 of 20 queries Russian): trigram 2.4 MB vs `unicode61 remove_diacritics 2` 1.2 MB; whole-word hits 2,600 vs 2,222; for a word stem, trigram 3,743 vs unicode61 as a prefix query 3,348 (38 without the prefix); both under 0.1 ms. Chosen: unicode61 with every word a prefix, for message text (migration 3, rebuilds only the derived index); names stay trigram. Ranking quality not measured — it needs a person to judge. `messages search` answers from the store only; the `SearchProvider` interface waits for a second implementation. **Done 2026-09-27** |
| 2.5 | `tg sync status`, `tg export`. Both read the store only: `sync status` per chat — messages, oldest, newest, last stored, stretches held; `export <chat>` oldest first (`--jsonl` one per line, `--json` one value). Whether a backfill reached a chat's first message is not recorded, so not claimed. **Done 2026-09-27 — Phase 2 complete** |

**Telegram topic addressing — B1a.** Implemented: shared contract #442 (0.119.0), Telegram
adapter and CLI adoption tg-cli #228, explicit MAX rejection and adoption max-cli #338/#339.
CLI/MCP addressing, preflight, journal metadata and offline tests are shipped in main. Positive
live topic checks await a forum-capable test group; enabling forums is a separate follow-up.

**Phase 3 — agent-safe runtime.** Skeleton, part 4: MCP (a second front end over the same
operations, as in max-cli §17) with its session, tools and send confirmation; the skill; capability
discovery. Telegram adds its own tools through the hook.

**Owner's ruling, 2026-09-28:** the MCP server may send (option B: max-cli's model), and tg aims at
**feature parity with max-cli** — copy max's commands, tools and docs, adjusted for Telegram, share
as much as possible in cli-messaging, and add what Telegram allows beyond MAX; non-critical parts
later. **Every command PR from here adds its MCP tool in the same PR**, so a command and its tool
never drift apart. A tool answers what the command's `--json` prints.

| PR | What |
|---|---|
| 3.1 | `mcp` and `mcp config` in cli-messaging (`./mcp`, the SDK loaded only by `mcp`), copied from max-cli `src/mcp/`: a session that holds one connection (2 min idle, 5 min age, one call at a time, dropped after a connection error), the read tools over `MessengerAdapter` and the store, `<cli>_status`, the instructions under 2048 characters. Reads are saved and recorded exactly as a command's — one shared wrapper. Tools are named from `app.command` (`tg_chats_list`); a CLI adds its own **Done 2026-09-28 (0.22.0)** — found live: a client that trims the environment leaves out `XDG_RUNTIME_DIR`, and the keyring with it; `mcp config` copies it |
| 3.2 | `--allow-send`: `<cli>_messages_send` with `reply_to` and `send_id`, through the same guard function as the command; `--confirm-send`, max's elicitation form (HMAC-sealed, one use, 5 min), both protocol eras **Done 2026-09-28 (0.23.0)** |
| 3.3 | prompts (`reply`, `find`; `catch-up` and `review` with their commands) and the chat resource from the store **Done 2026-09-28 (0.24.0)** |
| 3.4 | `skill show` and the skill file, copied from max-cli's `skills/max-cli/SKILL.md` **Done 2026-09-28 (0.24.0)**: `skillCommand(app, url)`; tg's skill is `skills/tg-cli/SKILL.md` |

**The work runs in parallel lanes** — [2026-09-29-parity-lanes.md](2026-09-29-parity-lanes.md) replaces the tiers
below as the plan (it adds what kfastov/tgcli has and what max-cli gained since); the tiers stay as
the record of the first measurement.

**Parity tiers** — the gap measured 2026-09-28 against max-cli 0.17.1 (`docs/commands.md`). Each row
is a command in cli-messaging (a new `MessengerAdapter` method where it needs the messenger), its
tool, and tg's adapter:

| Tier | Commands |
|---|---|
| P1 — what an agent needs daily | `inbox`, `review`; `chats list --search --kind --unread`; `messages list --after`; `messages send --reply-to --silent --md --file`; `messages edit\|delete\|forward\|pin\|unpin`; `reactions add\|remove`; `chats read`; `messages download` and the photo tool; `messages send --at` and `messages scheduled` |
| P2 — reading more | `chats events`, `chats members list`, `contacts lookup\|sync`, `account sessions`, `chats inspect\|join\|leave`, `polls vote\|create\|close`, voice to text, `export --format markdown`, `backfill` cost estimate, `doctor report`, `cache clear` |
| P3 — administering | `chats create\|update\|settings\|link\|folders`, `chats members add\|remove`, `chats admins`, `contacts add\|remove\|block\|unblock\|rename\|import`, `account update`, `chats rules` and `chats check` (moderation) |
| Out | `bot *` — a Telegram user account is not a bot, and the Telegram Bot API is another product |

tg keeps what max lacks: `messages reply`, `sync status`, `watch --events`.

**Phase 4 — the platform.** max-cli moves onto cli-messaging (under max-cli's own rules: worktree,
`🚧` claim on its backlog, a plan in its `docs_ai/`); its existing history is imported into the
shared store; the capability model is filled by both; `auto:self` and `auto:phone` identity links
are switched on. First cross-messenger read: `msg person show <name>`. **`msg` is a thin second
command shipped by cli-messaging itself**: it reads the shared store only, opens no connection and
imports no adapter. `tg` and `max` write the store; `msg` reads across it. This is where the CRM
commands will live later.

**Not in any phase here:** CRM commands, notes, embeddings, AI summarisation, polls, stickers,
stories, calls, admin features, a UI. (**Superseded for polls and admin features** by the parity ruling
above, 2026-09-28.) If it does not help *read → sync → search → context → safe
action*, it waits.

**Follow-up proposal, 2026-10-02 (not yet approved):**
[chat briefs, news digests, portable archives, monitoring and person context](2026-10-02-messaging-workflows.md)
plans the owner's requested next capabilities, with shared services, agent-facing contracts and
dependency-ordered work packages. It distinguishes existing archive features from incremental
recovery and extends the summarisation scope for discussion; no automation is enabled by the plan.

## 9. The spike: definition and success criteria

Run against the owner's real account, sending only to Saved Messages.

1. `tg session start qr` and `tg session start phone` (with 2FA) both succeed; a second command
   needs no prompt.
2. `tg chats list --json` and `tg messages list <chat> --json`: stdout is one JSON value, stderr is
   empty, every id is a string.
3. `tg messages send me "…"` sends once. The same `random_id` sent again — including from a second
   connection — produces **one** message, or the spike records exactly what Telegram does instead.
4. Every command exits within a second of printing (no open socket or timer keeps the process).
5. `@mtcute/*` is imported only under `src/telegram/`; a deliberate violation turns `pnpm lint` red.
6. The session file is mode 0600 and appears in no output, log or error.
7. `npm i -g` and `pnpm add -g` of a packed `tg` into a clean prefix both give a working `tg` — or
   the report says which fails, and transport B is tried.
8. The report counts lines: reused from cli-core, copied from max-cli, new.

## 10. Risks

| id | Risk | Mitigation |
|---|---|---|
| RISK-1 | `better-sqlite3` native build fails on global install | **happened** with pnpm (2026-09-27): fixed by moving session storage to the runtime's own SQLite. npm is only mitigated: it still runs the install script and needs a prebuilt binary; the real fix is `@mtcute/core` with our own transport |
| RISK-2 | mtcute is pre-1.0; the API moves | exact pin; all of it behind `src/telegram/` |
| RISK-3 | two processes drive one session and corrupt update state | one owner process (`tg serve`); others one-shot without updates |
| RISK-4 | FloodWait while backfilling large groups | throttle, resumable ranges, typed `rate_limited`, never retry sends |
| RISK-5 | account limits for unofficial clients (spam, shared `api_id`) | registered `api_id` (NEED-3), guard limits, no bulk send features |
| RISK-6 | update gaps silently lose deletes and edits | cut `sync_ranges` at a gap; `sync status` shows it |
| RISK-7 | two CLIs, one store, different schema versions | additive migrations + `min_compatible` (§4) |
| RISK-8 | trigram index size and ranking on large groups | Phase 2 measurement before committing (§6) |
| RISK-9 | Telegram message ids unique per account in private chats | `account_pk` on messages; composite keys everywhere (DEBT-2) |
| RISK-10 | the session database leaks through backup/export/doctor | excluded by path, and a test for each |
| RISK-11 | a test or a branch build migrates the owner's real store — forward-only, so it cannot be undone | `MESSAGING_STORE` set by the test sandbox and by `bin/tg`; a test asserts it (§4) |

## 11. Decisions that need the owner

Answered 2026-09-26: NEED-1 → A, NEED-2 → A with a generous extraction, NEED-3 → B.

Answered 2026-09-27: **NEED-7 → A** — one session owns this package's releases: the one that works on
the store for max-cli's bot. Others send PRs without a version bump, ask it for a release, and announce
a migration's number before writing it. Two releases in one day collided on the same version (0.10.0,
0.13.0); a collision on a migration number would damage the shared store. **Amended the same evening (NEED-10 → C):** relaying release requests between sessions failed — each message waited for the owner's approval — so each session releases its own merged PRs, after checking `origin/main` and npm right before. **NEED-8 → A** — tg-cli
is published on npm like this package, once backfill and search exist; `tg update` is built then.

- **NEED-1 — one store for all messengers, or one file per CLI?** Recommended: one file in
  `~/.local/share/cli-messaging/`, with `min_compatible`. Per-CLI files make every cross-messenger
  query an `ATTACH` with no foreign keys, and the `msg` command (Phase 4) would have nothing single
  to read.
- **NEED-2 — keep max-cli untouched until Phase 4?** Recommended: yes. max-cli has several agents,
  a security batch and a pre-release in flight; its own ruling (max-cli `NEED-147`) already says the package
  is extracted when the second messenger starts, which is this.
- **NEED-3 — whose `api_id` does a published `tg` use?** ~~Recommended: at publication, one
  registered for the app, overridable per user.~~ **Correction 2026-09-26:** the owner chose B, each
  user registers their own, and Telegram's rules back it (§5). The earlier recommendation weighed a
  lower entry barrier over one shared id carrying every user's behaviour.
