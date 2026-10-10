# @wirecat/cli-messaging

The messenger-neutral half of a messaging command line tool, shared by
[`tg-cli`](https://github.com/WireCatLabs/tg-cli) and [`max-cli`](https://github.com/WireCatLabs/max-cli).
Built on [`@wirecat/cli-core`](https://github.com/WireCatLabs/cli-core), a peer dependency: the CLI installs
it itself, so the install holds one copy.

**Status: on npm** — what each version changed is in [CHANGELOG.md](CHANGELOG.md). The domain model, message locators, message rendering, name
resolution, the SQLite seam that runs under Node and Bun, and the first part of the command
skeleton with the shared read commands, the send guard, run records and the message store — see
[the platform proposal](docs/dev/BACKLOG.md).

## Retained meeting references

`parseMeetingReference`, `formatMeetingReference` and `canonicalMeetingReference` name local meeting
records as `meeting:<accountId>/<meetingId>`, a retained transcript revision with `/<transcriptId>`,
and one cue with `/<cuePosition>`. IDs are positive safe integers; cue positions start at zero.
These references stay within one store and retain the exact revision after a correction.
They use a dedicated parser; the general `parseReference` and existing knowledge targets do not
accept them yet. A reader must verify the caller's authorized account before returning content.

## The rule this package keeps

**Nothing here knows a messenger.** An adapter translates its provider's objects into these types,
and a lint rule refuses any import of a messenger library or an adapter under `src/`. What only one
provider has travels in `providerMetadata`.

| | |
|---|---|
| `.` | `Chat`, `Message`, `Contact`, `Page`… · `formatLocator` / `parseLocator` · `renderMessages` · `pickChat` / `pickPerson` |
| `./charts` | neutral chart data, a replaceable renderer interface and on-demand dark SVG and PNG images |
| `./models` | `modelGateway`, provider-neutral requests, adapter-owned option checks, injected keys and purpose consent, and `modelTarget` for effective configuration; [provider settings](docs/search/ai-providers.md) |
| `./store` | `openCache` — `node:sqlite` under Node, `bun:sqlite` under Bun, WAL and a busy timeout on both · `openStore` — the shared message store, every method async: one file for every messenger (`MESSAGING_STORE` overrides where), forward-only migrations with `min_compatible`, every sender an identity with a person of their own, edits kept as revisions, a message by its id, deletions kept as tombstones, trigram search · `find` — by text, by sender, or both; `together` for the chats where every sender wrote, `perChat` to cap each chat · `savePeople` and `people` — usernames and bot flags, and a `PeopleLookup` for `pickPerson` |
| `./sends` | the send guard: a level per command path (`permissions`: deny, readonly, ask, allow — `readOnly` and `allow` read as levels), a recipient list, an hourly limit, and a journal of every attempt that never holds the text; `newSendId` for a send's identity across retries |
| `./cli` | the command skeleton: `run` (never throws, returns an exit code), the global flags, `settingsFor` (flag → environment → file → default, one strict file schema with each CLI's own fields), the profile as the first word, `--timeout` that closes what a command holds, paging, and run records: `--record` keeps a run's ids and timings (never content), a failure is kept unless `--no-record`, and `runsCommand` gives `runs list\|show\|path` · `configCommand(app, config)` shows and changes the settings with where each came from, and `config migrate --dry-run` previews translation of legacy access settings before `config migrate` saves it; `migratePermissionConfig` provides the same layer-preserving transformation to consumers · `completeCommand(messenger, config, options?)` gives shell completion, account-scoped chat and person ids from the store and never a connection; `options.sources` can supply local suggestions for a separate command group and `options.account` can read an existing local account binding · `storeSummary(env)` gives its local store diagnostics to consumers retaining their own doctor command · `doctorCommand(messenger)` reports the installation's state from disk (the store, the account, sends, runs, the messenger's own checks), and connects only with `--online`; `doctor report create` writes that, the failed run and the recent sends to a file with every id a label · `skillCommand(app, url)` prints the CLI's own SKILL.md for an agent (`skill show`) · `commandsCommand(app)` describes every command as JSON, with `contract` (`CONTRACT`, the major version of the output types) and which commands write · the shared read commands: a CLI describes its messenger once (`Messenger`: its app, a `connect` that returns a `MessengerAdapter`, how `me` maps to a chat) and gets `accountCommand`, `chatsCommand` (`list`, `show`), `contactsCommand` (`list`, `show`) `recipientsCommand`, `sendsCommand`, `watchCommand` (new messages as they arrive, `--jsonl`, until Ctrl-C or `--timeout`; `--events` adds edits, deletions and reactions, each kept in the store), `storeCommand` (the local store: `store fetch` puts a chat's history into it, resumable, FloodWait-aware, `--since` to stop at a time, `--background` for a detached job that `store jobs list|show|cancel` follow, `--estimate` to only price what is left from the store alone; `store status` what it holds; `store export` a chat's messages out of it, as JSON or `--format markdown`; `store clear --left` deletes the chats the account has left; `store info`, `store check`, `store migrate`, `store backup` and `store restore` look after the file itself — its size and schema, whether it is healthy and which chats are behind, bringing it up to this build, and a copy to go back to), `inboxCommand` (other people's unread messages in every chat, or with `--new` what arrived since the last check — each message once, the point moved only by a run that printed; copied from max-cli), `serveCommand` (keeps the store current until stopped — one per profile by a lock file, catch-up on, started by a person, `server start` or a unit), `serverCommand` (`server start|stop|restart|status|logs`: `serve` in the background, as max-cli's `server`; `install|uninstall` add a systemd user unit or a launchd agent per profile, and `install` starts nothing), and `messagesCommand` (`list`, `show`, `context`, `search` over the store by any three letters inside a word, or `--regex`, `send` through the send guard (`--reply-to`, `--silent`, `--no-preview`, `--md`, `--file` and `--photo` with the text as the caption, and `--at` to send later, with `scheduled` listing the queue), `edit` of the owner's own message, `forward` to another chat and `pin`/`unpin` through it too (the adapter's optional `edit`, `forward`, `pin` and `unpin`), and `delete` — at most 10, for the owner unless `--for-everyone`; it asks first by default, and `--allow-dangerous` is the yes · `reactionsCommand` (`add`, `remove`: the owner's reaction on a message, through the guard; the adapter's optional `react`) · `pollsCommand` (`show` a poll with its answer ids, `vote` by id or `--retract`, `close` the owner's own, `create` one — a vote guarded as a reaction, closing as an edit, a new poll as a message with a send id); a `msg:` locator names a message) — every read saved to the store, `--offline` answered from it, each call a run event · `mcpCommand(messenger)` serves the profile to an agent over MCP on stdin and stdout (copied from max-cli: one connection held for minutes, one call at a time, read tools named `<cli>_<command words>` answering what `--json` prints, `<cli>_status` without connecting; the write tools — `<cli>_messages_send`, `_edit`, `_forward`, `_pin`, `_unpin`, `_delete`, `<cli>_reactions_add`, `_remove`, `<cli>_chats_mark_read`, `<cli>_polls_vote`, `_close` and `_create` — are offered by the profile's `permissions` and run through the same guard as their commands; a write at level `ask` follows the host approval boundary and profile permissions without a form; retired confirmation flags only warn, and `messages_delete` never deletes for everyone), and `mcp config` prints the entry for a desktop client · `mcp --http` serves the same tools over HTTP on 127.0.0.1 behind the owner's tunnel with a one-owner login; a CLI with its own MCP server mounts `serveOverHttp(build, options)` with `httpServerOptions(mode)`, `httpTokenFile` and `revokeAll` (`OVER_HTTP` follows the same profile permission policy) |
| `./testing` | the adapter kit — **not stable yet**, so it may change in any release: `fakeAdapter(seed)`, a messenger in memory with every method group, for command tests; `contractCases({ connect })`, the port's promises as cases any test runner runs over an adapter; `contractSeed`, the chats and messages they read. How to write an adapter and run them: [the adapter guide](docs/dev/ADAPTERS.md) |

⚠ **Errors are recognised by shape, not by class** (`isCliFailure`). A package linked during
development brings its own copy of cli-core, and an error built by one copy is not an `instanceof`
the other's class.

Field selection uses cli-core's `fieldsOf` and `projectFields`; list envelopes and operation IDs
stay intact. Direct empty field lists keep only operation metadata, preserving the existing helper
contract. Direct invalid or unsafe paths are rejected before projection. cli-core 0.19.2 or newer
within the 0.19 series is required.

`searchAllIncludingMeetings` from `./services` adds one selected meeting account to the existing
message, mail and notes search. It leaves `searchAll`, its item references and the current CLI/MCP
commands unchanged. Choose another meeting account explicitly:

```ts
const found = await searchAllIncludingMeetings(store, account, {
  text: "project AND plan",
  limit: 20,
  meetingAccount: { provider: "zoom", account: "zm-profile:example" },
  maxMeetings: 100,
})
```

Meeting hits have `kind: "meeting"`, `accountId`, `meetingId`, `scope`, `id` and `startMs`, with no
canonical `ref`. They contain text previews of at most 2000 characters; their meeting timestamp can
be null. The existing unified ranking and the meeting list are blended by reciprocal rank. Meeting
order follows newest meeting first, then stored hit order; it does not claim a relevance score.

Meetings support letter/digit words joined by AND, including adjacent words, as word prefixes.
Exact forms, phrases, OR/NOT, patterns and field/date filters skip only meetings with a reason.
The meeting account defaults to `account` and is looked up without registration. Search reads
current transcripts, chat and summaries and excludes deleted meetings.

`maxMeetings` limits visited candidate meetings (1–1000, default 100), while `limit` bounds returned
items (1–1000). The store can allocate many hit rows within one candidate meeting; this service
cannot promise a hard query memory bound. `hasMore: null` means the scan stopped before proving
whether another match exists. `meetings.complete` describes the selected source's scan, and
`meetings.nextCursor` resumes with `only: ["meetings"]`, the same query and the same account. It
retains unreturned hits even when another resource filled the result limit. This is a meeting source
continuation, not a global cursor or a snapshot; changing archive contents can require restarting.


A **message locator** names one message across every provider and account:
`msg:telegram/<account>/<chat>/<message>`. A message id alone does not — Telegram numbers messages
per chat in channels and per account in private chats.

Forum addressing is an optional adapter capability: `messages send --topic` and `polls create --topic`
pass `threadId` through the shared service/guard. `validateThread` checks the topic and any reply
before sending, after the permission gate. Telegram group forums support it; MAX refuses it.
Journal records carry only the thread id. A retry keeps the same send id, chat and topic; scheduled
sends must be checked in the queue instead of repeated.

Consumers retaining their own personal MCP session can import `personalMcpTools`,
`registerPersonalMcpTools`, `personalMcpConfirmer` and the `PersonalMcpRegistration` types from
`./cli`. Filter unsupported provider capabilities before mounting. The host supplies its held
session, account-scoped store, defaults and permission scope (`around`); `withServices` and
`resolveChat` bind its service overrides and confirmation titles. Session callbacks receive a
`release` function for local inference. The host closes `warmEmbedders()` on shutdown. The same
strict catalogue is mounted by the built-in server; unknown arguments fail before execution.

## Media options

`messages send --spoiler` hides a photo or video until tapped, and `--caption-above` shows the text above the
attachment (send tool: `spoiler`, `caption_above`). A messenger offers them through `Messenger.mediaOptions`;
where it is unset the service refuses them before connecting, so an adapter that does not know an option never
receives one to drop. Both need an attachment. Per-message forward protection is left out: Telegram grants it
to bots only, and a personal account protects a whole chat instead.

## Sender identities

`chats send-as <chat>` lists who the account may post as in a chat: `{ id, title, kind, premiumRequired,
default }`, `kind` being `self`, `channel` or `group`. The personal identity is always in the list, and
`default` marks the chat's saved choice. Reading it changes nothing — the saved choice stays as it is.
`messages send`, `messages forward` and `polls create` take `--send-as <id>` (their tools `send_as`): the
service lists the identities of the chat the message lands in, in the same connection, and refuses an id
that is not there. An adapter without the optional `sendAsIdentities` refuses the option — it is never
dropped, and never falls back to the personal identity. Without `--send-as`, a chat whose saved sender is not
the account (the adapter's `savedSender`, say a group that posts as a linked channel) is refused before
sending: the messenger would post as that sender, and nothing typed said so. The refusal names both ids. The journal records the identity, and a retry of an
unknown send under the same send id must name the same identity.

## Message permalinks

The personal `messages link <chat> <message>` command also accepts a `msg:` locator.
Its read-only MCP tool and CLI call the same service and return `{ locator, url, access, reason }`.
Adapters can implement optional `permalink` to return HTTPS links; its result contains no message
content. Link audience is `public`, `restricted` or `unknown`; a URL grants no membership.
Without support, a validated target returns `url: null`, `access: unavailable`, and a reason.
Offline validates this account's stored message and returns reason `offline`, without connecting.
A locator for another messenger or account is refused. Singular `link` differs from graph `links`.

## Command discovery

The [CLI standard](docs/dev/STANDARD.md#external-references-and-our-adoption-profile) explains
which POSIX, GNU, CLIG and agent-facing conventions we adopt. The [architecture](docs/dev/ARCHITECTURE.md#cli-design-references)
shows where their contracts live; the [compliance audit](docs/dev/CLI-COMPLIANCE.md) records
remaining gaps and deliberate differences.

To discover arguments without reading the whole command tree, run
`<cli> commands messages evidence --json`. Replace the path with any command or group;
`<cli> commands messages --json` includes its descendants. The response retains global options
and exit codes, includes options inherited from ancestor groups, and resolves command aliases.
Give one command path per call; inspect other groups in separate calls.
`<cli> commands --json` still returns the full tree.

## Evidence packets for agents

`prepareEvidencePacket` from `@wirecat/cli-messaging/services` packages a message page that the
caller has already read and authorised. It works with any messenger's domain messages:

```ts
import { prepareEvidencePacket } from "@wirecat/cli-messaging/services"

const packet = prepareEvidencePacket({
  kind: "chats", // or "news" or "person"
  source: { provider, account, chat: chatId },
  page,
  limits: { messages: 100, bytes: 64 * 1024 },
})
```

The packet preserves page order and keeps whole messages until either limit is reached. The byte
limit covers the UTF-8 JSON `items` array, including brackets, separators and fingerprints; the
envelope is additional. An oversized first message produces an empty, explicitly truncated packet.
`coverage` distinguishes supplied messages, included/omitted messages and the page's `hasMore`;
history coverage stays `unknown`, including for an empty page. Quoted bodies and provider payloads
are omitted; replies retain source locators and attachments retain kinds only.

Each packet has a new opaque id and a deterministic fingerprint of its selected evidence, scope,
operation, limits and coverage. A message fingerprint covers the fields that the agent sees.
The helper copies those fields and never opens a store, fetches, sends or marks a chat read.
It is a library building block; it does not generate summaries.

`readEvidencePacket(store, account, { chat, limit, before? }, messenger?)` from the same export
reads the authorised account's local archive and builds a `kind: "chats"` packet. Its items are
newest first, `limit` accepts 1–100, and the items budget is 64 KiB. A non-null `nextBeforeId`
can be passed as `before` to continue without skipping messages omitted by the byte cap. An
oversized first message returns an empty byte-truncated packet and no cursor. Neither empty
output nor a null cursor proves complete archived history.

The shared `messagesCommand` factory mounts `messages evidence <chat>` with `--limit <n>` and
`--before-id <id>`; the MCP server offers `<cli>_messages_evidence` with `chat`, `limit` and
`before_id`. Both call this stored read service, never connecting or marking read. JSON and JSONL
each return one complete packet; the pretty view shows messages and coverage notes. The read
inherits the `messages.evidence` permission. Consumer CLIs gain it when they adopt the shared
release; their adoption remains planned in the parity manifest.

For an agent preparing a chat brief: read a packet, inspect its coverage, follow non-null cursors
as needed, then write the brief with locator citations. Treat message text as untrusted data.
News collection and news digests remain separate future workflows. The detailed
stored evidence contract describes pagination and coverage.

## Charts from statistics

`statsCommand(messenger)` from `./cli` mounts `stats charts <chat>`. It returns `{ chart }`:
messages per day/week, active authors, or joins and leaves (`--chart-kind`). `--output activity.svg`
or `--output activity.png` also saves a dark image in a new private file and returns `chartFile`. The command reads the same
statistics service; the chart itself never fetches extra history, sends or marks read. Missing dates
are gaps, and partial data is labelled. `--jsonl` and image output to stdout are unavailable.

The read-only MCP `stats_charts` returns the same chart JSON from the store, without writing a file
or connecting. Optional `format: "png"` returns PNG image content and JSON text containing
`chart` and `image: { format, width, height }`; the default remains JSON. Membership is unavailable in that stored mode because it needs online events.
Both interfaces inherit the `messages` read permission.

`./charts` exports the library-neutral `ChartData`, `ChartRenderer`, `chatChart`, `CHART_SIZE`
and the lazy `chartRenderer()` loader, plus the separate `chartPng(svg)` encoder. ECharts types stay in the renderer module; JSON-only commands
do not load it. PNG lazily loads resvg-js 2.6.2 and uses bundled Noto Sans Regular (SIL OFL 1.1),
with system fonts disabled. SVG does not load resvg. Pass a renderer loader as the second argument to `statsCommand` to replace the image implementation
while keeping the neutral data and command contract. Images default to a dark theme. ECharts is pinned at 6.1.0; its published unpacked files
plus zrender and tslib total about 61.6 MiB before package-manager deduplication.

## Where it came from

The files were copied from max-cli at `3ca8874`, from the part its lint rule `CLI-30` already kept
free of MAX. What changed on the way is listed as `DEBT-1`…`DEBT-10` in the proposal.

## Checks

```sh
pnpm install
pnpm lint && pnpm typecheck && pnpm test
pnpm smoke:bun    # the same exports, run under Bun
```

## Releasing

Raise `version` in `package.json` through a pull request, merge it, then on `main`:

```sh
bin/release --local   # from this machine: NPM_TOKEN if exported, else the keyring (service npm, account leemour)
bin/release           # from GitHub Actions, once npm trusts .github/workflows/release.yml
```

Both refuse a dirty tree, a branch other than `main` and an unpushed `main`. When npm already has the
version, or a higher one, they commit the next free version to `main` — the next minor for `x.y.0`,
the next patch otherwise — and publish that. They run every check, and tag `v<version>` once npm
shows it. The token is never printed and never
written to a file.

The GitHub form publishes from the job in the `npm` environment, which is what
npm's trusted publisher names: `WireCatLabs` / `cli-messaging` / `release.yml` / environment `npm`.

### How often, and what may break

**Release when a consumer needs it.** Changes wait under `## Unreleased` until then; there is no
gap to keep between releases — tg-cli and max-cli pace their own.

**These exports are stable.** A change that breaks them waits for a **breaking release**, at most one
a week, whose changelog section says what to change in a consumer; tg-cli and max-cli move to it
the same day.

| Export | Stable |
|---|---|
| `.` | the domain types (`Chat`, `Message`, `Contact`, `Page`, …), the message locator |
| `./cli` | `Messenger`, `MessengerAdapter` and its method groups (`MessengerCore` required; `ServerReads` and the rest optional), `createProgram`, `run`, `messengerContext`, the command factories' names and arguments |
| `./store` | `openStore`, `MessageStore`, `storePath`, and the file format: `minCompatible` rises only in a breaking release |
| `./sends` | `sendGuard`, `SendJournal`, the journal's line format |
| `./speech` | The pinned speech-model catalogue and types, model ordering, the shared audio/text directories, installed-file checks and the SHA-256-verified speech installer. Importing it does not load a recognizer or download a model |
| `./services` | `servicesFor`, `Override` and the service names |
| `./background` | `lockPath`, `readLock`, `holdLock`, `releaseLock`, `servingProfiles`, `alive`, `carries`, `holdersOf`, `ServerSystem`, `thisMachine`, `platformFor` and the systemd and launchd units |

`./testing` and `./parity` are not on this list. Everything else may change in any release, and still goes under "Changed — may break callers" when
it does. tg-cli and max-cli take new versions through Dependabot pull requests.

## Licence

[Apache License 2.0](LICENSE).

Forum configuration uses the shared topics service: explicit enable/upgrade and named creation,
with staged guards, original/result chat ids and unknown-outcome handling. Adapters opt into the
forum capabilities; sending and creating a topic never implicitly convert a group. Enabling defaults
to confirmation; topic creation preserves a caller's send id. Local history remains under its
original peer id after migration.

Markdown conversion belongs to each messenger adapter through optional `formatMarkdown`.
Shared personal and bot send/edit use its neutral `FormattedText`/`TextSpan` result; they do not
choose a dialect. New adapters must implement the capability to support `--md`. The legacy
`parseMarkdown` export and `markup` port argument remain available for existing callers.

## MCP from browser clients

Writes over MCP show no form, over stdio or HTTP: the profile's permissions decide, and a level of
`ask` goes ahead, since nobody is at a terminal to answer it. An app's own permission prompt is
separate and cannot be verified by the server; its “always allow” setting may permit later calls
without another prompt.

Repeat `--permission key=level` to override profile permissions only for the server process.
For example, `--permission messages.send=allow` enables sending even in a read-only profile.
A broader key overrides saved descendant keys; built-in defaults still tighten broader grants.
Recipient restrictions and hourly limits remain in effect; no saved configuration is changed.

The browser connector uses the tunnel's HTTPS URL ending in `/mcp`, with the owner OAuth login.
Both legacy session-based and modern HTTP MCP clients are supported. Web clients can use tools
without prompts or resources; neither is required for reading and sending.

Message and author rankings are mounted by `statsCommand`: see the [ranking guide](docs/rankings.md)
for metrics, scores, saved selections, evidence paging and data-quality limits.

### Private contact metadata and automatic tags

Both messenger consumers can keep private contact aliases, scoped to one account, and multiple notes,
which belong to the owner: a contact's notes show in every account that sees the contact.
`contacts alias set <person> <alias>` and `contacts alias rm <person>` affect local display and
resolution only. `contacts rename` continues to change the messenger address book. Show/list
retain the messenger name; a local alias adds `alias` and `displayName`. Duplicate aliases require
an explicit id. Stored direct-chat resolution supports aliases; it never invents a chat id from
an identity id. `contacts show --with-notes` includes private notes explicitly; the notes read permission still applies. Local metadata survives profile refresh and stays on its original identity/account
when identities are linked or unlinked.

`contacts notes add <person> --file <path>` (or stdin) creates a stable note id. Use `list`,
`show`, `edit --revision <number>` and `remove` for that person's notes. Notes are independent of
public bios, imported documents and source messages. They are rows of the store's `notes` table (version
25), linked to the contact, so `search notes` and `search all` find them too. `contacts list --search-notes
<text>` is an explicit substring search over the notes of the selected account's contacts.

`metadata get --chat <chat>` reads the cached group/channel description and fetched time.
`metadata refresh --chat <chat>` reads it from the messenger, without changing the remote chat.
The refresh command accepts repeated chats and a bounded `--limit` (1–500).
`tags auto [--chat <chat>] [--limit 50]` classifies cached title, username and description with
versioned keyword rules. It works offline and uses only stored group/channel titles when there is
no full metadata snapshot. `--refresh-metadata` explicitly fetches descriptions; `--dry-run`
previews cached results without writes. These flags cannot be combined. Results identify matched
fields and a rule score, not a topic probability. No model or message text is used.

Automatic tag claims are distinct from manual labels. Rerunning removes obsolete automatic tags
and preserves manual tags. Adding a label already generated promotes it to manual ownership;
listing generated tags includes `sources`. Use `tags list|remove --source manual|auto` to select one ownership source. Removing a tag without a source removes its claims; a later explicit
automatic run can regenerate it. Upgrade consumers together before relying on manual promotion:
older builds cannot record manual ownership of an already generated label.

Administrator reports are mounted by the same `statsCommand`: `stats messages unanswered`,
`stats contacts responses`, `stats chats newcomers` and `stats messages discussion`. They read
held data only; [the guide](docs/rankings.md#find-questions-and-posts-that-need-attention) explains
explicit reply attribution, selected answerers, unknown joining dates and bounded evidence.


For agent consumption, global `--agent-json` renders control and direction characters visibly in JSON
strings and keys. `--json` retains raw values; `--agent-json --jsonl` applies the safe form to every
streamed record. MCP already uses this form. MCP contact searches keep third-party registries off
unless the caller explicitly sets `registries: true`.
