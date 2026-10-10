# Architecture

What the package is made of and where the seams are: the map of what exists. Open work is in
[the backlog](BACKLOG.md).

## The one rule

**Nothing here knows a messenger.** A CLI's adapter translates its provider's objects into the
domain types, and `biome.json` refuses any import of `@mtcute/*`, `ws` or an adapter directory
under `src/`. What only one provider has travels in `providerMetadata`.

## CLI design references

The command interface follows a shared [adoption profile](STANDARD.md#external-references-and-our-adoption-profile):
[POSIX utility conventions](https://pubs.opengroup.org/onlinepubs/9799919799/basedefs/V1_chap12.html)
for utility syntax, [GNU CLI conventions](https://www.gnu.org/prep/standards/html_node/Command_002dLine-Interfaces)
for common options, and [CLIG](https://clig.dev/) for modern CLI design. The standard records our
additional agent contract and deliberate differences. These references do not choose a particular
resource hierarchy; `stats` is a project decision.

The shared program shell owns parsing and error routing; the renderer owns machine output;
command discovery describes the tree; services own use cases and write guards enforce permissions.
CLI and MCP are two adapters over those services. The [MCP tools specification](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)
governs the latter; [Agent Skills](https://agentskills.io/specification) describes the portable
agent guidance format. Agent-oriented design references and their applicability are linked from
the standard, so a reader need not treat a project example as a formal standard.

The [compliance audit](CLI-COMPLIANCE.md) distinguishes source evidence, isolated observations,
intentional deviations and work still needed. This architecture page does not certify complete
conformance or imply that planned command paths are already implemented.

## Modules

| Export | Directory | What it holds |
|---|---|---|
| `.` | `src/domain/`, `src/render/`, `src/resolve.ts`, `src/terminal/` | the domain model (`models.ts`, types only), message locators, message rendering, name resolution that refuses rather than guesses, the secret prompt, the terminal QR code |
| `./store` | `src/store/` | the SQLite seam and the shared message store |
| `./sends` | `src/sends/` | the send guard: read-only, the allow-list, the recipient list, the hourly limit, the journal (never the text), the send id |
| `./speech` | `src/speech/` | the pinned catalogue, shared model directories and verified installer, without loading the recognizer |
| `./charts` | `src/charts/` | neutral chart data and a replaceable renderer interface; SVG rendering loads ECharts only on demand; a separate lazy PNG encoder uses resvg and bundled fonts |
| `./models` | `src/models/` | purpose-specific text generation with typed image inputs, OpenAI-compatible and Anthropic adapters, strict options, injected key/consent resolvers; no configured provider means no call |
| `./services` | `src/services/` | the use cases, once each, that commands and MCP tools call — see [Services](#services) |
| `./background` | `src/background/` | what any background process needs and no messenger: the lock per app and profile, whether a PID is alive and ours, the machine seam tests replace, systemd and launchd units — `serve` and `server` are built on it, each CLI's server stays its own (NEED-492 C) |
| `./cli` | `src/cli/`, `src/mcp/` | the command skeleton, the shared commands and the MCP server |
| `./sqlite-runtime` | `src/sqlite-runtime.ts` | `ensureSqlite`, the first thing `tg` and `max` run: restarts the command with the bundled SQLite when the system's lacks FTS5 — see [The store](#the-store) |
| `./parity` | `src/parity/` | the command manifest, page and wording checks behind `cli-messaging-parity`, which compares `tg` and `max` |
| `./testing` | `src/kit/` | the adapter kit: a fake adapter, the contract cases and their seed — see [the adapter guide](ADAPTERS.md). `src/testing/` is this repository's own test setup and is not published |

The README's table lists what each export offers; this page does not repeat it.

## The store

`openCache` (`src/store/open.ts`) opens `node:sqlite` under Node and `bun:sqlite` under Bun. Both
imports are dynamic: a static import of the other runtime's module fails at load time, before
anything can catch it. `pnpm smoke:bun` is what proves the Bun half.

Before it opens the file, `openStore` checks once per process that the runtime's SQLite has the
full-text search the migrations need (`assertStoreCapable`), and refuses with what to install. The
version number does not tell: official Node 22.0–22.15 has SQLite 3.46–3.49 without FTS5. CI runs the
built package on Node 22.15.0 to see the refusal (`scripts/check-old-node.mjs`).

Where the runtime's SQLite can be swapped, ours from `@wirecat/cli-messaging-sqlite` (built in
`packages/sqlite`, published by `.github/workflows/sqlite.yml`) takes its place
(plan):

- **Bun on macOS** always loads ours (`bunDatabase`, `src/store/drivers/bun-sqlite.ts`), once, before
  the first database: Bun uses the system's library there, which can be too old.
- **A Linux distribution's Node** links the system's `libsqlite3`. `ensureSqlite`
  (`src/sqlite-runtime.ts`, exported as `@wirecat/cli-messaging/sqlite-runtime`) is the first thing
  `tg` and `max` run: when the system's SQLite fails the check above, it starts the command again
  with ours first on `LD_LIBRARY_PATH`, before anything is read or sent. CI runs it on Ubuntu's Node
  with SQLite 3.42 (`scripts/check-sqlite-restart.mjs`).
- Official Node and Bun on Linux and Windows build SQLite in; nothing is swapped.

`openStore` (`src/store/store.ts`) is the **one file for every messenger and account** — tg's
profiles and max-cli's bots write the same database, keyed by provider and account. Its path comes
from `storePath` (`src/store/path.ts`), the only place that turns `MESSAGING_STORE` into a path;
`mcp config` copies the variable into the entry it prints, so the server it starts opens the same file.

Every `MessageStore` method is async and is **one whole operation**: inside the SQLite store each
write runs as one synchronous `BEGIN IMMEDIATE` transaction, with no `await` between `BEGIN` and
`COMMIT`. The interface has no `transaction(callback)`. The driver is synchronous, so an `await` inside a
transaction would let the commit run before the awaited part; and since a method never yields
mid-transaction, two calls on one store in `serve` or `mcp` cannot interleave inside one `BEGIN`
(phase 1 plan, D3). A large write therefore
blocks the event loop while it runs — keep writes in bounded batches.

**One method is several transactions on purpose:** `replaceConversations` (phase 3). A chat of 1M
messages takes seconds to write, and every other process waits at most 5 s for the lock, so it writes a
new **build** of the chat's links and conversations in transactions of ~250 ms with a 120 ms pause
between them, makes the build current in one more, and drops older builds the same way. Each
transaction runs synchronously to its `COMMIT`; the pause is between them. Readers see only
`conversation_state.current_build`, so a half-written or failed build is never read. Without the pause
the next `BEGIN IMMEDIATE` wins the lock again at once and a waiting process sees no gap
([`bench/disentangle/`](../../bench/disentangle/README.md), plan
phase 3, C3).

**The user's agent links what the rules leave open** (phase 4, plan). The CLI
never calls a model ([NEED-405](../storage/decisions.md)); it hands the agent batches and stores its
answers, in `src/store/sqlite/batches.ts`:

- **A batch** is the earliest live message that needs the agent — no reply the messenger records, no
  current agent answer — and the next `--size` live messages, plus `BATCH_CONTEXT` (50) messages before
  it as context. The rules' current links come along as candidates. No table holds batches.
- **The batch id** (`batchId`) names the chat, the first and last message to answer, and a hash of every
  live message between them. `links add` reads that span again and refuses the answer when the hash
  differs: a message added or deleted inside it means the agent answered a window that moved. Answering
  some of its messages leaves the id valid.
- **An answer is checked whole before anything is stored** (`saveAnswers`): every message one the batch
  asks about, each parent in the batch and earlier than its message, no message twice, confidence 0–1, a
  model named. One refusal stores nothing. A message's new answer replaces its earlier one; the rows are
  `message_links` with `source = 'agent'`, outside any build, so a rebuild keeps them. An answer goes
  stale when its message or parent changes after it was written, and the message needs the agent again.
- **The choice** (`choose`, `src/conversations/link.ts`): the messenger's reply, then a fresh agent
  answer — including "starts a conversation", which drops the rule's parent — then the most confident
  rule. An answer naming a message the chat no longer holds leaves the choice to the rules.
- **Permission**: `conversations links` has its own key, `conversations.links` (`keyForCommand`,
  `src/sends/permissions.ts`), so a profile read-only on messages can still link — the answers write
  only to the local store. `batches next` shows message text and is checked as `messages`.

**Chunks and vectors** (phase 5, store version 14, plan). Each build
also writes `chunks` rows of type `conversation`, with their message range in `chunk_messages`: a conversation cut at message boundaries into pieces of at most
`CHUNK_CHARS` (`src/conversations/chunks.ts`), each with its first and last message and the sha256 of
its text. A message longer than a chunk is split into overlapping pieces (`splitText`), a chunk each, and
since store version 21 such a chunk also keeps the stretch of the message it holds (`text_start`,
`text_end`), so every reader below cuts the text the same way. The text is never stored. Chunks cascade with their conversation, so old builds' chunks go
with them. `chunk_vectors` is keyed by model and that hash, with no chat: a rebuild writes new
conversation rows, and a vector tied to them would be thrown away each time, while a chunk whose text
did not change keeps its hash and finds its vector again. `conversations embed` reads a chunk's messages
again (`chunksToEmbed`, `src/store/sqlite/vectors.ts`), rebuilds its text with `chunkTextOf` and embeds it
only when the hash still matches; a chunk whose messages changed since the build waits for the next one. A
search re-reads each meaning hit the same way (`chunkFreshness`) and marks it stale or drops it, and
`tombstone` deletes the vectors of the chunks a deleted message was in (`purgeVectorsOf`); how fresh each chat
is, is one query (`readiness`) behind `conversations status` and search's `readiness`. The same readiness picks
what `conversations build` and `embed` without `--chat`, `search --refresh` and MCP `conversations_refresh` do:
one service method, `embeddings.refresh`, bounded by chats and chunks. How
the search over them works, end to end and measured: [search-indexes.md](../storage/search-indexes.md#search-by-meaning).

**The owner's tags** (version 16) are one table, `tags`, for a chat, a person (an `identities` row) or a
message — `taggable_type` and `taggable_pk`, so no foreign key. Triggers in the file drop a message's tags
when it is deleted or tombstoned and a chat's when it is deleted, so a build that knows nothing of tags —
0.49.0 included — cannot leave one behind; identities are never deleted. `tag:` in a strict search
compiles to one exact condition over the three (`src/store/sqlite/lucene.ts`), and `tags` commands and
MCP tools write through `services.tags` with their own permission keys (`tags.add`, `tags.remove`).

**The text of files** (version 19) is `attachment_texts`, one row per attachment: what `attachments extract`
read from the file `messages download` saved (`attachments.local_path`, written by the download since this
version's package) — plain text, Word through `mammoth`, a PDF's text layer through `unpdf`, both optional peer
packages loaded on first use (`src/attachments/extract.ts`) — or what an agent wrote back after reading a scan
(`origin`: `extracted` or `agent`; an extraction never replaces an agent's text). Its words are in
`attachment_words`, contentless FTS5 with rowid = attachment pk, kept by triggers; `content:` compiles to an
exact condition over it and stays out of bm25 ranking, which ANDs required words into `message_words`. No
foreign key, so the purges of older builds still work; triggers erase the text when its message is tombstoned
or deleted, or its attachment deleted (NEED-393 A, tested against 0.49.0). `store reindex` rebuilds the index.
`attachments list --needs-text` and `attachments text set` (MCP `attachments_list`, `attachments_text_set`) are
how an agent finds a scan, reads it itself and writes the text back, all through `services.attachments`.

Remote agents receive retained bytes through bounded `attachments show` / `attachments_show`,
with whole-file SHA256 and account/message binding. See [attachment transfer](../attachments.md).

Agents perform self-OCR by default. Explicit `attachments extract --ocr` selects the
`models.ocr` gateway for bulk extraction; without it no model is called. Its typed
image parts are local validated base64, never a URL to fetch. Scanned PDFs use the
optional `unpdf`/`@napi-rs/canvas` renderer, at most20pages and bounded image bytes/
pixels; mixed PDFs keep text-layer pages local. The worker caps concurrency1–8,
keeps page order, and writes complete text atomically to the same table/index.
Extractor identity records OCR version/provider/model/endpoint hash; cache reuse
requires that identity plus the file hash. Failed or cancelled OCR never overwrites
good text. A provider rate limit stops later requests in the run, without retries.
Needs-agent items include localPath; it is a filesystem reference, not remote
artifact transport. OCR contract.

**Searches** (version 17) are one table, `searches`: every successful `search messages` and `stats messages show`
run records its parameters as canonical JSON (`searchRecordOf`, `src/services/searches.ts`) — never a
message or a result — from `MessagesService`, so the command and the MCP tool both record. An identical
unnamed run counts on its row (a unique index over command and parameters where the name is null); unnamed
rows past the newest 1,000 are dropped. A named row is a saved search, which `--saved` re-parses on every
run. `--no-record` (`ServiceDeps.history: false`) records nothing; a bot's search calls `searchStore` and is
not recorded.

**Where the queries live.** `src/store/store.ts` holds the `MessageStore` interface and `storeOver`, a
facade that opens the transaction and delegates. The SQL is in `src/store/sqlite/`, one module per kind
of record — `accounts`, `identities`, `chats`, `messages` (writes), `reads`, `search`, `ranges`,
`sync` (state and fetch leases), `transcripts`, `conversations`, `tags`, `searches` — as plain functions taking a `StoreContext`: the
connection as the `CacheDatabase` seam and as Drizzle (`orm`), and the clock. Queries are Drizzle's
builder, called synchronously (`.get()`, `.all()`, `.run()`); FTS `MATCH`, `json_extract` and the
`coalesce(excluded.…)` upserts stay `sql` fragments. Use `inTransaction`, never Drizzle's
`transaction`. A statement that runs for every saved message is `.prepare()`d once per store
(`identities.ts`, `messages.ts`): built per call, Drizzle cost about a quarter of the load rate
([results](../../bench/search/results.md#the-real-store-after-the-message-writes-moved-to-drizzle)).
`src/store/search-plan.test.ts` fails if search starts reading the text index once per message.

Opening a store also fills `messages.normalized_text` for rows stored before version 6, when at most
5,000 of them wait (`BACKFILL_ON_OPEN`, about 40 ms); a larger file keeps working and waits for the
maintenance command that fills it in batches.

**Two text indexes.** `messages_fts` (trigram over `text`) answers substring search. `message_words`
(version 12) holds the words of `normalized_text` for ranked search — contentless with delete support,
kept by triggers that fire only when the normalized text, the sender or the chat really changed, with
a `scope` column of `c<chat_pk>` and `s<sender_identity_pk>` tokens. Ask its vocabulary through
`message_words_vocab` with `col = 'normalized_text'`, and restrict a word query to that column, or the
scope tokens come back as words. A file of at most `BACKFILL_ON_OPEN` messages is indexed by the
migration; a larger one records in `search_index_state` the highest `pk` the batches must reach.
`fillSearchIndex` (`src/store/sqlite/search-index.ts`) gets it there in batches of 5,000 — the
normalized text first, then the words, then the typo vocabulary (`search_terms`,
`search_term_trigrams`), then the words of messages stored since — from `store migrate`,
`store reindex`, and up to 200 ms before each
`search messages`. When everything is built it returns without taking the write lock. `search messages`
ranks by it. The search's steps over it are in
`src/store/sqlite/words.ts`: `matchWords` (every or any word, whole or as beginnings, bm25 then
newest), `matchSubstring`, and `knownTerms` and `termCandidates` for typo correction. A chat or
sender of at most `SCOPE_TOKEN_LIMIT` (100,000) messages is filtered inside the index by its scope token, a larger
one by a join; `src/store/search-plan.test.ts` fails if any step reads an index once per message.
`search` (`src/search/search.ts`) runs them in the plan's order — every word topped up by beginnings,
typo correction, any word unless the query chose with OR, substring — each only when the one before
found nothing, and by substring alone until the word index is ready. Its tests are the owner's
scenarios (`docs/storage/search-indexes.md`).

**Stems (version 15).** `message_stems` holds the Snowball stems of `messages.text` — stemmed before
folding, by `createStemmer` (`src/search/stem.ts`) — in the same shape as `message_words`: contentless
with delete, the same tokenizer, the same `scope` tokens. A `text` term or phrase matches the word index
OR the stems (`src/store/sqlite/lucene.ts`), so no exact hit is lost to a different fold; `exact:` reads
the words only. A stemmed query is driven by a materialized set of the messages its indexes name, read by
key, and ranked by a materialized stems bm25 joined LEFT, exact forms first — joining the stems as the
ranked table would drop exact-only hits, and joining it row by row was 80× slower (`bench/stemming`).
While the stems are building, or chosen by a newer tool, search and stats run a stemmed query on the word index alone and say so in `query.stemming` (`applied: false`); only stems waiting for the owner's `store reindex` refuse with `index_not_ready` (`searchStemming`, `src/services/messages-search.ts`). `serve` fills building stems a slice at a time (`stemFills`). A default the store saved carries `origin: "default"` and the defaults' version, so a newer default replaces it and an older build leaves it. SQL cannot stem, so the triggers only queue the message in `message_stems_pending`, and JS
writes the stems (`src/store/sqlite/stems.ts`): every store write empties up to 500 queued messages
before its `COMMIT`, and `fillStems` stems the messages up to the watermark and then the queue — on
open for a small file, in `store migrate`, `store reindex`, and inside the same 200 ms before a search.
The `analyzer` column of the row records the Snowball version and stemmer choices that built it; the
first fill claims an unbuilt row. The choices are store-wide (`store_settings`, written by
`config set searchStemmers.cyrillic|latin`), since every profile, tg and MAX share one index. Ready
means filled to the watermark, an empty queue, and the analyzer this binary would build — an older
binary runs the triggers and never drains, so a flag alone would lie. Stems built by other choices are
written by nobody and rebuilt only by `store migrate` or `store reindex`, never by a search, so two
tools with different settings or Snowball versions cannot rebuild each other's index in turn; a row a
newer Snowball built is refused with "upgrade this tool". The first claim and every rebuild also save the
choices, so a tool with another default sees a setting and refuses as "unknown" instead of rebuilding.
`latin` may name several stemmers: each Latin stemmer gives a stem sequence, and the distinct ones are
stored apart by `STEM_SEPARATOR` so a phrase never spans two; a query is the OR of its phrases.

**Notes and links (version 25, plan).** `MessageStore.notes`
(`src/store/sqlite/notes.ts`) holds the owner's records, which belong to no account: `note_folders` (an
id; the path is each computer's config), `notes` (from a file or written here) with `note_revisions`,
`entities`, and `links` — every connection, both ends a typed reference (`src/domain/references.ts`). A
link whose written target names no one yet keeps `target_folded`; creating, renaming or aliasing a person
resolves it in the same write (`resolvePersonLinks`, called from `identities.ts`, `private-people.ts`,
`person-links.ts`). `KnowledgeStore` and `contacts notes` read and write these tables. Builds before 25
may still write the old ones, so `openStore` copies what is missing on every open
(`src/store/sqlite/notes-copy.ts`, behind `notesToCopy`).

**Notes' search indexes (version 26).** The same words and stems as messages — `note_words`,
`note_stems`, same tokenizer and the store's stemmer choices — and `note_chunks`, whose hashes find their
vectors in `chunk_vectors` beside the conversations'. Triggers on `notes` only queue the note in
`note_index_pending`; `drainNoteIndex` (`src/store/sqlite/note-index.ts`) writes words, stems and chunks
in JS before every notes search, `chunksToEmbed` and `nearest`, and in `store migrate` and `store reindex`.
Notes are few, so a change of stemmer choices queues them all again at the next drain instead of waiting
for a reindex. `searchNotes` (`src/store/sqlite/note-search.ts`) compiles the same parsed query as
messages over the fields a note has (`text`, `exact`, `body`, `tag`, `date`, `in`) and refuses the rest;
`searchNotesQuery` (`src/services/notes-search.ts`) is the service a `search notes` command calls.

**One `search` group (plan, STANDARD.md "Search hierarchy").**
`src/cli/messenger/search-command.ts` mounts `search all|messages|mail|notes|conversations` (and
`topics` where the messenger has forum topics); `bot search messages` sits under `bot`. Each leaf calls
the service the old command called, and the MCP tools are named after the leaves
(`src/mcp/tools/search-tools.ts`). `searchAll` (`src/services/search-all.ts`) runs messages (every
messenger account, never mail), mail and notes in turn and merges their lists by reciprocal rank, so
no resource's own scores are compared with another's. A resource that cannot answer the query — a
field it lacks, or nothing stored — is listed in `skipped` with the reason instead of failing the search.

**Server search beside the archive.** `messages.search` with `backend: both|server` first runs
`searchServer` (`src/services/server-search.ts`): it turns the resolved query into at most three
server queries (required words, one chat, one sender, dates), calls the optional `MessageSearch`
capability under a time bound, looks up which hits the store already held, and saves the rest with
`via: "search"` — never `markRange`, so ranges and coverage stay what `store fetch` proved. The strict
local query then runs once over everything; `server` restricts it to the returned messages
(`QueryExecution.only`). A page that arrives after the bound is dropped unsaved. The step is not wrapped
by `stored`, because it must look before it saves.

**Drizzle is bundled, not installed.** `drizzle-orm` is a development dependency. `pnpm build` runs
`scripts/bundle-drizzle.ts`, which writes the Drizzle modules the store uses into
`dist/store/sqlite/drizzle/`: loaded from `node_modules`, Drizzle costs Node about 200 ms per
process, bundled about 6 ms. So:

- Import Drizzle only through `src/store/sqlite/drizzle/` — `core.ts` for the query builder and
  schema functions (add a name there when you need one), `node.ts` and `bun.ts` for the drivers.
  Anywhere else, `biome.json` refuses `drizzle-orm` (`noRestrictedImports`, `biome.json:40`); the
  folder itself and tests are exempt (`:84`). A direct import passes the tests and crashes tg and max
  at runtime, where `drizzle-orm` is not installed.
- The Node and Bun drivers are separate bundle entries and are loaded by dynamic `import()`: each
  imports its own runtime's SQLite at the top of its file, so loading one under the other runtime
  fails.
- `scripts/check-dist.ts` refuses a `dist` that still imports `drizzle-orm` and reads a row through
  the bundle. CI runs it under Node (`pnpm check:dist`) and under Bun (`bun scripts/check-dist.ts`).

**Snowball is vendored, not installed.** `src/search/snowball/` holds the official Snowball 3.1.1
JavaScript for Russian, Spanish and English, generated by `bin/snowball-update` (BSD-3-Clause, also in
`THIRD_PARTY_NOTICES`). Never edit it by hand; `bin/snowball-update --check` proves it matches the
source. `tsc` does not emit JavaScript it did not compile, so `pnpm build` copies it with
`scripts/copy-snowball.ts`, and `scripts/check-dist.ts` stems a word from `dist`. Use it only through
`createStemmer` (`src/search/stem.ts`): it picks the stemmer by the script of a word, stems, then folds
with `normalize()`, and its `identity` names what built an index.

### Migrations

One migration, store version 1, creates every table in [`docs/storage/schema.md`](../storage/schema.md),
in the file `wirecat.db`. It is one folder under `drizzle/`: the SQL `pnpm db:generate` wrote from
`src/store/sqlite/schema.ts`, then the FTS5 indexes, their triggers, the `WITHOUT ROWID` search-term tables and
the seed rows, which Drizzle cannot model. `pnpm db:bundle` copies it into
`src/store/sqlite/migrations.generated.ts`, and `src/store/sqlite/manifest.ts` numbers it. Our runner (`migrate`)
applies migrations under `BEGIN IMMEDIATE`; Drizzle's own migrator is not used.

The schema before this one lived in `messages.db` and is not converted: the new file has a new name so that a
build still installed never opens it. Every migration after the first is forward-only, additive, numbered, and
never edited once it reached anyone's file — a test refuses a generated rebuild of a base table.
`min_compatible` lets an older CLI keep using a file a newer one migrated; a migration that drops what an older
build reads raises it, and that build then refuses the file and asks to be upgraded. It is 1.

⚠ **Announce a migration number before writing it.** Several sessions work in this repository at
once, and two of them taking the same number is a conflict no rebase fixes. The next free number
lives in [COORDINATION.md](COORDINATION.md#store-migrations); take
it by editing that line in a PR of its own, merged before the migration.

#### Adding a migration

1. **Take the number** as the paragraph above says, and wait for that PR to merge.
2. **Change `src/store/sqlite/schema.ts`**, then `pnpm db:generate --name version-<n>-<what>`. It
   writes `drizzle/<timestamp>_version-<n>-<what>/migration.sql`.
3. **Read the SQL before anything else.** For a constraint change (a new `NOT NULL`, a changed
   default, a foreign key), drizzle-kit rebuilds the table: `CREATE TABLE __new_…`, copy, `DROP TABLE`,
   `RENAME`. A build already installed breaks on that, and on `messages` the `DROP` also removes the
   full-text triggers. Choose a change drizzle-kit can express as `ALTER TABLE … ADD` — a new column is
   nullable or has a default — or a new table. The test "never rebuild a base table"
   (`src/store/sqlite/manifest.test.ts:14-19`, `:47`) refuses the rest.
4. **Triggers, FTS5 tables and data fills go in a custom migration**, since `schema.ts` holds neither
   triggers nor FTS: `pnpm db:generate --custom --name version-<n>-<what>`, then write the SQL into
   the empty file. Put `--> statement-breakpoint` between statements — the bundle splits on nothing
   else (`scripts/bundle-migrations.ts:20`), so a trigger body with `;` inside stays whole. Generate
   it right after step 2: folders apply in name order, which is their timestamp.
5. **Add a row to `MANIFEST`** (`src/store/sqlite/manifest.ts`) for each new folder, with the same
   `version`. Two folders with one version — the generated one and its custom one, as version 6 —
   apply as one migration and write one `schema_migrations` row. Versions run on without a gap
   (`manifest.test.ts:38-45`).
6. **`minCompatible` stays where it is** — 1 today — for an additive change. Raising it locks every
   older build out of the file: ask the owner first; it is a major version of this package, and
   tg-cli and max-cli ship their upgrade the same day, as with version 6.
7. **`pnpm db:bundle`** after every `db:generate` and every edit of a `migration.sql`. It rewrites
   `src/store/sqlite/migrations.generated.ts`; `pnpm build` does not, and the test "are bundled
   exactly as drizzle-kit wrote them" (`manifest.test.ts:22`) fails until you run it.
8. **Test the upgrade**: a `src/store/version-<n>.test.ts` opens a file at version n−1, migrates it and
   reads what the new version added. `src/store/sqlite/schema.test.ts` opens a new store and compares
   every table and column with [`schema.md`](../storage/schema.md), and compiles every trigger:
   change the page with the schema.
9. **CHANGELOG**: an entry under `## Unreleased` that names the store version, as "Chat members in
   the store (store version 7)" does.

A migration is frozen once released: fix a mistake with the next version, never by editing a folder.

### Open tasks

Tasks waiting on the owner belong to `@wirecat/cli-tasks`, which knows no messenger and no SQLite.
The store implements its `TaskStore` as `store.tasks`, in the `tasks` table (store version 20,
`src/store/sqlite/tasks.ts`), so backup, restore and export carry tasks with the messages, and a task
joins its message in one query. A task holds a locator, never the message text; `kind`, `state` and
`origin` are checked in code, as `chats.kind` is.

## The command skeleton

`run()` (`src/cli/program.ts`) never throws; it returns an exit code. It lifts a profile given as
the first word, resolves settings (flag → environment → file → default, `src/cli/settings.ts`),
records runs (`src/cli/runs/`) and closes what a command holds when `--timeout` ends it
(`src/cli/deadline.ts`).

Optional `ProgramDefinition.configure`, `prepare` and `onFailure` let a consumer add root options,
provide legacy command context and settle its own recording before the shared fallback.
Help/version exits skip failure settlement. The lifecycle contract
describes the order and failure behavior.

A CLI describes its messenger once — a `Messenger` (`src/cli/messenger/context.ts`) with a
`connect` that returns a `MessengerAdapter` (`src/cli/messenger/port.ts`) — and gets the shared
commands, one file per resource in `src/cli/messenger/`. Two wrappers sit between a command and the
adapter: `observed.ts` times each call into the run record, `stored.ts` saves what was read. A new
adapter method is optional and reached with `capability()`; the wrappers pass through any method
they do not name. How to write an adapter for a new messenger, and test it with the contract cases,
is [the adapter guide](ADAPTERS.md).

The MCP server (`src/mcp/`) holds one connection for minutes and runs one call at a time; each tool
lives in `src/mcp/tools/<resource>.ts` and answers what the command's `--json` prints.

`mcp --http` (`src/mcp/http/`, CLI-58) serves the same factory over Streamable HTTP on 127.0.0.1 behind the
owner's tunnel. `oauth.ts` is a one-owner OAuth server — a token needs the code printed in the terminal, and
only token hashes reach the disk; `serve.ts` checks the Host, answers the login routes, requires a bearer
token for `/mcp`, and sends 2025-era requests to per-session servers bound to their OAuth client, because a
stateless server forgets the form capability a client declared in `initialize`. Writes over HTTP follow the
profile's permissions exactly as over stdio; no form is forced (NEED-774, which replaced NEED-593).

## Services

Five layers, each calling only the ones below it: the **domain** (`src/domain/`), the **adapters**
(each CLI's own, behind `MessengerAdapter`), the **ports** (`port.ts`, the store), the **services**
(`src/services/`) and the **interface** (the commands and the MCP tools). `biome.json` refuses an import of `commander` or
of a command file from `src/services/`, `src/sends/` and `src/mcp/`: what a service or an MCP tool
shares with a command lives in the service, and the command imports it.

A service is a plain object made by a factory over `ServiceDeps` (`src/services/deps.ts`): the
messenger, `offline`, and a connection, a store and an account that are each opened on first use —
so a read from the store never connects. `servicesFor(deps)` hands out `messages`, `chats`, `people`,
`inbox` and `archive`. A command gets them from `withServices` on its context, which closes what was
opened; an MCP tool builds them over the session's connection with `onlineDeps`, or over the store
with `storedDeps`. The services callback can also borrow the held
connection for hearing. It fetches recordings on that connection and releases it before local
recognition; closing is awaited once, and store cleanup still runs if closing rejects. Review's
optional `enrich` hook runs after admin lookups and before unanswered filtering, so transcript text
can supply a voice question without changing the archived message text. MCP retains session-owned
connections. Either way a command and its tool run the same method, and so answer the same
error for the same input. Each caller still parses its own input, so an error names `--since` in a
command and `since` in a tool.

**A messenger that pushes its history reads it from the store.** `Messenger.history: "store"` sets
`ServiceDeps.reads`, and every read that `--offline` answers from the store — `chats list|show`,
`messages list|context`, `contacts list|show` — answers from it for that messenger without
`--offline`, and never connects; writes still do. `serve` keeps the store filled, so such a read
warns on stderr when no `serve` holds the profile, and a chat with nothing stored is `not_found`.
`inbox` and `review` read the stored chats and messages through `storeReader`, the same code over
an `InboxReader`, so their `--json` is the online one; `store fetch` refuses for now. The MCP chat
resource reads the store too, and so does an MCP tool with a `served` body: it gets the services
over the store and reaches the session's connection only through `connect`, for transcription.

**A CLI replaces a use case, not a command.** `Messenger.services` is an `Override`: it gets the
shared services and returns the ones it changes, and can call the shared method inside its own:

```ts
services: (base) => ({
  messages: { ...base.messages, list: (chat, window) => maxList(base.messages, chat, window) },
}),
```

Commands and MCP tools both see the replacement. To add a subcommand, a CLI calls `addCommand` on
the command a factory returns.

Saving what a read answered and timing each call stay decorators on the adapter (`stored.ts`,
`observed.ts`), stacked by `connected()` in `context.ts`, so no service can forget to save.

## Who consumes it

- **tg-cli** — the whole skeleton, the store, the guard and the MCP server; its adapter is under
  its own `src/telegram/`. To try an unreleased change: `bin/try-messaging` in a tg-cli checkout
  beside this one, never a committed `file:` path.
- **max-cli** — both its personal account and its bots. The personal account is a
  `Messenger` (`src/messenger.ts`) whose `connect` returns `maxAdapter` (`src/adapter/max-adapter.ts`)
  over max's own protocol client, and it uses the shared commands, services, store and guard; its
  own cache is gone. max keeps its protocol, session,
  `max serve`, the Bot API slice and its own MCP server (`MaxSession`, `src/mcp/server.ts`), whose
  tools run the shared services through `withShared` (`src/mcp/shared.ts`).

Both pin an exact version; a change here reaches them through a release and a bump in each.


## Package upgrades

`upgradePackage` (`src/services/package-upgrade.ts`) owns the explicit upgrade decision and invokes
installer/latest/install and optional host lifecycle ports. `upgradeCommand` renders its outcome;
consumers bind their existing update environment and server restart policy. No installer runs on
check/no-op paths, and a failed install or callback never retries. The upgrade plan
describes the common result and consumer adoption.


## Agent conversation linking over MCP

`conversations_batches_status` reports messages, batches, characters and a token estimate before
text is fetched; `conversations_batches_next` returns the next window or `{ batch: null }`.
`conversations_links_add` stores batch answers atomically, `conversations_links_clear` drops them,
and `conversations_build` rebuilds one stored chat without inference. The last three write only
locally under `conversations.links`: readonly/deny hides them, ask refuses with the config key.
The `link-conversations` prompt reads the same shipped skill as the CLI; its cost/consent gate is
per chat. These tools call `services.conversations`; inference in this MCP loop belongs to the
owner's agent. The explicit CLI `build --analyze` path can call a
configured provider with consent; see [AI providers](../search/ai-providers.md).

Consumer parity: planned for both CLIs on their next SDK adoption. Source-level shared schema and
synthetic MCP proof are tested here; installed consumer parity is not claimed before publication.

## Bounded preparation after history fetch

Per-profile `searchCatchUp` defaults to false; store fetch can override it with --catch-up or
--no-catch-up. The fetched chat alone is prepared with500chunks,10,000messages and30seconds by
default. Explicit budgets have hard caps. Invalid permissions/bounds refuse before connection;
missing local e5 keeps graph-only progress, without downloading a model or using a remote provider.
Fetched history persists even when preparation stops; the result reports a separate prepared state.

Cancellation checks run through input reads, linking, chunk cutting and staged publication. A
failed staged build leaves the previous published generation available. Completed builds remain
valid if later vector preparation stops. Edits and successful rebuilds prune affected vector hashes,
verifying current text across shared users. Shared-use checks are bounded; an inconclusive hash is
kept rather than removing another account's valid cache. Deletion safeguards remain in force.

## Interior archive gap repair

`store gaps plan <chat>` uses recorded inclusive coverage ranges, with versioned account/chat/order
identity and a fingerprint. Unknown archive edges remain separate from interior gaps; message-id
holes and quiet periods alone do not establish missing history. Planning is local.

`store gaps repair <chat>` explicitly fetches up to five gaps and500messages within30seconds by
default. `--max-gaps`, `--limit`, `--repair-time`, `--page-size` and `--pause` set bounds. Optional
`--fingerprint` refuses a stale plan before connecting. A per-account/chat lease prevents concurrent
repairs, while every page persists through the existing ingestion path. Repeated timestamp pages,
partial responses and inaccessible history stay pending; nothing is deleted by absence. Re-running
plans the remaining ranges. `--background` uses `store jobs show/list/cancel` and captures the plan's
fingerprint. MCP offers matching plan/repair and profile-scoped job metadata tools.

Repair requires `store.gaps.repair` write permission and message read access. The optional
`Fetching.beforeInclusive` adapter declaration describes native timestamp cursors; it does not
change regular fetch behavior.

Repair accepts the same catch-up overrides and budgets as fetch. One preparation follows the repair,
within its remaining overall time budget; history completeness and preparation progress stay separate.


### Adapter settings compatibility

`settingsFor(app, extension)` owns common settings resolution. An optional `resolve` hook receives
resolved common settings, ordered personal/bot/profile/default layers and `fromLayers`; it returns
adapter values and their sources without rereading configuration. `profile` and `defaults` extend
the generated strict schema. An optional `schema` validates both reads and writes when an existing
consumer needs stricter scope rules or unchanged errors; it must produce the common configuration
shape, including `profiles`. `sourcePaths` opts into full configuration paths, including legacy
permission provenance. `parseDuration` preserves a consumer's duration syntax and diagnostics.
Without these hooks, existing source labels, validation and duration parsing stay unchanged.

## Administrator statistics

The shared `adminStatistics` service implements unanswered, selected-identity response times,
known-join newcomer help and stored discussion reports. `admin-statistics.ts` in the SQLite seam
uses compiled query selection and bounded context within one read snapshot. Question selection is
separate from reply context through a captured cutoff. Membership stays distinguish joinedAt and
firstSeenAt. Reports and their saved runs reuse existing CLI/MCP discovery and evidence paths; a
separate versioned selection binds query, options and cutoff. See the [user guide](../rankings.md).

## Retention and counter observations

Migration 24 adds `membership_batches`, `membership_batch_members` and
`message_counter_observations`. Only explicit remote reads/updates record observations.
Legacy rows are not backfilled with observation times. Batch membership points to identities and
separate stays; partial lists cannot close stays. Definite known rejoining dates split stays.
Invalid, duplicate and out-of-order roster observations are rejected atomically.

Retention uses SQL lookup of the first batch within a checkpoint's 24-hour tolerance, then bounded
cohort aggregation (10,000 stays, ten checkpoints, 8 MiB fingerprint, 64 KiB evidence).
One read transaction pins membership and activity. Cohort selections freeze cutoff and options;
existing message-evidence CLI/MCP paths page through member evidence.

Counter timestamps are independent by field and tied to the exact observed value. A legacy writer
can still use schema 6 statements; differing legacy values have unknown freshness. Counter-only
updates preserve other message fields and ignore tombstones. An older response cannot replace a
newer authoritative observation. Rankings/evidence expose these states and fingerprint observation changes.

The optional adapter `fetchCounters` returns explicit counter observations; `Messenger.counterFields`
declares static support for a connection-free preview. The shared service resolves a bounded query or
exact locator selection before connecting and guards `stats.messages.counters.refresh` as a local write.
It closes stalled connections on abort and records partial results without message actions.
CLI commands and the existing three-tool MCP frontend share this service. See [statistics guide](../rankings.md).

## Shared result projection

The CLI's `fieldsOf` export is cli-core's parser, and `projectFields` delegates to core's projection.
List envelopes, operation identifiers, parent selections and `items.id` semantics remain unchanged.
A thin wrapper preserves empty direct selections as metadata-only output. Parsed paths retain the
existing limits of 128 paths and 256 characters each; direct invalid paths now reject before traversal.
The runtime peer and development pin require cli-core 0.19.2 so every consumer has these exports.
The messenger runner retains its own write and resource lifetime policy; no store schema is involved.
