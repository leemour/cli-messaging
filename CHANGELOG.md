# Changelog

Notable changes to `@wirecat/cli-messaging` (`@leemour/cli-messaging` up to 0.214.0), one section per
version, newest first. Versions follow [semver](https://semver.org/); before `1.0.0` a minor version may
break callers, and says how under "Changed — may break callers". `pnpm docs:check` checks the shape of this file.

## Unreleased

### Added

- `store.botUpdates` records Bot API deliveries once per account and update id, with handling, failure and replay state.
- `store.involvements` rebuilds a person timeline across messages, chats, meetings, mail, tasks and person links; reads
  can filter scope and return newest first through the person index.
- Account and chat scopes, nested chats and message thread roots; conversation vector searches can narrow by scope,
  project, person and time. See [the messaging store APIs](docs/storage/messaging.md).
- `store.decisions`, `store.memories` (a memory needs a scope and evidence), `store.proposedActions` (agent
  proposals that wait for the owner) and `store.agentActions` (one audit row per MCP tool call, never its
  arguments). Topics: `knowledge.createTag(name, { kind: "topic" })` for the owner, `setMainTopic`.
- **`store.meetings`: the shared store's `MeetingStore`**, the port `@wirecat/cli-meetings` 0.2.1 defines (now a
  dependency). It keeps meetings, their series, participants, transcripts with their history, chat, summaries,
  files, calendar events and the pull cursor, and passes the package's `meetingStoreContract`. Search matches
  every word of the query as a prefix.
- **`store.mail`: email threads, emails, recipients and mailboxes**, keyed by account and Message-ID. Save a
  thread, list threads, read one, read an email by Message-ID, mark emails gone, and search subjects and bodies.
- `saveAccount` answers the store's id for the account, which `store.meetings` and `store.mail` take.
- `storedAccounts()` lists every account with the store's id; `storedAccount(key)` finds one by provider and
  external id without creating it, and fails with `not_found` when the store has none.
- A new store holds the owner's person and the bots `rule` and `agent` from the start. Tasks keep the task
  package's id, source locator, kind and group in columns; an inbox project names its account. The store refuses
  a second displayed alias for one thing and account, a second meeting summary from one source and a repeated
  meeting chat line. Purging an email takes its recipients, mailboxes and chunks with it.

### Fixed

- Under Bun a missing row read as `null` instead of `undefined`, so the store took it for a found row: linking a
  meeting to an event that does not exist succeeded. The Bun driver now answers `undefined`, as the Node one does.

### Changed — may break callers

- **A new store schema in a new file, `wirecat.db`, created by one initial migration (store version 1).** Tables
  and columns follow Rails naming (`id`, `<thing>_id`, `external_id`, `created_at`/`updated_at`); mail, documents,
  notes, memories, decisions, events, meetings, organizations, projects, tasks, proposed actions, aliases,
  taggings and topics, chunks and embeddings have tables of their own. Every table and column is in
  [`docs/storage/schema.md`](docs/storage/schema.md). The old `messages.db` is left as it is and not
  converted: messages come back with a fresh sync.
- **Knowledge, notes and tasks write the new tables.** `store.notes` splits files in a folder (`documents`,
  `ref` `document:<id>`) from written notes (`notes`, `ref` `note:<id>`); a `Note` now carries `ref`, and
  `note`, `noteTags` and `noteReferences` take a reference. Folders are `accounts` rows of provider `folder`;
  `claimFolderPath` and `pendingPath` are gone with the old migration line. `addEntity`/`entities` are
  replaced by `knowledge.addOrganization`/`organizations` and `addProject`/`projects`; `entity:` references
  resolve as not found. `store.tasks` keeps the `@wirecat/cli-tasks` `TaskStore` and adds `answer` and
  `judge`.

## 0.217.0 — 10.10.2026

### Fixed

- HTTP login recovers after a bounded throttle; embedding requests refuse redirects carrying credentials or text.
- MCP tool and chat resource permissions refresh before each invocation; tool descriptions frame returned text as untrusted data for reads and writes.
- Reply model blocks keep interpolated metadata separate from instructions.
- Model download temporary files use exclusive random names. Reserved downloaded filenames are normalized only on Windows; POSIX names remain unchanged.
- Development dependency overrides remove obsolete uuid and sprintf-js versions.

### Added

- `--agent-json` makes JSON strings and keys safe for agent consumption, while `--json` retains its raw data contract. Combine with `--jsonl` for streams.

### Changed — may break callers

- Reply JSON previews show instruction references and separate `templateValues` instead of interpolating names directly into model instructions.

- Markdown exports quote message bodies and escape untrusted structure and link labels. Transcript parsers must account for this framing.

- Consumers use `@wirecat/cli-core` 0.19.x for Windows maintenance command resolution.

- MCP contact searches query third-party registries only with explicit `registries: true`; ordinary CLI defaults remain unchanged.

## 0.216.0 — 10.10.2026

### Added

- `search messages --discover`, MCP `discover=true` and SDK `SearchQuery.discover` find partial
  lexical evidence and eligible direct replies in the local archive without model downloads.
  Strict Lucene remains the default; explicit syntax, exact and newest searches stay strict.
  Result metadata shows matched/missing terms and bounded candidate truncation; scores are not
  answer confidence. Migration 29 adds a derived reply lookup index; message data is unchanged.

### Changed — may break callers

- **The project is now licensed under Apache License 2.0.** See `LICENSE` for the terms.

## 0.215.0 — 10.10.2026

### Changed — may break callers

- **The package is now `@wirecat/cli-messaging`, and the repository is `WireCatLabs/cli-messaging`.**
  Install `@wirecat/cli-messaging` and change imports from `@leemour/cli-messaging`. It depends on
  `@wirecat/cli-tasks` 0.2.0 and `@wirecat/cli-messaging-{sqlite,onnx}` 1.0.0, and its peer is now
  `@wirecat/cli-core` >=0.18.1 <0.19.0. The code is the same as 0.214.0. `@leemour/cli-messaging` gets
  no new versions.

## 0.214.0 — 09.10.2026

### Changed — may break callers

- MCP results and write arguments make hidden Unicode controls visible, including tags, directional
  controls, C1 and byte-order marks. Subdivision flag emoji stay intact. CLI machine output preserves
  original strings. Decoded message formatting follows the same text policy, with formatting spans
  kept aligned. Update the cli-core peer dependency to 0.17.3 or later in the compatible range.

- Local voice transcription accepts complete mono or stereo Ogg Opus recordings up to 10 minutes.
  Longer recordings must be split before local transcription.
- PDF text extraction supports at most 20 pages and stops after 30 seconds. Split larger PDFs before
  extracting; failed extraction leaves existing indexed text intact.

### Security

- Attachment directory extraction and retained-file transfer refuse hidden files and folders, the
  CLI's own folders and the message store, including symlink targets. MCP extraction downloads also
  refuse these locations; choose an ordinary downloads folder instead.
- Word document extraction applies the same expanded archive limits as the other office readers
  before loading document content.


## 0.213.0 — 09.10.2026

### Changed — may break callers

- Reply rules answer whom the file's audience allows; the separate `testers` list is gone. A new file,
  or one without an audience or `reply`, answers everyone a rule matches; `replies audience --reply listed
  --allow-people` limits it to selected people, `--deny-people` / `--deny-chats` exclude some. Nothing is
  sent until `replies.send` is `allow`, and new rules start off.
- A file that still has `testers` is read as the audience that answers exactly the same people: `listed`,
  allowing the testers with no `provider` or this messenger's; when it was `listed` already, only the
  testers it also allowed. Its allowed chats are dropped, since "a tester in this chat" has no audience
  form; deny lists stay; an empty `testers` answers nobody. The next edit writes the result back, without
  `testers`.
- `replies status` no longer reports `testers`; its audience counts and warnings replace it.
  The skip reason "not a test account" is now "not on the allow list". `replyTo`, `dryRun`,
  `readReplies` and the reply editors read the messenger's provider; `dryRun` takes no `testers`.

## 0.212.0 — 09.10.2026

### Changed — may break callers

- Store version 28 drops the copies kept for older builds after the notes refactor: `annotations`,
  `knowledge_entities`, `knowledge_relations`, `knowledge_targets`, their per-account labels, and the
  `notes`-provider accounts, chats and messages. Whatever they held that the owner's tables did not is
  copied in once, as the first step of the upgrade. The copy no longer runs on every open.
- Version 28 raises the store's `min_compatible` to 28: every build before this one, tg, max and memo
  alike, refuses an upgraded store with "upgrade this tool". The rules keep that for a major version; the
  owner ruled it outside one because the store has no other users yet (2026-10-09).
- `notes.resolveNote` no longer resolves a `msg:notes/…` locator, and `notes.noteReferences` answers the
  note's `note:` reference only; version 28 points tasks that named an old locator at the note.

## 0.211.0 — 09.10.2026

### Fixed

- `search all` on a store that holds nothing yet for the account it runs as: "every account" now includes that
  account, so the server step runs and the message it saves is found. 0.210.0 still answered empty there.

## 0.210.0 — 09.10.2026

### Fixed

- `search all` searches messages the way `search messages` does, asking the messenger's server too
  (`--backend both`), so it finds every message `search messages` finds; it reports the server step as
  `server`. It used to read the local store only. MCP `search_all` does the same. `messages.searchAll` is the service.
- `search mail` with no mail imported answers an empty result with a note on stderr, as `search all` skips mail,
  instead of failing with `not_found`.
- A note found by meaning must reach the same similarity as a conversation does (cosine above 0.8 for e5-small),
  so a rare word no longer returns every embedded note in `search notes` and `search all`.

## 0.209.0 — 09.10.2026

### Added

- Tasks accept native `note:<id>` sources in the selected account, preview current note text, and retain
  their state when a note is deleted. Legacy copied file-note sources resolve through native notes;
  repeated creation reuses an existing task of the same kind, including closed tasks.
- `search all`: messenger messages, mail and notes from the local store in one query, merged best first; each
  item says its kind (`message`, `mail`, `note`) and ref. A query field one kind lacks skips that kind and
  `skipped` says why; `--only messages,mail,notes` narrows it. MCP `search_all`, described as the tool to start with.
- `search mail` (mail imported by `memo mail import`) and `search notes` (words and, with the local text model,
  meaning; `--type internal|file`, `--folder`, `--tag`, `--filter`); MCP `search_mail`, `search_notes`.
  `searchNotes` and `searchAll` are services, so memo uses the same search.
- `search messages --type text|voice|file` (MCP `type`).

### Changed — may break callers

- Every search lives under `search <resource>` (STANDARD.md, "Search hierarchy"); the old paths stop working, with
  no alias:

  | Old | New |
  |---|---|
  | `messages search` | `search messages` |
  | `messages search --source email` / `in:email` | `search mail` |
  | `conversations search` | `search conversations` |
  | `topics search <chat> <text>` | `search topics <chat> <text>` |
  | `bot messages search` | `bot search messages` |
  | MCP `messages_search`, `conversations_search`, `bot_messages_search` | `search_messages`, `search_conversations`, `bot_search_messages` |
  | MCP `topics_list` with `search` | `search_topics` |

- `search messages` never returns mail, and refuses `--source email` / `in:email` with a pointer to `search mail`.
  A saved search whose query names `in:email` is refused the same way.
- Permission keys `messages.search`, `conversations.search`, `topics.search` and `bot.messages.search` became
  `search.messages`, `search.conversations`, `search.topics`, `bot.search.messages`. A profile still naming an
  old key refuses `search` until `config migrate`, which rewrites them with their levels. `messages: deny` still
  reaches `search all`, `messages`, `mail` and `conversations`.
- A CLI mounts the new export `searchCommand(messenger)` — tg with `{ topics: true }`. `messagesCommand`,
  `conversationsCommand` and `topicsCommand` no longer carry a search leaf; `botCommand` mounts `bot search` itself.

### Fixed

- `parity.json`: tg has `messages forward --topic` (tg #387) and `attachments show --page`; MAX still plans
  `--page`.

## 0.208.0 — 09.10.2026

### Fixed

- `parity.json` lists `attachments show --page`, planned for both CLIs; without it `cli-messaging-parity` refused
  every CLI pinning 0.207.0.

## 0.207.0 — 08.10.2026

### Added

- `topics show <chat> <topic>` and MCP `topics_show`: one forum topic as `Topic` gives it, through the optional
  `ChatReading.topic`; listed only where `Messenger.topicShow` is true.
- `messages forward --topic <id>` and MCP `messages_forward` `topic`: forward into a forum topic of the `--to`
  chat, checked with `validateThread` before the write, as `send --topic` is; `threadId` in the port's `forward`
  options. Listed only where `Messenger.forwardTopic` is true.
- `attachments show --page N` (MCP `page`) renders one retained PDF page as standard image content for remote agents whose clients cannot open embedded PDF resources. Uses optional `unpdf` and `@napi-rs/canvas`; no OCR API calls or automatic indexing. Preview metadata separates the source PDF hash/size from the PNG hash/size.

## 0.206.0 — 08.10.2026

### Added

- Parity: `chats requests list|accept|decline` are in both CLIs — max ships them (max-cli #505).
- Parity: `polls voters` and `polls create --close-time` are shipped rows in tg (TG#375, TG#378).

### Fixed

- Statistics selected answerers resolve stored names, aliases and usernames within query accounts.
  Ambiguous names return scoped candidates; unknown names fail with recovery guidance instead of
  yielding a fabricated zero-answer identity. Saved report selections keep resolved IDs.

### Changed — may break callers

- Bare unknown nonnumeric answerer references are now treated as unresolved names. Use an explicit
  `person:provider/account/id` locator to select an unseen opaque ID. Response rows add `identityKnown`;
  explicitly selected IDs without stored identity observations have `status: unknown`.

## 0.205.0 — 08.10.2026

### Changed — may break callers

- `JoinRequest.requestedAt` is `string | null`: MAX lists join requests without a time (measured in max-cli,
  2026-10-08). Telegram still gives one.

### Added

- Parity: `chats requests` is planned for max — a MAX channel does approve who joins (measured in max-cli, 2026-10-08);
  the old reason "MAX groups have no join approval" held only for groups.

## 0.204.0 — 08.10.2026

### Added

- `polls create --close-time <delay>` (MCP `close_time`): the poll closes by itself `90s` or `5m` after sending,
  within the messenger's `Messenger.pollCloseSeconds`; outside it, or where it is unset, refused before
  connecting. `NewPoll.closeAfter` carries the seconds.


## 0.203.0 — 08.10.2026

### Changed — may break callers

- `chats link create` and `chats link update` (and their MCP tools) refuse `--approval` with `--max-uses`:
  Telegram dropped the use limit when a change turned approval on, without saying so (measured 2026-10-08),
  and its Bot API documents the same for a new link.

## 0.202.0 — 08.10.2026

### Added

- Store version 27: `owner_targets`. A label on a person, entity, task or notes folder belongs to no account:
  the `knowledge` calls for these targets, for notes and for relations and entities take `null` for the
  account (`KnowledgeScope`). A chat or contact target still needs its account. Labels from before are
  copied once on open.
- `folder:<id>[/<path>]` references and the `folder` knowledge target: a label on a notes folder or subfolder
  labels every note under it, at any depth, in a `tag:` search.
- `NotesStore.replaceFileTags` and `noteTags`: a note's tags say whether its file or the owner stated them; an
  import replaces only the file's, and an owner's tag survives the file dropping it.
- `knowledge.labelled` lists every labelled note and owner target, with `labels` (tag and origin) and a
  `type` filter.
- `embedNotes` and `nearestNotes` in `services`: notes embedded with the same local model, prefixes and vector
  key as conversations, and searched by meaning.
- `MessageStore.personByUid`: the person a `person:<uid>` reference names, with their identities.

### Changed — may break callers

- `knowledge.labelled` no longer narrows by account and no longer lists `knowledge_targets` rows; its items
  gain `labels`.

## 0.201.0 — 08.10.2026

### Added

- `polls voters <chat> <message> [--answer <id>] [--limit]` and MCP `polls_voters`: who voted for what in a
  poll that is not anonymous, newest first, with the total. The poll is read first; an anonymous one or an
  unknown answer is refused. Through the optional `MessagePolls.pollVoters` and the new `PollVote`; listed only
  where `Messenger.pollVoters` is true.

## 0.200.0 — 08.10.2026

### Added

- `store jobs list --state <running|done|failed|cancelled|died>` answers only the jobs in that state. `JOB_STATES`
  exported beside `JobState`. The catalogue meaning of `--state` now covers tasks and jobs. Planned for max and tg.
- `serve` fills stems still building — after a default change on a large store — a 2-second slice every
  30 seconds until they are ready (`stems.stemmed` in its summary). `stemFills` is exported for a CLI with
  its own `serve`, beside `memberFetches`.

### Changed — may break callers

- A search with stemmed words no longer fails while the stems are building, or when a newer tool chose
  stemmers this one does not know: it matches each word's own form through the word index, and
  `query.stemming` is `{ applied: false, reason: "building" | "stemmer_unknown", done, total, pending }`,
  with a note on stderr. `stats` rankings and admin statistics do the same. Stems waiting for
  `store reindex` after the owner's own choice still refuse. `QueryStemming` is now a union on `applied`.
- A default saved in the store says so (`origin: "default"`, with the defaults' version), and a later
  build with newer defaults replaces it without a reindex; an older build never rebuilds a newer default
  back. `config show` lists it as `default`. A setting saved by 0.198.0–0.199.0 has no origin and counts
  as the owner's.

## 0.199.0 — 08.10.2026

### Fixed

- A store whose stems an older tool built with its default (`latin=spanish`), with no stemmers ever chosen,
  no longer asks for `store reindex` after 0.198.0 changed the default: on open the stems start again with
  `english,spanish`, as a first build does. A small file is stemmed on the spot; a larger one a slice per
  search and in full by `store migrate`, and until then a stemmed search says how far the build is, while
  `exact:` and `--exact` keep working. A choice made with `config set searchStemmers.*` still waits for
  `store reindex`.

## 0.198.0 — 08.10.2026

### Added

- `chats link update --expire-time never` (MCP `expire_time: "never"`) takes a link's expiry away;
  `InviteLinkChange.expiresAt` may be `null`.
- Store version 25: notes are their own records (plan).
  `MessageStore.notes` holds notes folders (an id here, the path in each computer's config), file and
  internal notes with their earlier text, one `links` table for every connection by typed reference, and
  the owner's organisations and projects (`entities`). A link that names a person nobody matches yet is
  kept and resolved in the write that creates, renames or aliases that person. `parseReference`,
  `formatReference`: `msg:`, `chat:`, `contact:`, `note:`, `person:`, `entity:`, `task:`.
- On open, what a build before version 25 wrote — notes stored as `notes`-provider messages, annotations,
  relations, entities — is copied into the new tables, and again whenever an older build has written since.
  A notes folder's former path waits in `note_folders.pending_path` for `NotesStore.claimFolderPath`.
- Store version 26: notes have the indexes messages have — words (`note_words`), stems (`note_stems`) and
  chunks for vectors (`note_chunks`, sharing `chunk_vectors`). `NotesStore` gains `search` (the query
  language messages use, over `text`, `exact`, `body`, `tag`, `date`, `in`), `indexState`, `chunksToEmbed`,
  `nearest` and `renameFileNote` (a moved file keeps its id, links and tags); `searchNotesQuery` is the
  service for a notes search. `store migrate` and `store reindex` index the notes too (`notesIndexed`).
- `searchStemmers.latin` takes several stemmers joined by commas; a Latin word is indexed and searched in
  every chosen stemmer's form.

### Changed — may break callers

- `contacts notes`, `KnowledgeStore` annotations, relations and entities read and write the new tables. They
  are the owner's, not one account's: a contact's notes show in every account that sees the contact, and
  `relations` and `entities` list everything. An annotation on a `msg:notes/…` locator is refused; name the
  note `note:<id>` (`KnowledgeTarget` gains `note`).
- The default Latin stemmers are now `english,spanish` (were `spanish`). A store whose stems were built with
  the old default answers a stemmed search with "the stems were built by … latin=spanish" until
  `store reindex` (or `store migrate`) rebuilds them; `exact:` and `--exact` keep working meanwhile. The
  stem index of a text with Latin words is about twice as large. Once rebuilt, the choices are saved in
  the store, so a tg or max still on an older cli-messaging answers a stemmed search with "upgrade this
  tool" instead of rebuilding the stems back. `Stemmers.latin` is a string of one or more stemmers.

### Fixed

- `chats link update` help no longer says the group's own link cannot be changed: Telegram changes it
  (measured 2026-10-08).

## 0.197.0 — 08.10.2026

### Added

- `chats start <bot>` also takes the bot's link, one the account never opened, and reads its `?start=` when
  `--payload` is not given; through the new `BotChats.botByLink`.
- Parity: `messages press`, `chats start` and `chats app` are shipped rows in max (max-cli #490), tg planned;
  `--payload` and `--start` join the option catalogue.

## 0.196.0 — 08.10.2026

### Added

- `account list`: every profile on this computer — the current one, those in the config file and those logged in
  — with the account each is logged in as and its name from the store; `null` where unknown. Asks the messenger
  nothing. `MessageStore.accountName`; `profilesWithAccounts` moved to `cli/messenger/accounts`. Planned for max
  and tg.

### Fixed

- A CLI run with no command, or a command group with no subcommand (`tg`, `tg chats`), showed only
  `✗ (outputHelp)`: since 0.156.0's machine error contract, Commander's help was discarded and its "no command"
  code was not recognised. At a terminal it now shows that command's help on stderr (exit 2); a script or
  `--json` gets the intended `validation_error` "give a command — run `<cli> --help`".

## 0.195.0 — 08.10.2026

### Added

- `chats start <bot> [--payload]` starts a bot in a one-to-one chat, as its Start button does — guarded as a
  message under `chats.start`; `chats app <bot> [--start]` prints the address of the bot's mini app, which signs
  the owner in — guarded as a reaction under `chats.app`. Through the optional `BotChats` (`startBot`, `botApp`).
- `MessageButtons` and `BotChats` exported from `@leemour/cli-messaging/cli`.

### Changed — may break callers

- `messages press`, `chats start` and `chats app` exist only where `Messenger.personalBots` is true.

## 0.194.0 — 08.10.2026

### Added

- `messages press <chat> <message> <button>` presses a bot's callback button, by its number or its exact text;
  `messages list|show` print a keyboard under its message, numbered. Buttons that hand over the phone or the
  location, open a link or an app, send text or copy are refused with what to do instead. Through the optional
  `MessageButtons` (`buttons`, `pressButton`) and the new `Attachment.buttons` / `Button`; guarded as a
  reaction under the permission key `messages.press`.

## 0.193.0 — 08.10.2026

### Added

- Parity: `chats link update`, `chats link list` and `chats link revoke` are shipped rows in tg (TG#364, TG#344);
  max still plans list and revoke.
- Parity: max's chat folder order, group photo, privacy, mute, media, calls, stickers and chat delete/clear
  are shipped rows now (max only, tg planned), with their options in the catalogue.
- `skipFlagFor` from `@leemour/cli-messaging/sends`: the flag that skips a permission's question,
  `--allow-dangerous` for a deletion nobody gets back and `--yes` for the rest, so a CLI keeps no copy of the list.

## 0.192.0 — 08.10.2026

### Added

- `chats link update <chat> <link> [--approval | --no-approval] [--expire-time] [--max-uses]` and MCP
  `chats_link_update` change one extra invite link; only the fields given change. Through the optional
  `InviteLinks.updateInviteLink` and the new `InviteLinkChange`; listed only where `Messenger.inviteLinkUpdate` is true. Guard action
  `link.update`, permission key `chats.link.update`.

## 0.191.0 — 08.10.2026

### Added

- MCP `chats_folders_show { folder }`: one folder with its chats, pinned and excluded chats by name, as
  `chats folders show` answers it. Read-only, offered wherever `chats_folders_list` is.

## 0.190.0 — 08.10.2026

### Added

- Retained attachment byte transfer: `attachments show` returns bounded base64 chunks with whole-file SHA-256,
  account/message binding and cancellation. MCP embeds complete images or binary resources, with a JSON
  fallback for hosts without resource support. No automatic download, OCR, index write or model call.

## 0.189.0 — 08.10.2026

### Fixed

- Command discovery marks counter refresh as a local write, matching its guarded local observation updates.
  Ranking help explains observed counter freshness and accepts retention cohort evidence references.

## 0.188.0 — 08.10.2026

### Added

- `stats chats retention <chat>` reports known joining cohorts with observed checkpoint membership,
  unknown/pending denominators, interval departures and archive-qualified message activity. Migration 24
  stores explicit remote roster batches and member/stay references; historical stays gain no invented snapshots.
- `stats messages counters show|refresh` exposes independent value/time/source observations for views,
  reactions and comments. Refresh requires one explicit chat or pinned exact targets, defaults to 20 messages
  and 30 seconds, and previews targets/capabilities with `--dry-run`. Unsupported/missing counters remain explicit.
- Rankings and evidence disclose per-field freshness; observation changes invalidate evidence cursors.
  Legacy counter writes remain compatible and lose freshness when their value differs from its observation.

## 0.187.0 — 08.10.2026

### Added

- `chats folders show <folder>`: one folder, by id or exact title, with its chats, pinned and excluded chats by
  name — `{ id, title, kind }`, names from the store first, the messenger asked only for the rest; a chat it cannot
  find keeps its id with `title` and `kind` null. `FoldersService.show`. Planned for max and tg.
- Parity: `session start --sms` planned for tg.
- `metadata refresh --only-missing` refreshes only chats with no stored metadata yet: the `--chat`s named, or,
  without `--chat`, every stored group and channel, up to `--limit`. `--chat` is no longer required with it.
  `metadata.missing()` on the services. Planned for max and tg.
- `store jobs retry <job>` starts a failed or died background fetch again as a new job, with the same command;
  `--failed` retries every chat whose newest job failed or died, each once, and answers one item per chat.
  `store jobs clear` forgets finished jobs and removes their logs; a running job is kept. A job now records its
  `argv`; one recorded before is rebuilt from its chat, `limit`, `pageSize` and `last`, with the default pause
  and no time window. `removeJob`. Planned for max and tg.

## 0.186.0 — 08.10.2026

### Added

- `chats delete <chat>` and `chats clear <chat>` remove a chat or every message in it for this account only, behind
  `chatDeletion`. Adapters implement `ChatDeletion`; journal actions `delete` and `clear` (`chats.delete`,
  `chats.clear`) ask first by default, `--allow-dangerous` skips the question, and both sit under the old `delete`
  word. `skipFlagFor` moved to `sends/permissions` (still exported from the CLI helpers). Planned for max and tg.

## 0.185.0 — 08.10.2026

### Added

- `polls create --quiz --correct <n> [--solution <text>]` sends a quiz — one right answer, by its position from 1,
  and a vote that is final — where the messenger sets the new `Messenger.pollQuiz`; MCP `polls_create` takes
  `quiz`, `correct` and `solution`. `--multiple` and `--revote` are refused with `--quiz`. `NewPoll` gains optional
  `quiz: { correct, solution? }`, `correct` counted from 0.

## 0.184.0 — 08.10.2026

### Added

- Stickers: `stickers list [--set <id>]` (a group a CLI adds itself) and `messages send --sticker <id>`, sent alone,
  behind `stickers`. Adapters implement `stickerSets` and `stickers` (`AccountRecords`) and take
  `SendOptions.sticker`; domain types `StickerSet`, `Sticker`. Planned for max and tg.

## 0.183.0 — 08.10.2026

### Added

- The owner's own settings, guarded and journaled as account changes: `chats mute <chat> [--until <time>]` and
  `chats unmute` (`chatMute`), `account privacy set` (with `privacy`). Adapters implement `AccountSettings`
  (`mute`, `updatePrivacy`); journal actions `chat-mute` (`chats.mute`) and `privacy` (`account.privacy.set`),
  both under the old `profile` word. Planned for tg.

## 0.182.0 — 08.10.2026

### Added

- `MessageStore.knowledge` provides account-scoped source annotations, explicit person/task/entity labels,
  manual and weak proposed relationships, and durable local reminder leases/receipts.
  Annotations retain owner-authored text when their source disappears, expose source availability, and reject stale edits.
  Migration 23 is additive and remains compatible with store version 6 writers.
- The `./documents` export reuses shared document extraction for ingestion; CSV row/column ranges and PDF page
  spans retain source provenance. Existing built-in office readers remain available through this export.

## 0.181.0 — 08.10.2026

### Added

- `topics delete <chat> <topic>` deletes a forum topic and every message in it, for everyone; MCP
  `topics_delete`. It asks first by default (`topics.delete` is `ask`), and `--allow-dangerous` is the word that
  skips the question, as for `messages delete`. The General topic is refused. Adapters add the optional
  `TopicEditing.deleteTopic`.

## 0.180.0 — 08.10.2026

### Added

- Reads only a messenger's server answers, each behind its own switch so a messenger shows only what it has:
  `chats media <chat> [--type photo,video,file,audio,link] [--before-id]` (`chatMedia`), `account privacy show`
  (`privacy`), and a `calls list` group a CLI adds itself. Adapters implement `AccountRecords` (`media`,
  `privacy`, `calls`); domain types `CallRecord`, `PrivacySettings`, `Audience`, `MediaKind`. Planned for tg.

## 0.179.0 — 08.10.2026

### Added

- Local attachment readers for ODT, ODS, XLSX, PPTX and EPUB. Preserve sheet/slide/chapter order
  and saved cell values, without calling a model or adding an office application. Structured
  inputs are bounded and incomplete results are never stored as complete text.
- BOM-marked UTF-16 and high-confidence legacy text decoding, with portable Node/Bun support.
  Ambiguous encodings remain unreadable for an agent to inspect or convert.

### Fixed

- Failed same-hash local extractions can retry, reader identities invalidate obsolete caches,
  and failed writes preserve previously good indexed text atomically. Agent text stays protected.

### Changed — may break callers

- Local extraction can now succeed for previously unsupported formats and encodings.
  Non-UTF8 provenance uses `plain:v2:<encoding>`; uncertain or malformed encoding reasons
  are `encoding_ambiguous`, `invalid_encoding` or `unsupported_encoding` instead of `not_utf8`.

## 0.178.0 — 08.10.2026

## 0.177.0 — 08.10.2026

### Added

- `Poll` gains optional `quiz`, `revote` and `creator`, so `polls show` can say a poll has one correct answer,
  whether a vote may change, and whether this account may close it; an adapter that does not set them is
  unchanged.
- The send journal keeps the `key` a write names — `polls.create`, `polls.vote`, `polls.close` and the others —
  so a poll is told from a message in `sends list` and in a report. An additive field; older lines read as before.
- `chats folders create|update` take a folder's rules where `Messenger.folderRules` is set: `--include` kinds of
  chat (contacts, non-contacts, groups, channels, bots), `--skip` muted, read or archived chats, `--exclude-chat`,
  `--pin` and `--emoji`; on `update`, `--include` and `--skip` replace the set and `none` clears it, and `--remove`
  also takes a chat off the excluded and pinned lists. MCP `chats_folders_create|update` take the same.
  `ChatFolders.createFolder` takes optional `rules`, `FolderChange` the same fields, and `Folder` reports them.
- `chats requests list --search <text>` or `--link <link>` narrows join requests by name or by the invite link
  used, not both; MCP `chats_requests_list` takes `search` and `link`, and `JoinRequests.joinRequests` its window.

### Changed — may break callers

- `chats folders order` answers each folder's `id` and `title` only, not its chats.

## 0.176.0 — 08.10.2026

### Added

- `chats update --photo <file>` sets a group's photo where the messenger declares `groupPhoto: true`; the
  adapter receives it as `GroupChange.photo`. The parity manifest plans it for max and tg.
- The parity manifest lists `chats folders order` in tg, and planned for max (max-cli `feat/client-gaps-a`).

- Add stored reports for unanswered questions, selected responders, known-join newcomer help and viewed posts with little discussion, shared by CLI and MCP with bounded evidence and repeatable saved runs.

### Fixed

- An empty `messages search` that asked the messenger's server says «nothing found in the local store or on the
  messenger's server», not that only the local store was searched. The search docs and the MCP description say
  the server is asked by default where it can search.


## 0.175.0 — 08.10.2026

### Added

- `chats requests accept|decline <chat> --all [--link <link>]` answers every pending request, or those by one
  link. The requests are counted first; an accept is weighed by that count against the hourly limit, so one the
  limit cannot take is refused before anyone is answered. Adapters add `JoinRequests.answerAllJoinRequests`, and
  `joinRequests` may report `total` and take `link`.
- `chats link list <chat> [--revoked] [--limit]` and `chats link revoke <chat> <link>`, MCP `chats_link_list` and
  `chats_link_revoke`; `InviteLink` gains optional `primary`, `revoked`, `pending` and `joined`. Revoking the
  group's own link answers with the new one. Through `InviteLinks.inviteLinks` and `revokeInviteLink`.
- Settings adapters can resolve extra fields from all personal/bot layers, retain detailed source paths, and supply a compatibility schema and duration parser. Existing consumers keep their resolver behavior; MAX can adopt the common resolver without changing its settings contract.
### Fixed

- Wording parity skips absent planned commands while continuing to report missing required
  commands and differences between available shared options.

## 0.174.0 — 07.10.2026

### Fixed

- Local contact aliases cannot silently override a different chat that the messenger resolves under the same name. Ambiguous references require an explicit chat id.

## 0.173.0 — 07.10.2026

### Fixed

- Saved ranking selections and search ASTs retain nested false values, including exclusive
  date boundaries, instead of failing validation when replayed.
- `Messenger.folderOrder` / `folderJoin` can disable unavailable operations consistently in
  CLI and MCP discovery. Ranking guide examples use the supported `--json` flag.

## 0.172.0 — 07.10.2026

### Added

- Account-scoped private contact aliases and notes with offline CLI/MCP authoring, safe text input, revision-checked edits and explicit notes search. Contact refresh and identity linking preserve local metadata.
- Cached group/channel metadata and bounded deterministic automatic tags. Generated claims preserve manual labels and expose provenance; dry-run is local, and messenger refresh is explicit.
- `Messenger.serverSearch` may be `"chat"`: the messenger's server searches one chat at a time, so only a query
  that names one chat (`chat:` or `--chat`) asks it; others answer from the archive, or report
  `server.skipped: "needs_chat"` when `--backend` was typed. For MAX's opcode 73.

### Changed — may break callers

- `chats join` (MCP `chats_join`) answers `{ operationId, requested: true }` where the group's admins approve
  who joins, instead of the adapter's error. `GroupAdmin.join` may return `{ requested: true }`; an adapter that
  only returns a group still compiles. A caller reading `chat` must check `requested` first; tg-cli and max-cli
  only implement `join`, so neither needs a change.

## 0.171.0 — 07.10.2026

### Added

- **One request pace per profile, shared by every process that uses it.** Two commands at once, background
  `store fetch` jobs, `mcp` and `serve` now draw on one allowance: a burst goes at once, then one call per
  interval. Defaults to 60 a minute after a burst of 20 unless the messenger sets its own (`Messenger.pace`);
  `requestsPerMinute` in the config or `<APP>_REQUESTS_PER_MINUTE` changes it, 0 turns it off. `flood clear`
  also resets it.
- `stats messages top` and `stats contacts top` rank held messages and their human authors by
  metrics or weighted scores, with full-population normalization, explicit data quality and
  structured drilldowns. Their `evidence` views page through contributing messages and answer
  pairs with bounded output and change-detecting cursors. CLI and MCP use the same services.
- `searches create --selection` saves a resolved ranking drilldown for repeatable
  `stats messages top --saved` / `stats contacts top --saved` queries.
- `chats folders order <folder...>` puts folders in that order, the ones not named after them in their old order;
  `chats folders join <link>` adds a folder someone shared by a `t.me/addlist/` link, which joins every chat in it.
  MCP `chats_folders_order` and `chats_folders_join` do the same. Both go through the guard as account actions
  `folder-order` / `folder-join` (keys `chats.folders.order` / `chats.folders.join`). Adapters implement the new
  `ChatFolders.orderFolders` and `ChatFolders.joinFolder`.
- `messages send --html` and `messages edit --html` read the text as HTML (`<b>`, `<i>`, `<u>`, `<s>`, `<a href>`,
  `<code>`, `<pre>`, `<blockquote>`), not together with `--md`; MCP `messages_send` and `messages_edit` take `html`.
  Offered where `Messenger.html` is set; the adapter implements the new optional `HtmlFormatting.formatHtml`.
- `messages send --filename <name>` gives the `--file` the name others see, instead of its name on disk; MCP
  `messages_send` takes `filename`. Offered where `Messenger.mediaOptions` lists the new `fileName`.
- `messages list --topic <id>` reads one forum topic, back from its newest message or `--before-id`; MCP
  `messages_list` takes `topic`. Online it uses the new optional `TopicHistory.topicHistory`; `--offline` and a
  store-mode messenger filter the store by the message's topic, and `Store.messages` takes `threadId`. The General
  topic (`1`) is refused: its messages carry no topic id. Not with `--after-*`, `--before-time` or `--mark-read`.

### Changed — may break callers

- `messages search` asks the messenger's server too by default (`--backend both`, MCP `backend`), where the
  messenger offers server search: Telegram today. Hits the archive did not hold are saved and appear, each with
  `source`, and the answer gains `server`. `--backend archive` (MCP `backend: "archive"`) keeps the old answer.
  Unasked, a search the server cannot take — offline, MAX, no permission, no words — is the archive's, with no
  `server` block.
- **A wait the messenger asks for now holds the whole profile**, not only that call in that chat: every
  process's next call waits past it, and one that would wait more than 5 minutes is refused at once with
  `rate_limited` and nothing sent. Bulk work that ran unpaced in parallel now takes longer. Tests that build
  their own environment and make more than 20 calls set `<APP>_REQUESTS_PER_MINUTE=0`.

### Fixed

- `chats update --join-approval` no longer says it works in a public group only: Telegram turns it on in a
  private supergroup too (measured).

## 0.170.0 — 07.10.2026

Released early: tg-cli join requests and join approval are merged here and wait for this release to land

### Added

- `chats link create <chat> [--approval] [--expire-time <time>] [--max-uses <n>]` makes an additional invite
  link — one that needs an admin's approval, stops working at a time, or takes at most n people; MCP
  `chats_link_create`. Through the guard as `chats.link.create`; nobody is told, so it is not counted toward the
  hourly limit. Adapters implement the new optional `InviteLinks` group.
- `chats update --join-approval on|off` where the messenger lists `joinApproval` in `groupSettings`: people ask
  to join and an admin lets them in. `GroupSettings.joinApproval` is optional, so adapters that do not set it
  compile unchanged.
- `chats requests list <chat>` shows who asked to join a group or channel that needs an admin's approval, newest
  first, and `chats requests accept|decline <chat> <person>` answers one; MCP `chats_requests_list`,
  `chats_requests_accept` and `chats_requests_decline` do the same. Answers go through the guard as
  `chats.requests.accept` / `chats.requests.decline`; the recipient list checks the group only, and an accepted
  request counts toward the hourly limit like an added member. Adapters implement the new optional
  `JoinRequests` group; one without it refuses.

### Fixed

- `messages search --backend` tops up the word and stem indexes before the server step, as the archive search
  does, so `both` no longer fails with `index_not_ready` where `archive` would answer. An explicit
  `--backend server` on a profile whose `messages.server-search` is `ask` is refused instead of going ahead over
  MCP: the server search needs `allow`, like `--sync-first`.

## 0.169.0 — 07.10.2026

### Added

- `messages search --backend archive|server|both` and `--server-time` (MCP `backend`, `server_time`), offered
  where the messenger sets `serverSearch` and its adapter has the new optional `MessageSearch.searchMessages`.
  The server's hits are saved and re-checked by the same strict query; each hit gets `source` and the answer a
  `server` block. Default `archive`, unchanged. Permission key `messages.server-search`; `stats` stays local.

## 0.168.0 — 07.10.2026

Released early: MAX and Telegram attachment OCR adoption cannot compile against the published SDK: ModelImage and explicit bulk OCR are missing

## 0.167.0 — 07.10.2026

### Changed — may break callers

- A send, forward or poll with no `--send-as` (`send_as`) to a chat whose saved sender is not the account is
  refused before sending, naming the `--send-as` that posts as the owner and the one that posts as the saved
  sender. Adapters tell it through the new optional `SenderIdentities.savedSender`; one without it is unchanged.

### Added

- The store's optional `rankQuery` aggregates message/author metrics and full-population scores
  in a read snapshot, with bounded text/graph calculations and explicit missing-data exclusions.
  `rankingOptions` validates metrics/presets/weights; versioned linkage distinguishes discussion
  copies, replies and unknown old rows. Public CLI/MCP ranking views remain planned until wired.

- `contacts profile` answers `aliases`: the earlier names and usernames the store saw a person with, oldest
  first — `{ name?, username?, link?, firstSeenAt, lastSeenAt, source }`. `profile`: the store now writes a
  revision whenever a saved message or contacts sync brings a new name or username, not only on member-list
  reads; `messages`: names on their stored messages that no revision holds, approximate. Telegram usernames get
  their `t.me` link. Kept per identity, so two people who once shared a name stay apart. No store migration.
- Explicit bulk attachment OCR through `attachments extract --ocr`, with bounded
  `--concurrency`, `models.ocr` and the standard model credentials/gateway. Images
  and scanned PDF pages enter the existing content index; ordinary extraction
  never calls a model. Agents remain the default readers through their own vision
  tools and `attachments text set`.
- Optional scanned-PDF rendering through `unpdf` and `@napi-rs/canvas`, bounded
  by page count, pixels/bytes and output length. Completed OCR is cached by file
  hash and pipeline/model identity; agent text and existing good text survive
  failed or incomplete provider responses. Needs-agent results expose localPath.

- `messages comments <channel> <post>` and the read-only MCP tool `messages_comments` read the comments under a
  channel post, a page at a time, with where they live (`discussion: { chatId, messageId }`).
  `messages send --comment-to <post>` (tool `comment_to`) comments: the service finds the post's discussion and
  sends a reply there, so the guard, the recipient list and the journal see the discussion group. Through the
  optional adapter group `ChannelComments`; a post that takes no comments is `not_found`.

- A compiled Lucene selection seam for bounded SQL analytics, using the same matcher as search
  inside one synchronous read snapshot. Exact populations stay in SQL; detector and attachment
  key budgets fail closed. The planned ranking commands are not exposed yet.

### Fixed

- Attachment extraction honors denied message-read permissions before reading
  files or calling a model. A bulk OCR pipeline stops further API calls after a
  provider rate limit and returns sanitized per-file errors without retrying.

## 0.166.0 — 07.10.2026

Released early: MAX and Telegram search catch-up in 0.162.0 through 0.165.0 can bypass readonly graph-link permissions; consumers need the corrected guard

### Fixed

- Local post-fetch and gap-repair search preparation honors the existing `conversations.links`
  permission for graph builds. Read-only or denied links refuse before fetching or queueing a job,
  including MCP repair requests; explicit preparation opt-out still permits authorized history reads.

## 0.165.0 — 07.10.2026

Released early: max-cli cannot adopt stemmed search: its parity check fails on --spoiler and --caption-above, which MAX refuses

### Fixed

- `messages send` offers `--spoiler` and `--caption-above` only where the messenger lists them, as 0.163.0
  said; it showed them everywhere and refused them on use, so max-cli's parity check failed on adopting it.

## 0.164.0 — 07.10.2026

Released early: max-cli and tg-cli need first-run configuration files for the approved setup documentation

## 0.163.0 — 07.10.2026

Released early: tg-cli and max-cli adopt stemmed search today, at the owner's request

### Added

- First-run settings resolution creates a starter `config.json` with common defaults. Existing files
  are preserved, concurrent runs publish complete files, and flags/environment values are never saved.
  Successful-run recording remains opt-in.


- `topics edit <chat> <topic> [--title <t>] [--closed on|off] [--pinned on|off] [--hidden on|off]` and the MCP
  tool `topics_edit` rename, close, reopen, pin or unpin a forum topic, or hide its General topic;
  `topics order <chat> <topic...>` and `topics_order` put the pinned topics in order, pinning nothing. Through the
  optional adapter group `TopicEditing`; journaled as `topic-edit`, `-close`, `-reopen`, `-pin`, `-unpin`,
  `-hide`, `-unhide` or `-order` with the topic id, under the permission key `topics.edit`.

- `chats send-as <chat>` and the read-only MCP tool `chats_send_as` list the identities the account may post
  as in a chat, through the optional adapter group `SenderIdentities`. `messages send`, `messages forward` and
  `polls create` take `--send-as <id>` (their tools `send_as`), with or without attachments; an id not in the
  chat's list and a messenger without the capability are refused. The journal records `sendAs`, and a retry
  under the same send id with another identity is refused.

- `messages send --spoiler` and `--caption-above` (send tool `spoiler`, `caption_above`) for a photo, video or
  file, where the messenger lists them in the new `Messenger.mediaOptions`; elsewhere they are refused before
  connecting.
- Strict search finds other forms of a word: `квартира` finds `квартиру`, `canción` finds `canciones`, by
  Snowball 3.1.1 stems chosen by script (store-wide `searchStemmers`). Exact forms come first. `exact:word`,
  `exact:"…"`, `--exact` on `messages search`, `stats messages show` and `searches create`, and `exact: true`
  on MCP `messages_search` and `messages_stats` keep today's exact matching. Answers carry `stemsReady`,
  `query.stemming` (the analyzer and each word's stem) and `exact` per hit; the CLI notes the forms in
  stderr. Through the store at 1M, a stemmed search costs about what an exact one does (`bench/stemming`).

### Changed — may break callers

- Strict `text` search stems (fields version 2). Bare words **and quoted phrases** now match other forms,
  so result sets and `stats messages show` counts grow and the order changes (exact forms first): `"квартира"`
  finds `квартиру`. For the old sets use `exact:` or `--exact`; an MCP AST with `field: "text"` now stems,
  send `field: "exact"` for exact matching. `-word` excludes every form; `-exact:word` only the exact one.
  Saved searches run with the new meaning. A stemmed search answers `index_not_ready` (`index:
  "message_stems"`, `cause`) until `store migrate` has built the stems, and again after the stemmer
  setting changes, until `store reindex`; exact searches keep working. Known false merges: `часть`/`часто`,
  `потому`/`потом`, `caso`/`casa`, `partido`/`parte`, `plazo`/`plaza`; English through the Spanish stemmer
  (`car`/`care`) unless `searchStemmers.latin` is `english`.

## 0.162.0 — 07.10.2026

### Added

- `store gaps plan` and MCP `store_gaps_plan` inspect interior gaps in recorded coverage locally.
  Explicit bounded repair rechecks coverage, preserves unknown edges and uncertain timestamp pages,
  and supports fingerprinted background jobs through CLI and MCP. Job metadata is available over MCP.

- `searchCatchUp` and `store fetch --catch-up` prepare the fetched chat's graph and installed local
  vectors within explicit message/chunk/time bounds, off by default. Background jobs keep the same
  choice. Fetch results distinguish persisted history from incomplete preparation; models are never
  downloaded and configured remote providers are not activated.

- Attachment extraction is available over MCP, from an explicitly scoped nonrecursive directory,
  and directly after `messages download --extract`. Bounded MCP scans return a continuation cursor;
  output reports metadata without file text, and extraction preserves agent-written text.
- `stats chats official <chat>`: what the messenger itself computed for a group or channel it shows its admins —
  its own period, totals against the previous period, top posters, admins and inviters (groups), recent posts and
  notification share (channels), and every graph as JSON series. One object with `kind` `group` or `channel`;
  `--jsonl` is refused; a graph the messenger could not give is `{ error }` and the rest still answer. A messenger
  offers it with the optional `OfficialStats` adapter group and `Messenger.officialStats: true`; without the flag the
  command is not mounted, so MAX does not show it.

### Fixed

- Edits purge vectors of obsolete text while preserving genuinely shared current text hashes.
  Successful rebuilds also clean affected abandoned hashes; bounded shared-use checks retain an
  inconclusive hash rather than delete another account's valid cache.

- File extraction compares content hashes so same-size file replacements refresh content search.
- `chats members fetch` and `chats members audit` take the group's member count from the member list when
  the messenger gives it there. A group whose count the chat list did not carry answered `participants: null`,
  so nobody was ever recorded as gone and the tracked daily counts had no total. A messenger adds
  `participantsCount` to its `members()` page.

### Changed — may break callers

- `watch`, `bot watch`, `serve` and `mcp` end with exit 0 on SIGTERM (`kill`, `server stop`), as on Ctrl-C:
  being stopped is how they end. Other commands keep 143.

## 0.161.0 — 07.10.2026

Released early: MAX cannot adopt 0.160.0 — a timed-out Bot API write still reads as safe to repeat

### Fixed

- The unknown outcome of a write stopped by `--timeout` now reaches the output. 0.160.0 kept it inside
  the runner but still printed `timeout`, so the fix it announced did not show.

## 0.160.0 — 07.10.2026

Released early: MAX and Telegram cannot adopt 0.159.0 — a timed-out Bot API write reads as safe to repeat, and tg session start --qr-file is refused

### Fixed

- `session start qr` and `sms` run again without a terminal: 0.157.0 refused them first, which broke
  `tg session start --qr-file` (a PNG an agent passes on) and answered before a CLI's own checks.
  Each CLI's login already refuses what needs a terminal, with its own message.

- A command stopped by `--timeout` or Ctrl-C while its own write was unanswered reports
  `outcome_unknown` again, as it says itself, instead of `timeout`. 0.157.0 replaced it with
  `timeout`, which reads as safe to repeat — a repeat could send twice.

- `chats members audit --deep` and MCP `chats_members_audit` say the ids go to the public ban lists only on
  Telegram; on another messenger the help says nothing is sent.

## 0.159.0 — 07.10.2026

Released early: MAX and Telegram agent CLI adoption requires headless setup reuse from the latest shared source

### Fixed

- `setup` runs again without a terminal, in CI or with `--json`: 0.157.0 refused it outright, which
  also stopped an agent installing the skill (`setup --agent codex`) and a token piped on stdin. Setup
  refuses on its own the steps that need a terminal; a QR or SMS `session start` is still refused
  without one, before it starts.

- Ctrl-C ends `watch`, `bot watch`, `serve` and `mcp` normally again, exit 0: 0.157.0 cancelled them
  with 130 like any other command, though stopping on Ctrl-C is how they end. Other commands still
  exit 130 on Ctrl-C; SIGTERM still ends every command with 143.

## 0.158.0 — 07.10.2026

Released early: MAX native server daily member fetching needs the public scheduler export

- Export the daily member-fetch scheduler for MAX native server integration. Long rounds no longer overlap, and shutdown waits for the running round.

### Fixed

- Searches report imported mail coverage once, with `memo mail import --since <date>` as the next
  step, rather than counting every mail thread as an incomplete messenger chat and suggesting
  `store fetch`. JSON completeness still reports missing or unknown history.

## 0.157.0 — 07.10.2026

Released early: MAX and Telegram CLI audit adoption needs the published execution, schema, skill-validation and MCP host APIs

### Fixed

- Person context includes private dialogs named by the person's id when no members are recorded,
  restoring direct messages and the last message each way in existing Telegram stores. Recorded
  membership remains authoritative; groups, left chats and other accounts are not inferred.

### Added

- `skill-validation` checks portable YAML frontmatter, local references, emitted version and
  literal command paths against consumer discovery. `evaluateAgent` provides an isolated
  synthetic task harness reporting correctness, call counts and output bytes without persisting
  message bodies. Its deterministic baseline covers six agent tasks and rejects unknown-write replay.

- `commands schema <path...>` publishes versioned JSON Schema 2020-12 descriptions of argv,
  result coverage, effects, permissions and retry guidance. MCP tools advertise open object
  result schemas with structured content and bounded serialized responses.
- Agent execution flags: `--no-input`, `--max-input-bytes`, `--max-output-bytes`, `--fields`
  and a general `--dry-run` preview before preparation or action. Specialized previews retain
  their existing behavior. Previews exclude payload content and leave remote targets unresolved.

### Changed — may break callers

- **The personal MCP server lists three tools instead of one per command**: `<cli>_tools_search`
  finds a command by words and gives its arguments; `<cli>_read` runs a command that only reads and
  `<cli>_write` one that changes something, as `{ command: "messages list", arguments: { … } }`. A
  command takes the same arguments and answers the same result as its old tool, and runs the same
  checks. The old tool names (`tg_messages_list`, `max_chats_mark_read`, …) and `<cli>_status` (now the
  command `status`) are gone, and so are allow-rules that name them. Prompts and server instructions
  name the new flow. The tool list is under 5 KB, the same on both protocol versions, with or without
  forms. The bot servers do the same: `<cli>_bot_tools_search`, `<cli>_bot_read`, `<cli>_bot_write`,
  with commands named without `bot` (`messages send`) and `status` as a command.
- **MCP writes show no form**, on the personal and bot servers, over stdio and HTTP: the profile's
  permissions decide alone, and a level of `ask` goes ahead over MCP. With the built-in defaults this
  includes deleting the owner's own messages. Moderation still leaves the actions a group's rules put
  at `ask`. `--confirm-send`, `--allow-dangerous` and `--http-confirmation` on `mcp` and `bot mcp`
  decide nothing and warn, so an existing setup still starts; `mcp config` no longer writes them.
  `personalMcpConfirmer`, `httpConfirmationOf`, `httpServerOptions` and `OVER_HTTP` are no longer
  exported.

- One-shot commands default to a 30-second deadline; explicit `--timeout` overrides it. Persistent
  watch/serve/MCP and interactive login have their own lifecycles. Buffered input defaults to
  16 MiB, secret input to 64 KiB, and machine output to 4 MiB. Exceeding output limits fails visibly;
  JSONL errors identify already-emitted rows. `--max-output-bytes 0` disables the output cap.
- JSON/JSONL and nonterminal execution cannot prompt or launch interactive login. Explicit piped
  input remains available. SIGINT exits 130, SIGTERM 143, and a closed output pipe ends quietly.
  Errors expose conservative retry guidance; interrupted writes retain unknown-outcome correlation.
  Timed-out work cannot reserve another write after its scope has ended.

## 0.156.0 — 06.10.2026

Released early: MAX and Telegram reply-model adoption cannot build without the new published replyRenderer API

### Added

- Reply templates use Liquid variables, filters and optional `ai` blocks with literal fallbacks.
  Only blocks can call a model; incoming message data is never a template variable. Render/file access
  and output bounds, separate profile/endpoint consent and chat opt-outs guard calls. `replies consents
  show|grant|revoke|deny|allow` controls consent; `replies test --ai` opts into model calls while ordinary
  previews show instructions/fallback without calls. Old placeholders and may-reword files keep their
  original literal fallback behavior with warnings. Pause, rule, audience and consent changes during
  model calls prevent stale replies from being sent.

- **MCP prompt `open-tasks`** (`chat` optional): a digest of what waits on the owner. The agent refreshes the
  tasks with `review` `new`, lists the open ones, sums them up per chat, oldest first, and closes one only after
  the owner approves. It sends nothing.

### Changed — may break callers

- Statistics reports now use `stats messages show`, `stats chats show` and `stats tasks show`;
  the former resource-local `stats` leaves are removed without aliases. MCP names move with them.
  `stats charts` remains available. Report shapes and saved searches retain their semantics.
  Statistics check both their canonical permission and access to underlying data. Old statistics
  permission keys require `config migrate`; conflicting old/new levels are refused before writing.

- Invalid command paths, options, missing values and invalid choices now return exit 2 with a
  `validation_error`, instead of Commander's exit 1 and prose. JSON and JSONL failures remain one
  JSON object on stderr even when a terminal is attached. Help and version requests still succeed
  with text on stdout. Callers can branch on the error code instead of parsing terminal output.
  Consumer preparation now runs only after parser validation and never for help/version requests.
- If a consumer failure handler cannot finish, the original error includes `settlementFailed: true`
  instead of an additional text diagnostic, so the machine error stream remains parseable.

### Fixed

- Text generation requests are aborted on CLI timeout and serve shutdown, so a completed timeout
  does not leave HTTP work holding the process open. AI reply previews respect message-read denial.

### Security

- Custom endpoints whose host is literally openai or anthropic no longer inherit public provider
  credentials. Their key names are endpoint:openai and endpoint:anthropic; save a separate key for
  these hosts with models text key set. Ordinary custom host/port names stay as before.

## 0.155.0 — 06.10.2026

Released early: tg-cli and max-cli browser sends are blocked by unsupported server elicitation; explicit startup permission overrides are needed now

### Added

- `mcp --http --http-confirmation permissions` follows the effective profile levels, so clients
  without elicitation can execute tools at level `allow`. Mandatory server forms remain the HTTP
  default; `ask` still requires a form, and `--yes`/`--allow-dangerous` cannot bypass it over HTTP.
  `mcp --permission key=level` overrides permissions for this process only; repeat it for more keys.
  Overrides reach tool discovery and execution, and are preserved by `mcp config|setup|doctor`.

## 0.154.0 — 06.10.2026

Released early: max-cli needs PNG chart files and MCP image output for the owner-requested immediate adoption

### Added

- `./models` exports one model gateway for purpose-specific prompts and untrusted data, with
  OpenAI-compatible and Anthropic adapters. Adapter options are checked before requests; missing
  configuration or consent makes no call. `models.<purpose>.provider|model|baseUrl` settings fall back
  to `models.default`, can be edited with dotted config keys, and report field sources in `config show`.
  Existing analysis settings and per-chat consents keep working; conversation analysis uses the gateway.

- `stats charts --output activity.png` exports a dark PNG beside SVG, using a separate lazy
  encoder and a bundled font for Cyrillic labels. The stored-only MCP `stats_charts` accepts
  `format: "png"` to return image content with the same chart JSON; omitted format stays JSON.
  PNG files are private and never replace existing files, and MCP writes no files or opens a connection.

- `replies add|edit|on|off` edit the profile's rules without opening a connection: new rules write
  every default and stay off; enabling a rule that replies requires a nonempty template. `replies audience`
  shows or edits the profile's allow and deny lists. Invalid edits leave the existing file untouched;
  testers, rule order and reply history are preserved. Lists replace the whole list; an empty value clears it.

### Fixed

- `contacts context --chat` calls a chat named by the person's own id their dialog when the store has no
  such chat yet, instead of `unknown` (Telegram gives a one-to-one chat the person's id).
- `contacts check` and MCP `contacts_check` say the person's id goes to the public ban lists only on Telegram;
  on another messenger the help says the lists cover Telegram only and nothing is sent.

## 0.153.0 — 06.10.2026

Released early: cli-memo: the owner asked to release now, so long notes and mail are embedded whole (store version 21)

### Added

- **A long message is embedded whole.** A message longer than a chunk (1200 characters) is split into
  overlapping pieces, cut at a paragraph, line, sentence or word, a chunk each — before, the model read only its
  beginning. Store version 21 adds `conversation_chunks.text_start` / `text_end` (nullable; `minCompatible`
  stays 6, so older builds keep writing the file). `RULES_VERSION` is 5: chats built before it read as outdated,
  and `conversations build` / `search --refresh` rebuild them. Long notes and mail (cli-memo) need it most.

- **`tasks list|add|close|stats`, and MCP `tasks_list`, `tasks_add`, `tasks_close`, `tasks_stats`**: what waits on
  you, kept in the local store. `list` shows each task with the message it points at (`--state`, `--chat`,
  `--type question,mention`, `--before-time`, `--limit`); `add <message> --type promise` adds one by `msg:`
  locator for what the rules cannot see; `close <task> --as done|dismissed [--reason]` closes it for good;
  `stats` counts open tasks per chat, the oldest, and the median time to close. Writes are local
  (`tasks.add`, `tasks.close`); an agent's are recorded as the agent's. A CLI adds `tasksCommand` to its program.

## 0.152.0 — 06.10.2026

### Added

- The reply rules file takes an `audience` for every rule: `"reply": "all"` (the default) or `"listed"`, an
  `allow` and a `deny` list of `people` and `chats`. `listed` answers only those on `allow`; `deny` is never
  answered and wins over `allow`. An id on both lists, an `allow` list under `"all"`, and `"listed"` with
  nothing allowed are warned about by `replies status`, `replies test` and `serve`, never refused. It limits
  answers only: a rule's task still opens. The test-account limit stays on top of it.
- A reply rule's `"do"` may name `"task"` now that tasks are in the store: it opens one `request` task for the
  message, for anyone the rule matches — only the answer still waits for a sender named in `testers`, and for
  `replies.send` at `allow`. `serve`'s result counts them as `replies.tasks`; `replies test` shows `task: true`
  and `text: null` where nothing would be sent. `Replied` gains an optional `task`, and a rule that only opens
  a task reports `skip: "opened a task, sent nothing"`, so a reader that counts `sent` and `skip` keeps working.
  `openRequestTask` is exported for a CLI with its own `serve`.

### Fixed

- `mcp --http`: the consent page no longer makes the browser post its form with `Origin: null`, which the
  server's Origin check refused, so a browser app could not finish logging in. Found in the owner's live check.
## 0.151.0 — 06.10.2026

Released early: max-cli chart adoption needs the capability that hides unsupported daily member tracking

### Fixed

- `Messenger.tracksMembers: false` omits `chats members fetch --track` for a CLI whose own
  background service does not fetch rosters daily. The default keeps the shared service's option;
  an explicit fetch and stored member history remain available to both kinds of consumer.

## 0.150.0 — 06.10.2026

### Added

- `statsCommand(messenger)` mounts `stats charts <chat>`: messages, active authors or joins and leaves
  per calendar day or week as a neutral `{ chart }` JSON description. `--output activity.svg` writes
  a new private SVG with a dark theme, preserving missing dates as gaps and labelling partial data.
  MCP `stats_charts` returns chart data from the store without writing files or connecting; membership
  is unavailable there. Existing statistics commands and their outputs do not change.
- `./charts` exports the neutral data, builders and replaceable `ChartRenderer`. SVG rendering loads
  Apache ECharts 6.1.0 only when an image is requested; JSON does not load it. The new dependency and
  its transitive packages add about 61.6 MiB of published unpacked files before deduplication.

- **`review` and `serve` keep a list of what waits on you.** Each review, and `serve` as each message
  arrives, opens a task in the local store for a question nobody answered and a message that mentions you
  by name, and closes it once you answer. Run twice over the same chats, it adds nothing; a task you
  dismissed stays dismissed. Only your own answers count, and an `@handle` mention is not seen yet.
  `review --json` and `serve`'s final summary say how many tasks were opened and closed (`tasks`).
- **Open tasks in the store (store version 20).** `store.tasks` keeps what `@leemour/cli-tasks` tracks — a
  question, request, mention or promise waiting on the owner — as a locator to its message, never the text.
  Backup, restore and export carry the tasks with the messages. Builds from 0.49.0 on still open the file.
- `contacts profile <person> [--show-phone]` and read-only MCP `contacts_profile`: what the messenger says about
  one person — every handle, bio, birthday, phone where shown (last four digits unless `--show-phone`), its own
  flags (`bot`, `verified`, `premium`, `scam`, `fake`, `restricted`, `deleted`, `support`), `seen` (`online`,
  `recently`, `week`, `month`, `hidden` or a time), `contact`, `mutualContact`, `commonChatsCount`, `registered`
  (`at`, `source`: `telegram` | `max` | `estimate`, `precision`) and `hasPhoto` — and for each chat shared with
  them, how many of their messages the store holds, the first and the last, and whether the chat is stored whole.
  `--offline` describes them from the store. An adapter gives the facts through the optional
  `PersonProfiles.profile`; without it the store answers.
- `contacts check <person> [--no-registries]` and read-only MCP `contacts_check`: whether one person looks like a bot,
  a fake or a spammer — `{ person, score, reasons: [{ reason, weight, source, detail }], registries: [{ name, answer:
  listed|clean|unknown, checkedAt, detail }], unknown }`. Reasons: the messenger's own marks (`bot`, `scam`, `fake`,
  `deleted`), the profile (`no_photo`, `no_username`, `odd_name`, `no_bio`, `new_account` with where its date came
  from, `photo_recent` from the oldest photo still shown), the store (`never_wrote`, `link_first`, `same_text` — one
  text in several chats), and the public ban lists Combot CAS and lols.bot (`cas_banned`, `lols_banned`,
  `lols_scammer`), **which are sent the person's id**; `--no-registries` asks none of them, `--offline` asks nothing
  online. A list down or refusing is `unknown`, the rest still answer; a Telegram-only list says so for another
  messenger. A CAS key, where the owner keeps one, is read from the keyring account `registries:cas` or
  `<PREFIX>_CAS_API_KEY` and only ever sent as a header. A hint, never a verdict.
- `chats members audit --deep <n>` (MCP `deep`): the top n flagged members also get the full check, one a second.
- `MessengerAdapter` takes an optional `photos(person)` (`ProfilePhotos`): how many profile photos they show and the
  oldest one's time.
- `contacts context <person> --chat <chat>` (repeat it for more): their newest messages in each chat named,
  oldest first, `{ at, text }` each — short for an agent to summarise; `-v` adds ids, locators, the sender and what
  it answers, `-vv` everything. `--limit` is per chat (20). `--refresh` reads them from the messenger first: by
  sender where the adapter offers `historyFrom` (new optional `SenderSearch`), the newest page of the chat where it
  does not. MCP `contacts_context` takes `chats` and `detail`. Without `--chat`, the answer is as before.
- `./cli` exports the reply step a CLI with its own server calls per arriving message — `replyTo` with its
  `Replier` dependencies, `Replied`, `NO_RULES`, `NOT_ALLOWED` — and `repliesPathFor`, `repliesStatePathFor` and
  `senderFacts`, so max's `serve` answers by the same rules as tg's.
- `serve` fetches every tracked chat's member list once a day (`chats tracking`), one chat after another, starting
  a minute after it connects so catch-up goes first. A chat already fetched that day is skipped, so a restart does
  not fetch it twice; a chat that fails is named on stderr and the rest go on. Its answer adds
  `members: { fetched, failed }` when it fetched any. The timer ends with `serve`.
- `chats members history <chat> [--since-time]` and read-only MCP `chats_members_history`: who joined, who left and
  whose profile changed (with what it was before), oldest first, from what `chats members fetch` recorded — never
  asks the messenger. `chats stats` adds `memberCounts`, the recorded count per day in its period, and
  `chats members list --offline` answers from the store.

### Changed — may break callers

- `MessageStore` has a new required member, `tasks`: the `TaskStore` of `@leemour/cli-tasks` over store version 20.
  A `MessageStore` written by hand — a test fake — adds it, `memoryTaskStore()` from `@leemour/cli-tasks/testing`
  will do; `openStore` already does.
- `MessageStore` has a new required method, `senderStats`: one person's stored messages per chat. A store
  written by hand — a test fake — adds it; `openStore` already does.
- `Services` has a new required member, `botcheck`. A `Services` object written by hand — a test fake — adds it;
  `servicesFor` already does. The audit's reasons and weights moved to `src/botcheck/reasons.ts`; `AuditReason` is
  still exported from the same place.


## 0.149.0 — 06.10.2026

### Added
- `storeOnlyDeps(store, account, { app })` in `./services`: the store-backed services — conversations,
  embeddings, person context — for a program that is not a messenger but keeps its sources in the store
  (cli-memo's notes and mail). It never connects and refuses every send. `personContext` and
  `identityIn`, with their types, are exported from `./services` too (#578).

- `chats mark-read --topic <id>` and the `chats_mark_read` tool's `topic` mark one forum topic read, through the
  new optional `ReadState.markTopicRead`; a messenger without it refuses rather than mark the whole chat read.
  The journal records the topic id.
- Published testing helpers include the synthetic search recipe corpus. The deep parity auditor compares actual CLI, MCP and service queries on Node and Bun, with scope, bounds, permissions and file-text checks.
- Consumers can reuse AI setting resolution and the agent-linking MCP prompt. Ordinary MCP context accepts `offline: true` for local reads.

- `chats members fetch <chat> [--track] [--budget <pages>]` reads a group's whole member list into the store's member
  history (store version 18): who is new, who is gone, whose profile changed, and today's count. Someone is recorded
  as gone only when every member was read and the chat's own count agrees — never from a list cut by `--budget`,
  Telegram's cap or MAX's partial lists. `--track` also puts the chat on the daily list.
- `chats tracking list|show|add|remove`: the chats whose member lists `serve` will fetch daily — review them, see one
  chat's count per day for 30 days, add or remove one (a local write, `chats.tracking.add`/`.remove`). Read-only MCP
  `chats_tracking_list` and `chats_tracking_show`. The daily fetch in `serve` comes next.
- `./store` exports the member-history types (`MemberStay`, `MemberCount`, `ProfileRevision`, `RosterRead`,
  `RosterChange`, `TrackedChat`).
- `messages context --thread` reads a stored message's parent chain and chosen replies, keeping interleaved
  discussions apart. `messages search --thread` attaches the same graph context to each hit. Each link names
  its source (`provider`, `rule`, `agent`), kind, confidence and method. Bounds are independent of network
  refresh: `--thread-hops` (8), `--thread-messages` (50), `--thread-bytes` (65536 bytes of whole message/link
  JSON) and `--thread-within` (1 day either side). The answer names every bound that stopped expansion.
  Edges whose endpoints changed are labelled stale at read time and are never followed; deleted text is
  excluded. A chat never built falls back to bounded local time context and says why. Ordinary time context
  stays available separately. Thread reads never connect, mark read, rebuild or infer. MCP uses matching
  snake_case arguments under the message-read permission. Context JSONL with `--thread` emits one context
  record, including links and bounds; search JSONL keeps one hit per row with its `thread` field.
  See the [thread context guide](docs/search/thread-context.md).

- Agents can link a stored chat's conversations entirely over MCP. The `link-conversations` prompt
  serves the same guide as `skill show link-conversations`, including its per-chat cost and consent gate.
  `conversations_batches_status` and `conversations_batches_next` read the pending work;
  `conversations_links_add`, `conversations_links_clear` and `conversations_build` write only the local
  graph under `permissions.conversations.links`. Rebuild after answers are saved or cleared. No model
  runs, messages are sent or chats marked read. Write tools are hidden on readonly/deny and refuse ask
  with the setting needed to allow them. See [the linking guide](skills/link-conversations/SKILL.md).

- `messages search`, `messages stats` and `conversations search` accept opt-in `--sync-first`: fetch new
  messages before reading the local store, reusing archive fetch and never marking read. Bounds:
  `--max-chats` (5 recent chats), `--sync-time` (30s), `--max-messages` (500 total). An in-flight request is
  awaited; the time budget stops between requests. Explicit chat filters narrow the refresh. JSON adds
  `refreshed: { chats, messages, failed, complete }`; failed or bounded refreshes keep the local answer with
  stale coverage and a diagnostic. A refresh cannot fetch other stored accounts over the active connection,
  or MAX's pushed-history mode: those scopes remain stale. MCP uses `sync_first`, `max_chats`, `sync_time`,
  `max_messages`, available only under `messages.sync-first: allow`; local reads stay available without them.
  Conversation sync does not build or embed: `--refresh` remains that separate local step; using both keeps
  its existing `refreshed` graph report and adds `networkRefreshed` for the network report.

- Agents write back the text they read from scans and photos. `attachments list [--chat <chat>] [--needs-text]`
  (paged; MCP `attachments_list`, read-only) names each file of a stored message — locator, attachment number,
  `localPath`, and whether its text is held (`origin`, `extractor`, `chars`) — never the text; `--needs-text`
  keeps the files saved here that have no text yet. `attachments text set <chat> [message] [--attachment <n>]
  [--text-file <path>]` (or a `msg:` locator alone; stdin when no file is given) and MCP `attachments_text_set`
  keep that text with origin `agent`, replacing what was there; `attachments extract` never replaces it. The
  text never passes through the command line. Permission keys: `attachments.text.set` (a local write);
  `attachments list` counts as `messages`, since file names and places say as much as a message.
- Search inside files (store version 19). `attachments extract [--chat <chat>] [--limit <n>]` reads the text
  layer of files `messages download` saved — plain text (txt, md, csv, tsv, json, log), Word (docx) and PDF with
  a text layer — into the local store, and `content:<word>` or `content:"a phrase"` in a strict search finds the
  messages whose files hold it. `text:` still looks only at what was written, and file words do not rank
  results. `--download --output-dir <dir>` first saves, from the messenger, files no download saved yet; nothing
  is fetched without it. A scan or a photo is answered `needs-agent`: there is no OCR. A photo is known by its
  kind, type or name and never read; voice, audio, video and stickers are passed over unread. The answer names
  each file (locator, attachment number from 1, status, extractor, characters), never its text. Each file is
  looked at once — photos and PDFs with no text layer included — and again only when its size changes; `--limit`
  stops after that many files and the next run continues. `store check` checks the files' word index too.
- Word and PDF need the optional packages `mammoth` and `unpdf`, declared as optional peer dependencies and
  never installed with this package; without one, those files are skipped, a note names the install, and the
  next run reads them. Consumers add `attachmentsCommand` to their command list; the permission key is
  `attachments.extract`, a local write refused by a read-only profile.
- Deleting a message erases its files' text and words, also under builds pinned to older versions of this
  package. `store reindex` rebuilds the files' word index too, and answers `fileTexts`.
- `messages download` records in the local store where each file of a held message went
  (`attachments.local_path`), single messages and `--all` alike, so a file's text can be read from it later.
  A file is matched to its attachment by kind, in order, or by a unique name; one it cannot tell apart is
  not recorded. A failed store write only warns: the file is saved. `RemoteFile.position` is optional: an
  adapter that knows the attachment's place may set it, and the store then matches by it.

### Fixed

- Ordinary context preserves account-qualified locators and refuses foreign accounts before reads. Topic search rejects empty and oversized queries before refresh or index access.

- Strict search: a `filename:` regex folds its letters as file names are compared, so `filename:/Invoice.*/`
  finds `invoice.pdf` and `filename:/счёт.*/` finds `Счет.pdf`. A character with no single folded form answers
  `unsupported_regex`, as in a `text:` regex.
- Stored link reads label changed or deleted endpoints stale immediately, for provider and rule links as
  well as agent answers. Earlier reads trusted the persisted flag and could follow an outdated parent until
  the next rebuild. `conversations links` now excludes these edges from its chosen parent chain.

- Profiles can configure embedding and analysis providers/models/endpoints; flags override configuration, while local e5-small embeddings and owner-agent analysis remain defaults. `models text key set anthropic` supports Anthropic credentials; custom endpoint keys never fall back to a public provider key.
- `conversations build --analyze --chat` opts into bounded OpenAI-compatible or Anthropic batch linking, using the existing linking skill and atomic answer validation. Analysis consent is remembered per account/chat/provider endpoint, listed/revoked with `conversations consents`. Embedding consent remains per run.

- Conversation search accepts a separate strict Lucene `--filter`, `--timezone`, and explicit `--source` account scope. Any matching message makes its conversation eligible before word/vector ranking; results include qualified locators and scoped readiness. Default search remains the active account.

- `conversations embed --max-chunks` help says there is no limit with `--chat`, as the command behaves; it said 2000.

### Changed — may break callers

- High-level message search and statistics default to strict Lucene, matching CLI and MCP. Callers needing the old syntax must pass `language: "legacy"`; RegExp requests and low-level store helpers retain their defaults.

- `conversations search` stops padding hybrid results with nonpositive meaning scores. Local e5-small
  (384 dimensions) now keeps cosine strictly above 0.80 before rank fusion; other models keep positive
  cosine, since their scores have not been calibrated. Exact word matches remain eligible. Searches
  may return fewer results and a formerly combined hit may become words-only (`score: null`). The
  synthetic held-out set reduces false no-answer hits from 30 to nine, with recall89.6%→87.5% and
  MRR0.769→0.825. The cutoff does not guarantee relevance and does not change `conversations related`.
  See [the reproducible quality report](bench/search-quality/README.md).

## 0.148.2 — 05.10.2026

Released early: MAX and TG adoption is blocked by contact-context message reads bypassing denied message permissions

### Fixed

- `contacts context`, including MCP, is checked as a message read because it returns stored message bodies.
  `permissions.messages: deny` now blocks/hides it like the other reads. Local identity linking keeps its own
  contact permission; it returns no message bodies.

## 0.148.1 — 05.10.2026

### Fixed

- Release notes place member history in 0.148.0, whose published build already contains store version 18;
  this patch adds no migration.
- MCP message search/statistics keep no query history when recording was explicitly disabled (`--no-record`
  or `record: false`), matching the commands. Personal MCP hosts pass the new optional `history` default.
- `flood clear` maps as owner maintenance, like configuration and diagnostic commands, so consumers mounting
  it do not fail with an unknown permission path. It remains absent from MCP.

### Added

- `./cli` exports the shared store-setting helpers for CLIs with their own configuration command:
  `STORE_SETTINGS`, `isStoreSetting`, `storeSettings` and `changeStoreSetting`. They preserve global scope,
  validation and reindex guidance without a second implementation.

## 0.148.0 — 04.10.2026

### Added

- Member history in the store (store version 18): `saveRoster` records one read of a group's member list — a stay
  per person (first and last seen, when the messenger says they joined, who invited them, role, when they were
  first missing), a member count per day, and each profile a member was seen with (name, username, the bot, scam,
  fake, deleted and photo marks) when it changes. Someone is recorded as gone only from a list read whole. Read
  with `memberStays`, `memberCounts` and `profileRevisions`; `trackMembers` and `trackedChats` keep the chats a
  daily fetch will cover. Older builds keep opening the file: version 18 only adds tables and a nullable column.

- `store repair [--dry-run]` brings every table of the store to this build's shape without deleting anything. A
  table only missing columns it can take gets them added; any other difference renames it to a copy,
  `<table>__repair_<hash>`, beside a new table that holds every row that fits. The answer lists what was done,
  rows left only in a copy, columns only a copy has, and every mismatch left for a person to decide.
  `--dry-run` does the same work and rolls it back. `store copies delete <name>` deletes one copy, named exactly.
  Repairs a store an early draft of version 13 set up, where reading a message failed on `messages.mentions`.
- `serve` answers with the reply rules (`config/<profile>.replies.json`), **only to the test accounts named in its
  new `testers` list** (`[{ "id": "<sender id>" }]`, `provider` optional) — nobody else, and nobody at all while the
  list is empty or missing. A new message from a tester goes through the rules in file order, and the first that
  answers sends, under the new permission key `replies.send` (`deny` by default; `ask` sends nothing, since `serve`
  has nobody to ask). Messages from before `serve` started, edits and messages already answered are left alone. A
  failed send is tried once more with the same send id. The send journal records `origin: "rule:<id>"`, and
  `serve`'s result counts `replies: { sent, skipped }` by reason. `replies test` reports a sender who is not a
  tester as `not a test account`. `replies pause` stops every rule at once, a running `serve` too; `replies resume`
  undoes it; `replies status` says whether the rules may send, which are on, and how many testers there are.
  `SendRequest` takes `key` and `origin`; `SendEntry` has `origin`; `replies` is a permission resource.
- `contacts context <person> [--limit] [--since-time]` and read-only MCP `contacts_context`: what the store holds
  about one person in every messenger linked to them — shared chats, the last message each way, their recent
  messages in the direct chat and in groups, where others mentioned them, each with a locator. Store only, marks
  nothing read; `complete: false` and `notRead` name a shared chat not stored whole.
- `contacts link <person> <messenger>:<person>` and `contacts unlink`: record that a Telegram and a MAX identity
  are one person, or undo it, in `identity_links` with an event per change. `./store` exports the same as
  `MessageStore.linkIdentities`, `unlinkIdentity` and `personOf`, for programs that join other sources.
- Store version 15: a stem index beside the word index, its queue, and a store-wide stemmer setting.
  `store migrate` builds a stem index; queries unchanged. `store reindex` rebuilds it, `store info` and
  `store check` report it (`stemIndex`), and `config set searchStemmers.cyrillic|latin` chooses the stemmers
  for the whole store (`russian` or `none`; `spanish`, `english` or `none`). `MessageStore` gains `stemsState`,
  `fillStems`, `stemmers` and `saveStemmers`.
- Tags: the owner's own labels on a chat, a person or one message, kept in the local store and never sent.
  `tags add <tag...> --chat <chat> | --contact <person> | --message <message>` (an id with `--chat`, or a `msg:`
  locator alone), `tags remove` with the same target, `tags list [--tag <tag>] [--type chat|contact|message]`, and
  MCP `tags_list` (read-only), `tags_add` and `tags_remove`. A tag is 1–32 letters a–z, digits and hyphens; upper
  case is lowered and anything else is refused (`invalid_tag`). Writes check `permissions.tags.add` and
  `tags.remove`: `readonly` refuses them and hides the MCP writes, `ask` refuses with `confirmation_required`, since
  there is no question to put. Each CLI mounts `tagsCommand` at its next bump; until then the parity rows are
  planned. Services: `TagsService` (`services.tags`); store: `addTags`, `removeTags`, `tags`.
- `tag:<tag>` in a strict search, until now refused with `unsupported_field`: a message tagged, in a tagged chat,
  or from a tagged person. Exact, so `NOT tag:work` is exact too. Store version 16 adds the `tags` table and the
  triggers that drop a message's or chat's tags when it is deleted, under any build; `min_compatible` stays 6.
- `replies test [rule] [--since-time <time>]`: what the auto-reply rules would have answered in the stored
  messages (7 days if not given), to whom, with what text, and how many messages each rule passed over and why.
  It tries a rule that is off as if it were on, applies the limits as `serve` would, and starts each run from an
  empty memory of past replies. It never connects, sends nothing and writes no file. Nothing answers messages yet.
- Saved searches and search history. Every successful `messages search` and `messages stats` — command or MCP —
  records its query and options in the local store, never a message or a result; the same run again counts on its
  row, and the newest 1,000 runs are kept. A refused query and a run with `--no-record` are not recorded. `searches
  create <name> [query...]` saves without running and takes `messages search`'s options plus `--by`, refusing a
  taken name unless `--replace`; `searches list`, `searches show <name|id>`, `searches history [--limit]`,
  `searches delete <name|id>`, `searches clear` (the history; saved ones stay). `messages search --saved
  <name|id>` and `messages stats --saved <name|id>` run one: the stored query is parsed and checked again, more
  words are AND-ed, typed options replace stored ones. MCP: `searches_list`, `searches_history` (read-only),
  `searches_create`, `searches_delete`, `searches_clear`, and `saved` on `messages_search` and `messages_stats`
  (`answerMessagesSearch` and `answerMessagesStats` take the searches service as a fourth argument; without it
  `saved` is refused). Keys `searches.create`, `searches.delete`, `searches.clear`. Store version 17 adds the
  `searches` table; `min_compatible` stays 6. Each CLI mounts `searchesCommand` at its next bump.
- `doctor` says `login: { state: "not checked" }` until `--online` is given — a session file on disk is not a
  working login. With `--online` the login is `ok` or `failed`, with a hint.
- `doctor` names every private file or folder others can read — the store and its `-wal`/`-shm`, the send journal,
  the runs folder, and the store's folder unless `MESSAGING_STORE` chose it — with the `chmod` that fixes it. It never
  changes a mode itself. Not checked on Windows.
- `doctor --online` reports `clock: { skewMs, uncertaintyMs, ok }` against the messenger's own time, warning at 10 s,
  and `standing` (`active`, `frozen`, `banned`, `deactivated`, `revoked`, `unknown`) with any dates and appeal link.
  Both come from the new optional adapter group `AccountHealth` and from `details.standing` on a refusal. A messenger
  with `health` that could not check the standing reports `unknown`, never `active`.
- `mcp doctor` shows the last 20 lines (at most 2 KB) of the server's stderr when it fails to start, with the home
  folder, long numbers and token-like strings hidden.
- **`flood clear`** forgets the profile's remembered waits and lifts its hold on writes, says what it cleared, and
  answers `{ profile, cleared: { deadlines, sendBlock } }` with `--json`. It never connects. Exported as
  `floodCommand` from `./cli`; tg and max list it as planned until their next cli-messaging bump. No MCP tool on
  purpose: an agent must not lift a hold. STANDARD adds `flood` to the singular resources and defines the word.
- `server status` and `doctor` show the waits a messenger asked this profile to keep, and a hold on its writes, as
  `flood: { deadlines, sendBlock }`. `FloodMemory` and `floodPathFor` are exported from `./sends`. The new
  `AccountStanding` state `limited` is a write refused as spam, with no end the messenger reports.

### Changed — may break callers

- **A wait the messenger asked for is remembered.** A `rate_limited` answer with `retryAfterMs` is kept in
  `<state dir>/flood/<profile>.json` (0600) per adapter call, and per chat when the call named one by id. Until it
  passes, the same call fails at once with `rate_limited`, `retryAfterMs` and `details.remembered: true`, without
  asking the messenger. A caller that retried at once after exit 8 now gets exit 8 again, sooner. At most 50 are
  kept; expired ones are dropped. The consumer test this touches: "stops at a long wait with what it had read kept"
  in `backfill.test.ts` now expects the next run refused until the wait passes.
- **A frozen or spam-limited account's writes are held.** A refusal with `details.standing.state` `frozen` or
  `limited` holds every write that counts toward `sendsPerHour` — reads, reactions and marking read still work —
  with a `permission_error` (exit 5) that says until when and points the owner to `doctor --online` and
  `flood clear`. The hold lasts until the messenger's `until`; without one, a spam limit holds for an hour
  (`LIMITED_HOLD_MS`), set again by each new refusal, and a frozen account for a day (`FROZEN_HOLD_MS`).
  `doctor --online` sets a frozen hold on a frozen standing, with the messenger's dates, and lifts it on an active
  one; it never lifts a spam limit.

- The adapter contract case for `historyAfter` no longer requires `hasMore: false` on a page shorter than the
  limit: Telegram drops deleted messages from a page, so a short page proves no end. It now reads past the newest
  message and requires an empty page with `hasMore: false`. The case is renamed to say so.
- `MessageStore` has new required methods — `addTags`, `removeTags`, `tags`, and `recordSearch`, `saveSearch`,
  `storedSearch`, `savedSearches`, `searchHistory`, `deleteSearch`, `clearSearchHistory` — and `Services` new
  `tags` and `searches` members. A store or a `Services` object written by hand — a test fake — adds them;
  `openStore` and `servicesFor` already do.
- `messages search` takes its query as optional (`[query...]`), since `--saved` can stand alone; without either
  it still refuses with a validation error.

### Fixed

- **`inbox`, `inbox --new`, `review` and `chats list --unread` (also `--search`, `--kind`) look at every chat**, not
  only the newest 100 or 200. A chat further down the list with unread or new messages was silently left out:
  the chat list is sorted by the last message, so an unread chat can be anywhere, and Telegram has no server-side
  unread filter. The services now call the adapter's `chats` without a limit, which tg answers by walking every
  dialog (one request per 100 chats, as resolving a typed chat title already does) and MAX from the chats its
  login sent, which may be only part of them. `partial` now means only that the messenger could not list every
  chat; the notes for chats past the 20-per-run cap say `skipped N chats`.
- Strict search: a `text:` regex folds its letters as the word index does, so `text:/Квартир.*/` and
  `text:/счёт/` find words they never matched; `[А-Я]` works as `[а-я]`, `\D \W \S` keep their meaning. A
  character with no single folded form answers `unsupported_regex` with a hint instead of an empty result.
  `body:` stays case-sensitive, and the guide now says so.
- Strict search errors say what to do: `~` names `--language legacy` for typos and `word*` for word forms; a
  short prefix such as `к*` over the term-expansions budget names the term, the budget of 10,000 words and a
  longer prefix (a chat or date filter does not help — the word list is the whole store's), with `term` and
  `limit` in the error; `index_not_ready` says how far the word index is and the exact `<cli> store migrate`.
- The search guide documents that folding merges some words (`мой`/`мои`, `ano`/`año`) and how to find the
  exact form with a `body:` regex.
- The parity manifest lists `mcp --http`, `--port`, `--public-url` and `--revoke` in both tg and max, which now
  have them.
- Two `serve`s started in the same instant for one profile can no longer both run. The lock is now
  taken in one step (`takeLock`, exported from `background`), not read and then written.
- A problem report labels every id of a send-journal line: `threadId`, `resultChatId`, `operationId`,
  `parentOperationId` and `reservation` were copied raw, and a send's raw `operationId` is its `sendId`.

## 0.147.0 — 04.10.2026

Released early: max-cli and tg-cli need the reviewed search coverage and history-boundary fixes for their coordinated release

### Added

- `server status` says when a unit stopped on an exit its CLI marked as not worth a restart (`noRestartOn`): for a
  refused login, run `session start`, then `server start`. JSON adds `stopped` (`exitCode`, `reason`,
  `restarts: false`) and `unit.exitCode`, read from systemd's `ExecMainStatus` (only for a normal exit, not a
  signal) or launchd's `last exit code`.

- MCP `inbox` and `review` take `kinds` (`["dialog", "group", "channel", "saved"]`) and `new`: what arrived since
  the last call with `new`, each message once, from saved points the MCP tools keep apart from the owner's
  `inbox --new` and `review --new`. `new` refuses `since_time`, and on `review` also `unanswered`.
- `chats members audit <chat> [--budget <pages>] [--min-score <n>]` and read-only MCP `chats_members_audit`: members
  of a group that look like bots, highest score first, each with its reasons — `bot`, `scam`, `fake`, `deleted`,
  `no_photo`, `no_username` (only where others in the list have one), `odd_name`, `never_wrote` and `link_first` (from
  the stored messages), `burst_join` and `mass_invited`. Reads the member list a page of 200 at a time, at most
  `--budget` pages (10) with a second's pause between them, and never one request per person; `more` says some
  members were not read, and `unknown` names the signals the messenger gave nothing for. The owner and admins are
  left out. It removes nobody. Not with `--offline`: the store keeps no member lists.
- `GroupMember` takes optional `joinedAt`, `invitedBy`, `isBot`, `deleted`, `flagged` (`scam` | `fake`) and
  `hasPhoto`, absent where a messenger does not say. Telegram's list carries all of them; tg maps them next.

- `chats stats` and MCP `chats_stats` also sum `comments` — the comment count a channel post carries in its
  provider metadata, beside `views` and `forwards` — and show it on each top post. Absent where no post carries it.

### Changed — may break callers

- `store fetch --page-size` takes at most 100 with the shared Telegram fetching defaults; a larger size is
  refused with `validation_error` (exit 2). A messenger that declares its own `fetching` without
  `maxPageSize` — MAX — keeps any size.

- `messages search` JSON (and MCP `<cli>_messages_search`) reports `coverage` and `wordsReady` from the store instead of
  constants. `wordsReady` is `false` for a metadata-only query (`has:file`, `kind:`) while the word index is still
  being built; before, it was always `true` there. `coverage.inventoryComplete` is `true` once every account in
  scope has handed the store its whole chat list (`markChatsLeft` now records when), and its type widens from
  `false` to `boolean`. `coverage.lastSyncedAt` is the oldest `store fetch` of the chats in scope, `null` when one
  of them was never fetched; each `completeness` entry adds `fetchedAt`. An existing store answers `false` and
  `null` until its next full chat list and `store fetch`. `ChatCompleteness` gains a required `fetchedAt`; neither
  CLI builds one. max-cli's `src/mcp.test.ts` expects `coverage.inventoryComplete: false` after a login that hands
  the store the whole chat list, so it will likely read `true` after the upgrade.
- Legacy `messages search` (`--language legacy`, `--regex`) and bot `people search` report the real `wordsReady` for
  a filters-only or `--regex` search too, instead of always `true`. The stderr note now says a search by words
  reads pieces of words until `store migrate` finishes the index.

- The `/catch-up` prompt takes `kind` and `mode` (`unread`, the default; `new`; or a time) in place of `since`;
  a time goes in `mode`. It marks read only when the owner asks, through `chats_mark_read` per chat shown, so the
  approval that tool carries still applies — `inbox` and `review` over MCP never mark read.

### Fixed

- A chat no longer reads as complete when a later `store fetch` held messages older than the point an earlier
  fetch took for its first one. Run `store fetch <chat>` again: once it finds older messages, the chat reads as
  partial until a fetch reaches its real start.

## 0.146.0 — 04.10.2026

Released early: tg-cli: its parity check refuses the mcp --http flags of 0.145.0; max-cli needs the exported HTTP pieces

### Added

- `./cli` exports `serveOverHttp`, `OVER_HTTP`, `httpTokenFile`, `revokeAll` and `MCP_PATH`, so a CLI with its own MCP
  server (max) can offer `mcp --http` the same way.

### Fixed

- The parity manifest lists `mcp --http`, `--port`, `--public-url` and `--revoke`, planned for tg's next
  cli-messaging bump and for max, so tg's parity check passes both before and after it adopts them.

## 0.145.0 — 04.10.2026

### Added

- `mcp --http --public-url https://<name>.ts.net [--port 8765]`: the same MCP tools over Streamable HTTP on
  127.0.0.1, for ChatGPT and Claude in the browser behind the owner's own tunnel, with no third-party proxy. Its own
  OAuth login for exactly one owner: apps register themselves, but a token needs the one-time code printed in the
  terminal (10 minutes, a new one after each login; five wrong codes lock the page until restart). PKCE `S256` only,
  access tokens for 1 hour, refresh tokens for 30 days and rotated on use, only their hashes kept, in a `0600` file.
  Every write asks through a form, whatever its permission level. `mcp --revoke` forgets every browser login.
  2025-era clients get a session bound to the app that opened it, so their forms work. Runs until Ctrl-C.

- `chats stats <chat> [--since-time] [--by day|week] [--timezone]` and read-only MCP `chats_stats`: a group's or
  channel's numbers for a period (7 days by default) — messages, people who wrote, replies, threads, reactions, the
  top posts, Telegram views and forwards where a post carries them, and questions asked and answered with the median
  minutes to an answer, by the rule `review --unanswered` uses. Counted from the local store; the command also asks
  the messenger who joined and left, how many of them wrote and how soon (`members`), which `--offline` and the MCP
  tool leave out rather than report as zero. `complete: false` when the store does not hold the chat whole or the
  messenger stopped reading joins early: every number is then a lower bound, and the terminal names the
  `store fetch` that fills it. Services: `ChatsService.stats`.

### Changed — may break callers

- `config set permissions.<key>` refuses a key that names no command and no checked write (exit 2,
  `validation_error`), and names the known keys beside it: `permissions.messages.dlete names no command — the known
  ones there are messages.delete, messages.edit, …`. `config unset` still removes such a key. Commands that read a
  file holding one warn on stderr, once per key, and go on. The known keys are every command of the program
  (through `keyForCommand`, or the new optional `Messenger.permissionKey` for a CLI's own commands), every key in the
  new `WRITE_KEYS` export (`/sends`) and their parents. `configCommand` takes an optional third argument
  `{ permissionKey }`; a CLI with its own `config set` calls `refuseUnknownKey(command, setting, value, permissionKey)`,
  which also checks every key of a whole `permissions` object.

## 0.144.0 — 04.10.2026

### Added

- `conversations status` without `--chat` (and MCP `conversations_status`) adds `unbuiltGroups`: how many group chats
  were never built, which `conversations build` would build. The terminal says it in a note, so "all ready" no longer
  hides that work.
- Public personal MCP catalogue and registration APIs in `./cli` let consumers retain their own
  sessions, permission scopes and account-scoped services while mounting the canonical tools.
- Photo previews accept an optional attachment `index`; direct transcription accepts `model`.

### Fixed

- Local MCP writes refuse `--confirm-send` without executing when their approval flow is unavailable.

- Confirmed scheduled sends execute the absolute time shown in the approval form, even after a
  delayed response. Personal MCP rejects unknown arguments before connecting or acting.
- Session callbacks can release the connection before local transcription. Stored conversation
  tools retain the selected profile and environment; held embedding models have a public disposer.
- Session listings use the exact `account.sessions.list` permission key.

### Changed — may break callers

- Obsolete or unknown personal MCP arguments now fail validation instead of being ignored.
  Clients must use the advertised schema, including `at_time` for scheduled sends.

## 0.143.0 — 04.10.2026

Released early: tg-cli and max-cli cannot move to 0.142.0: its parity manifest lacks rows for its own new options

### Fixed

- The parity manifest lists the commands and options 0.142.0 added — `inbox`/`review --kind`, `--mark-read`,
  `--no-mark-read`, `review --new`, `store export --to`/`--kind`/`--all`/`--encrypt`, `store backup --encrypt`,
  `store decrypt` — as planned for each CLI's next bump, so tg-cli and max-cli can move to it: their pre-push
  check refused every one.

## 0.142.0 — 04.10.2026

### Added

- `--encrypt` on `store export` (with `--output` or `--to`) and `store backup`: gzip, then AES-256-GCM with a key
  derived from a password by scrypt — Node's own `zlib` and `crypto`, no new dependency. The password is typed at a
  hidden prompt (twice) or piped on stdin, and kept nowhere: lose it and the file cannot be opened. An encrypted
  `--to` folder takes one sealed file per run and a manifest without chat titles, and refuses a later run whose
  password differs from the first. `store decrypt <file> --output
  <file>` opens one; `store restore` asks for the password of an encrypted backup. A wrong password or a changed
  byte fails and writes nothing.
- `review --new`: what changed since the last `review --new`, a point per chat kept apart from `inbox --new`'s, so
  one never moves the other. A chat cut short keeps its point. Not with `--since-time` or `--unanswered`.
- `inbox --mark-read` and `review --mark-read` mark each chat shown read, up to the newest message shown, under
  `permissions.chats.mark-read`; JSON gains `markedRead`. The profile setting `catchUpMarksRead` (off unless set)
  makes it the default, and `--no-mark-read` overrides it. The other side sees the mark.
- `messages stats [query] --by chat|sender|day|hour` and the read-only MCP tool `messages_stats` count what a strict
  query matches in the local store, each message once: by chat or sender (most first), or by calendar day or hour in
  `--timezone` (in order). No query counts every stored message. JSON: `{ by, items: [{ key, name, account?, count }],
  total, hasMore, page, limit, query, coverage, completeness }`; counts are lower bounds where coverage is not complete.
- `store export --to <dir>` writes chats into a folder, a JSON-lines file per chat and a `manifest.json`; run again
  on the same folder and it adds only what changed since: new messages, edits (also to old messages) and
  deletions, as `{ id, chatId, deleted: true }` with no text. Several chats, `--kind` or `--all`. A change to
  reactions alone is not counted as a change.
- `conversations related <chat> <message>` and the read-only MCP tool `conversations_related`: the conversations of
  every built chat nearest in meaning to the one the message is in, best first, never that one. The query is the
  mean of that conversation's stored vectors whose messages did not change since, so no model runs and none needs
  to be downloaded. JSON: `{ model, source, items, limit, readiness }`, items and `readiness` shaped as in
  `conversations search`. Refused with `not_found`, naming `conversations build` or `embed`, when the conversation
  has no such vector.
- `inbox --kind` and `review --kind` take chat kinds, comma-separated (`dialog,group,channel`), so direct chats,
  groups and channels can be caught up on apart or together.
- `date:` takes relative dates: `date:today`, `date:yesterday` (calendar days in `--timezone`), `date:7d` (since 7 days
  ago; also `30m`, `2h`), and the same in comparisons and ranges (`date>=7d`, `date:[30d TO 7d}`).
- `conversations status [--chat <chat>]` and the read-only MCP tool `conversations_status` say how fresh each
  built chat's conversations and vectors are: `state` (`ready`, `stale`, `partial`, `words-only`,
  `not-built`), the build's time and rules version (`graph.builtAt`, `graph.rulesVersion`,
  `graph.outdatedRules`), messages the build has not seen (`pending.new`, `pending.edited`, `pending.deleted`)
  and the chunks' vectors of the model (`vectors.current`, `vectors.stale`, `vectors.missing`). JSON is the list
  envelope with `model` beside it.
- Catching up without a chat at a time: `conversations build` without `--chat` rebuilds every built
  chat that changed since its build, then builds the group chats never built; `conversations embed` without
  `--chat` embeds the chunks left in every built chat; `conversations search --refresh` does both for its scope
  before it searches. `--max-chats <n>` (20) and `--max-chunks <n>` (2,000) bound one run, and the next run goes on
  from there. Only the model on this machine: `--provider` and `--base-url` are refused there, a model is never
  downloaded, and with none downloaded the build runs and nothing is embedded. JSON (and `refreshed` in search
  JSON with `--refresh`): `{ model, modelAvailable, built, embedded, left }`, `left` naming each chat that still
  needs `build` or `embed`. `conversations embed --chat` also takes `--max-chunks`.
- MCP `conversations_refresh` (`chat`, `max_chats`, `max_chunks`, at most 500 chunks a call by default) runs the
  same; it writes only to the local store and is offered by `permissions.conversations.embed`: hidden at
  `readonly`, refused with `confirmation_required` at `ask`. Any MCP tool not marked read-only is now hidden at
  `readonly`, not only the messenger writes.
- `conversations search` JSON (and MCP `conversations_search`) adds `meaning` (`searched` or `unavailable`) and
  `readiness`: chat ids in `searchedByMeaning`, `wordsOnly`, `partial`, `stale` and `notBuilt`. Each item adds
  `stale`: `true` when the matched chunk's text changed after it was embedded; the hit is still returned.
  `embeddedOnlyElsewhere` stays as it was.

### Changed — may break callers

- `MessageStore` has a new `changes(key, chatId, at)` method. tg-cli and max-cli do not implement `MessageStore`,
  so neither needs a change.
- `conversations search` no longer fails with `not_found` (exit 6) when the local model is not downloaded: it
  answers word matches with `meaning: "unavailable"` and names `models text download` on stderr. It never
  downloads a model or calls a remote one in its place. `ConversationHit` and `FoundConversation` have a new
  required `stale` field, and `MessageStore` a new `readiness` method; tg-cli and max-cli only call
  `MessageStore` and use neither hit type, so neither needs a change.
- `conversations build` and `conversations embed` without `--chat` no longer fail with `validation_error` (exit 2):
  they catch up every chat that needs it, as above. A script that relied on the refusal now does work.
  `MessageStore` has a new `unbuiltGroups` method and `EmbeddingsService` a new `refresh` method; tg-cli and
  max-cli implement neither, so neither needs a change.
- `MessageStore` has a new `conversationVectors` method and `nearestConversations` an optional `exclude`;
  `EmbeddingsService` has a new `related` method. tg-cli and max-cli implement none of them, so neither needs a
  change.

### Fixed

- **Permissions: the nearest section wins first, then the longest key.** A key a profile sets hides that key and
  every key under it in `personal.defaults`/`bot.defaults` and `defaults`. Before, `profiles.agent.permissions:
  {"messages": "readonly"}` did not stop `defaults.permissions: {"messages.delete": "allow"}`, so a read-only
  profile deleted without asking. This also loosens: a profile's `messages: allow` now hides a shared
  `messages.delete: deny`, and deleting falls back to the built-in `ask`. Old `readOnly` and `allow` count in the
  section they are written in. `config migrate` uses the same rule. New export `layerPermissions` (`/sends`).
- `config show` prints the permissions in force from every section, with a `sources` map per key, not only the
  nearest section's `permissions` object.
- `inbox --new` keeps a point per chat. A channels-only run no longer moves the point for groups, and chats past
  the first 20 read in one run show on the next run instead of never. A points file written by an older version is
  still read.
- `filename:` and `mime:` alone no longer fail on an archive with more than 50,000 messages with files: names are
  matched before the main query, so the candidate row limit does not apply to them.
- `has:link` also finds a message whose link exists only as a preview card (MAX `share`, Telegram `webpage`),
  not only a URL typed in the text. A photo's own URL still does not count.
- Deleting a message drops the vectors of the chunks that held it, of every model, unless a current chunk with
  no deleted message still uses the same text. A meaning hit on a chunk with a deleted message is never
  returned, also for vectors kept from before this release.

## 0.141.0 — 04.10.2026

### Added

- Strict search finds messages by their files: `filename:*.pdf`, `size>10MB`, `size:[1KB TO 300KB]` and
  `mime:image` match when any attachment fits, with no text needed. File names compare whole, ignoring
  case and accents. `mime` works only where the messenger reports a type (Telegram does, MAX does not).

### Fixed

- Correct the storage index guide: strict Lucene is the default; automatic typo and substring fallback belong to explicit legacy discovery.

## 0.140.0 — 04.10.2026

Released early: tg-cli and max-cli releases need scoped command discovery and the parallel local-read lock fix.

### Added

- `commands [path...]` inspects one command or group without loading the whole command tree.
  It retains global options and exit codes, includes inherited options and resolves aliases.
  Inspect different command groups in separate calls; the full-tree output remains unchanged.

### Fixed

- Store connections set the SQLite busy timeout before journal initialization, waiting for
  brief contention instead of immediately failing with `database is locked` during parallel reads.

## 0.139.0 — 03.10.2026

Released early: max-cli hearing and unanswered-review fixes need the new read connection and enrichment APIs

### Added

- Personal `messages link` and read-only MCP return an account-scoped locator plus an optional
  provider permalink, audience and fallback reason. The optional adapter capability keeps existing
  adapters compatible. Offline uses only the active account’s stored target; cross-account locators
  are refused. Link output contains no message body, and a URL grants no chat membership.

## 0.138.0 — 03.10.2026

Released early: max-cli hearing and unanswered-review fixes need the new read connection and enrichment APIs

Released early: MAX permission cutover needs legacy pin/unpin preservation and enforcement of explicit unpin overrides

### Fixed

- CLI message lists, inboxes and reviews with transcription reuse their read connection to fetch
  voice recordings, closing it before local recognition instead of opening a second connection.
  Explicit mark-read finishes before hearing on that connection; plain reads still mark nothing read.
- Unanswered reviews now consider retained and newly heard voice transcripts before filtering,
  on both CLI and MCP paths. Unheard voices keep a review incomplete, and original message text
  remains unchanged. Admin IDs are read before hearing releases the connection.

- Legacy `allow: ["pin"]` retains permission to unpin during configuration migration. Shared
  unpin writes now check `messages.unpin`, so an explicit per-command override applies to the
  operation as well as its CLI read gate. MAX permission migration depends on this correction.


## 0.137.0 — 03.10.2026

### Fixed

- `chats show` reports listed members and the chat's participant total without claiming that a
  differing count proves incomplete loading: a list can omit the current account or be partial.

## 0.136.0 — 03.10.2026

Released early: max-cli streamed download adoption needs response MIME filename fix; 0.135 mislabels unnamed WebP photos as JPEG

### Fixed

- Download fallback names use response MIME learned during lazy streaming, preserving WebP/PNG
  extensions instead of assuming JPEG. Named files and atomic no-overwrite behavior stay unchanged.
  This unblocks MAX shared-download adoption without pre-opening unused hearing attachments.

## 0.135.0 — 03.10.2026

Released early: max-cli shared bulk download adoption needs descriptor paging to preserve its 30-message and 5-second fetch policy

### Added

- `config migrate [--dry-run]` replaces legacy `readOnly`, `allow` and supported `mcpTools` entries
  with permissions while preserving effective personal/bot access across all configuration layers.
  Preview and no-op leave the file untouched; profile locks refuse whole-file writes. Legacy
  CLI setting edits refuse once the file contains permissions. Existing
  canonical choices and unrelated settings stay. `migratePermissionConfig` is exported from `./cli`
  for consumers with their own configuration commands. Consumers retaining native guards must
  adopt permission-aware enforcement before exposing migration.

### Fixed

- `messages download --all` uses the messenger descriptor's remote page size and default pause, matching its archive fetching policy. Store-only walks retain 100-row local pages. MAX adoption can now preserve its 30-message/5-second policy; Telegram defaults stay unchanged.

- Detailed evidence bundles summarize assertion names/statuses and counts instead of duplicating Vitest's raw coverage maps; the full per-repository JSON reports remain separate for review.

- Detailed schema comparison preserves actual fields named `title`/`description` and literal default/const values, while ignoring documentation annotations; field bounds/types and defaults cannot disappear as prose.

- The parity manifest marks native `bot api` and its credential destination option as present in
  both CLIs after Telegram's generated API and MAX's shared command migration merged.
  Generated native operations use the standard's provider-schema exemption; the common group,
  its flags and handwritten commands still require manifest rows.

## 0.134.0 — 03.10.2026

Released early: tg-cli generated Bot API and max-cli shared native API adoption need the generated command assembler, RPC input helpers and keyring-only credential storage exports

### Added

- Shared generated native Bot API commands, JSON body/field validation, lossless integer handling
  and schema-directed multipart planning for HTTP and RPC consumers. Generated credential-returning
  methods require an explicit `--store-token` destination; bot token storage can require the OS
  keyring without a plaintext fallback. Providers can supply destructive permission defaults.

- Detailed parity audit evidence and synthetic consumer checks via `--deep --output <new-directory>`; the existing surface audit is preserved.

### Fixed

- Detailed audit test homes use short temporary paths, so a launcher with a nested TMPDIR does not make MAX Unix-socket fixtures fail solely because the path exceeds the system limit.

## 0.133.0 — 03.10.2026

Released early: max-cli audio-model migration needs the public speech catalogue and installer export

### Added

- `./speech` exports the existing pinned speech-model catalogue, types, ordering, shared model
  directories, installed-file checks and verified installer. Consumers can reuse downloaded files
  and remove their copied paths/installers without loading the recognizer at import time.

## 0.132.0 — 03.10.2026

Released early: Telegram and MAX formatter adoption requires the shared formatMarkdown capability and neutral text spans

### Changed — may break callers

- Personal and bot `--md` send/edit delegate conversion to each adapter's optional `formatMarkdown`. Adapters without it refuse Markdown; plain text is unchanged. Additive `FormattedText`/`TextSpan` and `formatting` options carry rich formatting while legacy Markup/parser/markup exports remain compatible. Telegram and MAX can now use different syntax.

### Fixed

- The parity manifest records MAX’s shared moderation command and its options as present, and
  removes the retired `chats check` row after the consumer migration.

## 0.131.0 — 03.10.2026

Released early: max-cli moderation migration needs join events bounded to the current history batch before merging

### Fixed

- Moderation defers join events beyond its capped message batch until the next run. A separate
  event scan can read farther than history; it no longer removes later members before their batch
  is judged, or judges their join twice across the saved checkpoint.

## 0.130.0 — 03.10.2026

Released early: max-cli moderation migration needs parity to permit retirement of chats check before it can merge

### Fixed

- The parity manifest accepts retirement of MAX’s legacy `chats check` during its move to the
  shared `chats moderate` command. Both consumer revisions pass while the migration merges.

## 0.129.0 — 03.10.2026

Released early: max-cli needs the common upgrade workflow and metadata-preserving MCP search bridge

### Added

- The MCP message-search schema and response bridge are exported for consumers retaining their own
  server lifecycle. They forward language/timezone/AST/scopes and preserve search metadata, so a
  consumer need not copy query validation or discard archive coverage. Shared tools use the same bridge.

- Shared `upgradeCommand` and `upgradePackage` centralize version checks, package-manager execution
  and optional host server restarts. Check/manual/no-new-version paths never install; failed installs
  and host callbacks never trigger a retry. Consumers bind their existing environment and retain
  their server policy. The common JSON result always includes `restarted`, empty when none restarted.

### Fixed

- MAX group reads now use the canonical event flags and member paging options. Retire the temporary legacy event-option rows after max-cli adopted shared reads; its new event and member options are recorded as present.

- Search language, timezone and regex options are marked present in both CLIs after their shared 0.127.0 adoption; the obsolete claim that MAX search accepts only chat ids is removed.

## 0.128.0 — 03.10.2026

Released early: max-cli shared group reads need accurate truncation guidance and compatible event flags


## 0.127.0 — 03.10.2026

Released early: max-cli and tg-cli search integration need the shared Lucene query profile

### Added

- A versioned Lucene 9.12.3 query profile for local message search, shared by CLI and MCP:
  Boolean and field groups, typed date ranges/timezones, peer kinds/topics, bounded term/body
  regex and wildcard matching, candidate presets, structured AST input and coverage on empty results.
- Canonical search guide/specification, generated reference tables and ten executable recipes;
  development-only Lucene reference fixtures and an explicit legacy migration preview.

### Changed — may break callers

- CLI and MCP message search now use strict Lucene matching by default. Use `--language legacy`
  (MCP `language: legacy`) for the old discovery parser, `after:`/`before:` and fuzzy fallbacks.
  Existing low-level service calls without a language preserve legacy behavior.
- JavaScript `--regex` retains its separate `iu` full-body semantics but now rejects overly broad
  row/byte scans and runs in a worker with a deadline. It cannot be combined with Lucene mode.

### Fixed

- The help wording audit now compares options only for messengers eligible for their command. Telegram-only forum controls no longer fail because MAX has no corresponding command; missing options on commands both support remain checked.

- Truncated `chats events` reads now advise adjusting `--since-time` without claiming that the newest events were returned. Providers may return the oldest available events first, so the old warning misled max-cli's group-read migration about which part of history was missing. The parity manifest temporarily accepts MAX's legacy event flags while its consumer PR replaces them with the shared options.

- The parity manifest now marks `bot me` present in both CLIs after Telegram adopted the shared identity command.

## 0.126.0 — 03.10.2026

Released early: tg-cli forum setup needs the guarded enable and creation commands

### Added

- `topics enable --upgrade` explicitly upgrades a basic group and enables forum topics; staged errors retain the new chat id. `topics create` creates a named topic with an attempt id. Reusing a sent, unknown or reserved creation id is refused by the profile journal; an unknown creation must never be repeated. CLI and MCP use the same permissions, preflight and metadata-only journal; enabling defaults to confirmation. No implicit group upgrade occurs when sending or creating a topic.


## 0.125.0 — 03.10.2026

Released early: tg-cli needs the shared bot identity command and MCP tool

### Added

- An opt-in shared `bot me` reads the bot profile's identity and offers the matching MCP tool.
  It refuses offline reads and closes its connection on every exit path; existing consumer commands migrate explicitly.


## 0.124.0 — 03.10.2026

Released early: max-cli release needs the corrected embedding status estimate and worker guidance

### Fixed

- `conversations embed status` uses the measured e5-small speed of 31 chunks/s instead of 15,
  bringing its estimate closer to the 100k-message run on a Ryzen AI 9 HX 470. Estimates still
  depend on hardware and input length. Worker guidance now states the measured 1.04–1.1× gain
  for three workers and its memory cost, instead of comparing against a slower research baseline.

## 0.123.0 — 03.10.2026

### Fixed

- A truncated `runs list` now suggests increasing `--limit`, instead of the unsupported
  `--page` option. The JSON envelope still reports `hasMore`; listing records creates no new run.


## 0.122.0 — 03.10.2026

Released early: max-cli shared runner adoption needs its existing settings resolver and correct failure scope

### Added

- The shared runner accepts a settings resolver exposing only the four fields it reads, so
  consumers can use their existing configuration without implementing an unrelated facade.

### Fixed

- An unknown subcommand below a known resource no longer blames the leading profile name.
- Fallback recording for early bot command failures reads the bot settings instead of the
  personal account settings. Profile and failed-run retention choices now apply to the correct scope.

## 0.121.0 — 03.10.2026

Released early: tg-cli onboarding documentation needs the checker to accept command help

### Fixed

- The parity manifest no longer permits max's retired `cache` command subtree. Max now uses the
  shared store; `store clear --left` handles departed chats and a whole-store wipe is not offered.

- Documentation parity checks accept Commander's implicit `--help` for commands and profiles.
  User pages can point to a command's help without inventing a manifest option; other unknown
  flags are still refused.

## 0.120.0 — 03.10.2026

Released early: tg-cli guided setup needs cancellable credential prompts and the setup command manifest

### Added

- `readSecret` accepts an optional `AbortSignal`: an expired command can cancel a pending
  terminal prompt or piped input without ending the caller's stream. The parity manifest plans
  guided `setup` commands and their options for Telegram and MAX.

## 0.119.0 — 03.10.2026

Released early: tg-cli forum topic addressing requires the shared thread validation contract

### Added

- `messages send` and `polls create` accept `--topic` (MCP: `topic`) for a forum topic. Reply, media and scheduled sends preserve its address. Providers without topic support refuse the option before sending. Thread ids are recorded without message text.

## 0.118.0 — 03.10.2026

Released early: max-cli shared runner migration needs ProgramDefinition lifecycle hooks

### Added

- `ProgramDefinition` accepts optional `configure`, `prepare` and `onFailure` hooks. Consumers
  can add root options, inject legacy command context and settle their own failed run while
  sharing parsing and error reporting. Help/version skip failure settlement; a failed handler
  preserves the original command error. Existing definitions need no changes.

## 0.117.0 — 03.10.2026

Released early: max-cli completion needs the existing local account binding for MCP-only profiles

### Added

- `completeCommand` accepts `options.account` to read a consumer's existing local account
  binding. When supplied it is authoritative, so a stale shared profile pointer cannot offer
  another account's suggestions. It does not connect or create state. This unblocks max-cli
  completion for profiles used only through its legacy MCP server.

## 0.116.0 — 03.10.2026

Released early: max-cli shared completion and doctor need local completion sources and the store summary export

### Added

- `completeCommand` accepts optional local completion sources so a consumer can keep a bot's
  registry separate from a personal account. Its configuration needs only `configuredProfiles`.
  `storeSummary` is exported from `./cli` for consumers that retain their own doctor command.

### Fixed

- Contact completion uses account-scoped stored people and `partnerOf` for dialog fallbacks.
  A dialog id is no longer offered as a person's id when the provider distinguishes the two.
  These exports unblock max-cli's shared completion and doctor migration.

## 0.115.0 — 03.10.2026

Released early: max-cli MCP migration needs the public stored adapter wrapper to keep shared archive writes

### Added

- **`stored` and `Saving` in the CLI export** let a consumer retaining its own MCP tool names wrap its adapter with the same archive writes and failure handling as shared commands. The caller owns the store handle and closes it after the call.

### Fixed

- Keep `mcp setup` and `mcp doctor` planned in the parity manifest until the consuming CLIs adopt them.

- The parity manifest now marks `bot store fetch` and its shared options present in both CLIs.
  Telegram alone takes `--from <link>` to start from a known message number.

## 0.114.0 — 03.10.2026

Released early: max-cli needs shared inbox/review migration and correct unheard voice completeness

### Fixed

- A review with voice messages that have no transcript reports `complete: false` and lists `unheard`, including when transcription was not requested. Transcription failures also appear as `transcribeProblem` in JSON, so a caller can distinguish them from a fully read conversation.
- The parity manifest permits max-cli to remove its old inbox/review `--since` options and `cache` command while moving onto the shared commands and store. This unblocks the consumer migration without requiring a simultaneous release.

## 0.113.0 — 03.10.2026

Released early: tg-cli and max-cli cannot install local MCP setup until cli-messaging 0.113.0 is published

### Added

- **`mcp setup codex|claude-code` and `mcp doctor`** register a messenger's local MCP server in
  the chosen client and check its handshake and tool list. Setup refuses an existing client entry;
  doctor reads no messages and does not verify the messenger login. Each consuming CLI needs the
  new `@leemour/cli-core/mcp` export.

## 0.112.0 — 03.10.2026

Released early: tg-cli is waiting for the stored evidence command and MCP tool; owner requested immediate publication

### Added

- **Stored chat evidence through CLI and MCP:** the shared `messages evidence <chat>` and
  `<cli>_messages_evidence` read only the profile's local archive, returning newest-first packets
  with source locators, coverage and an older-page cursor. The packet keeps whole messages within
  64 KiB of JSON items; `--limit` accepts 1–100. Both use the exported `readEvidencePacket` service,
  without connecting or marking read. Consumers gain these entry points when adopting the release.
- **`prepareEvidencePacket` from `./services`** builds a versioned evidence packet from an already
  authorised message page for chat briefs, news or person context. It preserves order, includes
  source locators and content fingerprints, bounds the message count and serialized content bytes,
  and reports omitted messages and upstream paging without claiming complete history.

## 0.111.0 — 02.10.2026

Released early: tg-cli waits on history connection options for bot store fetch; both CLIs wait on working bot permission hints

### Added

- **Bot fetch can open a history-only reader**, passing an optional starting link, the pause and
  the stop signal. A messenger can expose `--from` through `fetching.from`; other bot commands
  stay on their normal transport. Connections can be tracked before login so a timeout closes them.

### Fixed

- **`bot store fetch` closes its adapter on success and failure.** This matters for a bot history
  reader that holds a socket: the command must print its result and exit.
- **A bot permission refusal names a working `config set --bot` command.** A caller can provide its
  own fix through `BotMessenger.permissionFix`; the personal guard's default hint is unchanged.

### Changed — may break callers

- **The parity manifest checks `bot store fetch` in max-cli** (#329); tg-cli's is planned, since a Telegram
  bot has no history call yet. `bot contacts show --refresh` is checked in both again.

## 0.110.0 — 02.10.2026

### Fixed

- **The MCP server lets go of the search model on Bun too**: the model it keeps between searches now runs in a
  child process of its own, on Node and Bun, which ends after 10 minutes without a search. The server stays
  near its starting size, 52–64 MB, across reloads; before, Bun held ~1 GB for the server's life and Node
  ~0.2 GB after each unload. A first search after a pause starts the model again, ~1 s.

## 0.109.0 — 02.10.2026

Released early: max-cli waits on the shared bot store fetch command

### Added

- **`bot store fetch <chat>`**: a chat's history into the bot's local copy, newest first, resumable —
  the personal `store fetch` for a bot, with `--limit`, `--page-size`, `--pause`, `--since-time` and
  `--last`. Mounted for a messenger that sets `BotMessenger.fetching` and pages back through
  `BotAdapter.historyBefore`.
- **`fetchInto`** (`src/services/archive.ts`): the fetch loop over any history and store; the personal
  service runs on it unchanged.

### Changed — may break callers

- **The parity manifest marks `bot contacts show` and `bot messages search|between` as in all CLIs**,
  every option checked, and drops max-cli's old `bot people show`: max-cli (#328) and tg-cli (#220) run
  the shared ones. `--refresh` is checked once both take the release whose help says "from the
  messenger" for it, not the messenger's name.

### Fixed

- **`bot contacts show --refresh` says the same in every CLI**, as the wording rule asks.

## 0.108.0 — 02.10.2026

Released early: max-cli and tg-cli wait on the shared bot contacts show and the fix for moderation after a form

### Added

- **`bot contacts show`, `bot messages search` and `bot messages between`, shared** (max-cli's
  `bot people show` and its copy reads): one person, a word search, and what several people wrote,
  all from the local copy; `--all-bots` and `--bots` reach the copies `readOtherBots` allows. MCP tools
  `<cli>_bot_contacts_show`, `_messages_search`, `_messages_between`. `BotMessenger.chatKindOf` says
  which stored chat is a dialog; without it a positive id is one. `--refresh` is refused by a bot that
  cannot read a chat back.
- **The MCP server lets go of the search model after 10 minutes without a search** (Node): the model
  runs in a worker thread of its own, and ending it gives back ~0.8 of ~1 GB; the next search loads it
  again, ~1 s. On Bun the model stays loaded: measured there, every unload and reload left the process
  0.2–0.55 GB larger.

### Fixed

- **MCP `<cli>_bot_chats_moderate` does what the accepted form showed when the profile puts
  `bot.chats.moderate` at `ask`**: the actions were refused, since the run after the form was not
  given `--yes`. A CLI's own tool gets that flag as `answerFlags` on the kit.

### Changed — may break callers

- **The parity manifest stops checking max-cli's own `bot people show`**: max-cli replaces it with the
  shared `bot contacts show`; the row goes once max-cli has moved.

- **The parity manifest marks `bot chats moderate` and `bot chats rules` as in all CLIs**, every option
  checked, and drops max-cli's old `bot chats check`: max-cli (#327) and tg-cli (#219) both run the
  shared ones.

## 0.107.0 — 02.10.2026

Released early: max-cli cannot drop its own bot chats check until the manifest stops checking it

### Changed — may break callers

- **The parity manifest stops checking max-cli's own `bot chats check`**: max-cli replaces it with the
  shared `bot chats moderate`; the row goes once max-cli has moved.

## 0.106.0 — 02.10.2026

Released early: max-cli and tg-cli wait on the shared bot chats moderate command to drop their own copies

### Added

- **`bot chats moderate` and `bot chats rules show|set|unset`, shared**: the bot's twins of the personal
  `chats moderate|rules`. A bot judges what its messenger gives back (`BotAdapter.historySince`), or else
  what its local copy kept, and the joins its messenger kept (`BotMessenger.joinsSince`). Rules live in
  the file the personal profile of the same name uses; the saved point beside the bot's state
  (`botFiles(...).checks`), where max-cli keeps them. Removal bans unless `--no-ban`. MCP:
  `<cli>_bot_chats_moderate`, one form for the actions the rules put at `ask`.
- **`moderateWith`** (`src/moderation/run.ts`): the moderation engine, taking what to gather and how to
  act instead of `ServiceDeps`, so a bot uses it without the services. The personal service runs on it.

## 0.105.0 — 02.10.2026

### Fixed

- **`bot mcp`'s warning for `--allow-send`, `--allow-delete` and `--allow-moderate` names no command
  that a CLI lacks**: it pointed at `config show permissions`, which max-cli does not have.
- **A CLI's own bot MCP tool is told when the owner must see the call first** (`confirmFirst` on the
  kit), under `--confirm-send` or level `ask`; until now only the shared tools put a form first.

### Changed — may break callers

- **The parity manifest marks `models text` as in all CLIs**, with `list`, `download --accept-terms` and
  `key set|remove`: max-cli now mounts the shared `text` group in its `models` group.
- **The parity manifest marks the global `--yes` as in all CLIs**: max-cli has it since its bot MCP
  moved to 0.104.0.
- **The parity manifest marks `bot mcp` and `bot mcp config` as in all CLIs**, every option checked:
  max-cli and tg-cli both mount the shared server on 0.104.0.

## 0.104.0 — 02.10.2026

### Added

- **`bot mcp`, shared** (`botMcpCommand`, `createBotServer`): a bot's MCP server, mounted when the CLI hands in
  its `run` on `BotMessenger.mcp`. Each tool runs the bot command in-process with `--json`; the CLI adds its own
  tools for the commands that are still its own. `bot mcp config` prints the entry for it.
- **`conversations search` names the chats it could not see**: a chat embedded only with another model is
  listed on stderr, and as `embeddedOnlyElsewhere` in `--json` and in MCP `conversations_search`, instead
  of being left out silently.
- **MCP `conversations_search` loads the model once per server**, not once per call (~1 s each with
  e5-small), and releases it when the server stops. Vectors are still read from the store on every call,
  so a chat embedded while the server runs is found at once.

### Changed — may break callers

- **`bot mcp` offers tools by the profile's permission levels**, under `bot.`, as the personal `mcp` does:
  `deny` hides a tool, `readonly` hides the writes, `ask` puts a form first unless the server was started with
  `--yes` (or `--allow-dangerous` for a deletion). With no flags the server now offers every write the levels
  allow; `bot: readonly` in the profile gives the old reads-only server. `--allow-send`, `--allow-delete` and
  `--allow-moderate` are accepted with a warning and decide nothing.
- **The parity manifest marks `bot watch`, `bot callbacks`, `bot commands` and `bot webhooks` as in all
  CLIs**, and drops `bot updates watch`: max-cli and tg-cli both run the shared ones. The note on
  `--check` goes; `bot list --check` reads the same in both.
- **The parity manifest marks `conversations embed` (with `embed status` and `embed clear`) and
  `conversations search` as in all CLIs**, with every option checked: max-cli and tg-cli are both on
  0.103.0. `models text` is in tg only: max still mounts its own `models` group, which has `audio` only.
- **`conversations search` and MCP `conversations_search` rank by meaning and by words together**: the
  query's words are also looked up in the word index, and the two lists are merged by reciprocal rank
  fusion. A conversation found by words alone has `score: null` (the score stays the meaning's cosine),
  and every item says `by`: `meaning`, `words` or both. A built chat that was never embedded is now found
  by its words.

### Fixed

- **`conversations search` is faster on a large store**: at 100k messages a search in a running MCP
  server went from 1.4 s to 0.35 s, and a one-shot search from 2.7 s to 1.4 s. The vector scan
  no longer sorts every vector of the model for each 5,000-row step.

## 0.103.0 — 02.10.2026

Released early: max-cli 0.22.0 waits: its parity check fails on the new conversations embed and search options until the checker fix ships

### Fixed

- **The parity check leaves the options of a command still planned for a CLI unchecked**, as it leaves
  the command: a CLI that mounts a planned group early — `conversations embed` and `conversations search`
  with their new options — passes until the rows say it has them.

## 0.102.0 — 02.10.2026

Released early: tg-cli cannot move past 0.99.0: its archive tests hang in store fetch on 0.100.0 and 0.101.0

### Fixed

- **`store fetch` ends when the messenger keeps giving back the same page.** Since 0.100.0 a message
  read twice no longer counts towards `--limit`, so a messenger that ignored the page boundary and kept
  answering with messages already read made the run go on for ever. A page with nothing new now ends it
  — at once when paging by id, after the step past a crowded millisecond when paging by time.

## 0.101.0 — 02.10.2026

### Added

- **`in:personal` and `in:bots`** in `messages search` (and `--source`, MCP `source`): every personal
  account held in the store, or every bot's copy; `in:all` is both, as before. A bot's account is one
  whose provider ends in `-bot`, and the shared bot commands now refuse a `BotMessenger.provider` that
  does not — the owner's call.
- **An external embedding model with your own key** (storage phase 5): `conversations embed`, `embed
  status`, `embed clear` and `conversations search` take `--provider openai` (`text-embedding-3-small` by
  default, `--dims` to shorten) or `--base-url <url>` with `--model` and `--dims` for any server with
  OpenAI's `/v1/embeddings` — Gemini's compatibility URL, Jina, or Ollama and LM Studio on this machine.
  Before chat text leaves the machine, `embed` says how many chunks, at most how many tokens and at most
  what price, and waits for a yes; machine mode needs `--yes`, and `--max-tokens` stops a larger run. A
  server on this machine is not asked about. Requests go 256 texts at a time, `--concurrency` (4) at once;
  a 429 waits for `Retry-After`. Errors name the HTTP status and the provider's code, never the text or
  the key. `models text key set|remove <provider>` keeps the key in the keyring (or
  `<PREFIX>_OPENAI_API_KEY`, then `OPENAI_API_KEY`), read from a hidden prompt or stdin.

### Changed — may break callers

- **The parity manifest marks `messages search --newest`, `--context` and `--source` as in all CLIs**:
  tg-cli and max-cli are both on 0.99.0, which has them.

### Fixed

- **`conversations embed status --chat` and `embed clear --chat` work**: they refused every call with
  "required option '--chat <chat>' not specified", because the `embed` group, which declares the same
  option, took its value. The parity manifest lists `embed`'s own options, planned like the group, so
  a CLI on this release passes its check.
- **`contacts list` names a dialog's person by `Messenger.partnerOf`** when it falls back to the dialogs (no
  contacts stored yet). A messenger that sets `partnerOf` gets the person's id, not the chat's, and a dialog
  whose person it cannot name is left out; without `partnerOf` a dialog's id stays the person's, as on
  Telegram. On MAX the chat's id was listed as a person's.

## 0.100.0 — 02.10.2026

Released early: max-cli 0.22.0 waits on the store fetch fix for messages at a page boundary

### Added

- **`conversations search "<query>" [--chat] [--model] [--since-time] [--limit]`** and MCP
  `conversations_search` (storage phase 5): the conversations nearest in meaning to a query, best first,
  in one chat or every chat embedded with the model — each with the chunk that matched and a score.
  The query is embedded on this machine; the chunks are scanned 5,000 at a time, so memory stays bounded
  at any size. A one-shot search loads the model each time (about a second). It reads as `messages`.
- **`conversations embed --chat <chat> [--model] [--workers <n>] [--threads <n>]`**, `conversations embed
  status` and `conversations embed clear` (storage phase 5): a vector for each chunk of the chat's
  current build, computed on this machine with a model from `models text`, a batch at a time; stopping
  loses at most one batch, and running it again goes on. One session uses `min(8, cores)` threads;
  `--workers` runs several, each with its own copy of the model, and refuses a count that does not fit in
  free memory. A chunk whose messages changed since the build is skipped and counted. Keyed
  `conversations.embed`, so a profile read-only on messages can still embed. `store check` reports
  vectors per model and those no chunk points at any more; its "nothing is enriched yet" note is gone.
- **The parity manifest plans `bot messages search --newest`** for max (phase 2 item 10b: the bot's
  search by words, best first) and for tg (P8).
- **Chunks of conversations in the store (store version 14)**, for search by meaning (storage phase 5):
  `conversations build` cuts each conversation into chunks of at most 1,200 characters at message
  boundaries and stores, per chunk, its first and last message and the sha256 of its text — never the
  text. `chunk_vectors` holds one model's vector per chunk text, so a rebuild that leaves a
  conversation's text alone reuses it; `conversations embed` fills it. `min_compatible` stays 6: older
  builds keep reading and writing the file.

### Fixed

- **`store fetch` by send time no longer skips a message at a page boundary.** Where a messenger pages by
  time (MAX), two messages sent in the same millisecond could fall on either side of a page, and the
  older one was never asked for. Each page now reaches back into the millisecond the previous one ended
  at; ids already read are not counted twice in `fetched`. Only a millisecond holding more than a whole
  page is stepped past.

## 0.99.0 — 02.10.2026

Released early: tg-cli and max-cli cannot move to the breaking release, and three sessions wait on it; the owner asked to release now

### Added

- **`searchStore(store, account, query)`** (`./services`): `messages search` over a store, for a caller
  with no `Messenger` — a bot's search. `SearchQuery.accounts` reads accounts the caller has already
  checked instead of the one it runs as, and refuses `in:` and `source` beside them;
  `SearchQuery.senders` keeps any of several people, and refuses `from:` beside them. `SearchFound`
  and `FoundMessage` are exported.
- **`models text list|download`**: the embedding models search by meaning will use (storage phase 5),
  downloaded once into the shared models folder (`~/.cache/cli-common/models/text/`), each file pinned to a
  commit and checked by sha256. `e5-small` (MIT, 135 MB) is the default; `embeddinggemma` (219 MB) comes
  under Google's Gemma terms and downloads only with `--accept-terms`. A download loads the model once to
  check it works. They run through `@leemour/cli-messaging-onnx`, ONNX Runtime's WebAssembly build for
  Node and Bun in 15 MB — a new dependency, with `@huggingface/tokenizers`.
- **`bot watch`, `bot callbacks answer`, `bot commands list|set|clear`, `bot webhooks list|set|delete`**,
  the shared commands over four new optional groups on `BotAdapter`: `BotUpdates`, `BotCallbacks`,
  `BotMenu`, `BotWebhooks`. `bot watch` has the personal `watch`'s shape (`--events`, `--jsonl`, Ctrl-C
  or `--timeout` end it normally) plus `--types`; it keeps each batch — messages in the bot's copy,
  button presses for `callbacks answer --text`, and what `BotMessenger.keepUpdates` keeps — before it
  prints it, and moves its cursor only after. The cursor is `<bots>/updates/<profile>.json`, the file
  max-cli writes. It reads, under `bot.messages`. `bot webhooks set` refuses a second address unless
  `BotMessenger.manyWebhooks` and `--add`.
- **`messages search` across accounts and messengers.** `in:telegram`, `in:max` (any messenger the
  store holds) and `in:all` in the query, or `--source <messenger|all>`, search every account of it
  kept in the shared file; the default stays the account the command runs as. Both given and
  different is an error. `chat:` and `from:` resolve inside the chosen accounts, and a name found in
  two of them lists the candidates with their messenger. Context and completeness come from each hit's
  own account; each `completeness` row now names its `provider` and `account`. Pretty output names the
  messenger before the chat title when the hits span accounts, and says another messenger's hit opens
  in that messenger's CLI by its locator. MCP `messages_search` takes `source`. `--regex` stays on the
  account it runs as. `MessageStore.accounts()` lists the accounts the file holds.
- **`BotNotice` for people coming and going has an optional `at`**, when it happened: `bot watch` may take
  an update long after, and a CLI that keeps joins needs the time it happened.
- **`bot webhooks set --secret-stdin` asks for the secret only after the profile's permissions allow
  setting a webhook**; a read-only bot profile is refused without the prompt.
- **The parity manifest plans `bot watch` for both CLIs**, and `bot updates watch` going from max, so each
  CLI's check passes before and after its move to this release; the rows go to all CLIs once both moved.

### Changed — may break callers

- **`messages search` searches by words, best match first** — it listed the newest first: take
  `--newest` for that order. In a query, `"a phrase"`, a leading `-`, `OR` and the filters `from:`
  (a name, @username, or `me`), `chat:`, `after:`/`before:` (a day or `7d`) and `has:` (an attachment
  kind, `attachment`, `link`) now mean something; a query of one or two letters is searched rather
  than refused. A typo is corrected and said on stderr; no message with every word falls back to any
  word, then to a piece of a word. `--context <n>` shows messages around each hit (2 in the terminal).
  The JSON keeps `items`, `limit` and `hasMore`, and adds `match` and `score` (higher is better) to
  each hit, `corrections`, `completeness` (per chat: held in full or not) and `wordsReady`. The MCP
  tool `messages_search` takes the same query, `newest` and `context`. `in:` searches other accounts
  (under Added).

- **The parity manifest checks the `bot` commands**, a row each, in place of one planned row. What max
  and tg both have is in all CLIs. `bot api`, `bot comments`, `bot uploads`, `bot chats members
  list|add` and `bot webhooks set --add` are max's alone, each with why. The rest is planned for tg
  in P8. The standard's README order no longer says the bot section is max's only.
- **`bot list --check`** says "ask the messenger who each bot is, with its token" in every CLI, so the
  option reads the same in max and tg.

This is the weekly breaking release. tg-cli and max-cli move to it the same day.

- **`chats`, `history`, `around` and `contact` leave `MessengerCore` for a new optional group,
  `ServerReads`.** `MessengerAdapter` extends `Partial<ServerReads>`. A messenger with
  `history: "store"` leaves the group out: the services answer those reads from the store. Every
  shared caller reaches them through `capability()`, so a `"server"` messenger whose adapter lacks one
  is refused with "this messenger cannot list chats" (or "read a chat's history", "read the messages
  around one", "show a person"). `InboxReader` is now `Pick<ServerReads, "chats" | "history">` plus
  `resolve` and `admins`. In `./testing`, `fakeAdapter` has the group, `OPTIONAL_METHODS` lists its
  four methods, the cases that read through it are skipped together when any of the four is missing,
  and `contractCases` takes `history` (default `"server"`): with `"server"`, one case fails unless the
  adapter has all four.
- **`Capabilities` is removed** from `.`. Nothing read it; the optional groups say what a messenger
  can do, and `Messenger.history` says where its history is read from.
- **A deletion that names no chat tombstones nothing unless the messenger gives a rule.** The
  built-in rule — ids that count per account, no channel, no `-100…` chat known only by its id, no
  Telegram chat type that numbers its own messages — is gone from `markDeleted`. A consumer that
  relied on it sets `Messenger.deletedWithoutChat`, or passes `among` to `markDeleted`.
- The built-in invite link patterns in `chats moderate` stay for now; `Messenger.inviteLinks` adds to
  them.

What to change in a consumer:

- **tg-cli:** delete `TELEGRAM_CAPABILITIES` and its `Capabilities` import from `src/telegram/map.ts`
  (the build fails on it). Set `deletedWithoutChat` on the `Messenger` with the `-100` and chat-type
  rule (tg-cli #212), or a deletion that names no chat is no longer applied to the store. The adapter
  already has the four reads.
- **max-cli:** add `ServerReads` to the `MaxAdapter` type in `src/adapter/max-adapter.ts`
  (`MessengerAdapter & ServerReads & MessageEditing & …`); `src/adapter/max-adapter.test.ts` calls
  `adapter.history` and no longer type-checks without it. The adapter already has the four reads.
- **Any adapter typed as `MessengerAdapter`** that calls one of the four directly: type it as
  `MessengerAdapter & ServerReads`, or go through `capability()`.

### Fixed

- **A search in a chat ranks the same whatever the chat's size.** A chat of up to the limit below is
  filtered inside the word index by a token, and that token counted in bm25, so the order of hits
  depended on the chat's size. The scope column now weighs nothing in the rank.
- **A chat or a sender of up to 100,000 messages is filtered inside the word index** (was under
  20,000), set by the benchmark through the store (phase 2 item 8): faster for every chat measured up
  to 85k messages. `bench/search/store-chain.ts` times the search's steps, typo correction's precision
  with look-alike words, the token against the join, and the fill.
- **`contractCases`**: the case for `resolve` with a chat id nobody has now also accepts a chat of kind
  `unknown` with that id and no title, besides `not_found`. max-cli takes an id without connecting, so a
  write its guard refuses never logs in first.

## 0.98.0 — 01.10.2026

Released early: tg-cli and max-cli: their command pages label config set, chats rules set and the recipient lists as changing the messenger; the fix (#360) needs this release, and the owner approved releasing it early

### Added

- **`bot chats admins list|add|remove`** and **`bot chats members remove [--block]`**, the shared commands
  over two new optional groups on `BotAdapter`: `BotChatAdmins` (`admins`, `addAdmin` with an optional
  title, `removeAdmin`) and `BotChatMembers` (`removeMember`). `--can` takes the personal account's
  rights; `BotMessenger.adminRights` narrows them to what the messenger has. A person is their user id.
  Keys `bot.chats.admins.*` and `bot.chats.members.remove`.
- **`search(store, query, scope)`** (`src/search/search.ts`) runs the word search in order — every word
  topped up by word beginnings, typo correction, any word, substring — and says which step found each
  hit and what it corrected. `MessageStore` gains `matchFilters` (a search of filters alone, newest
  first) and `chatCompleteness` (per chat: up to date, gaps, reaches its start, or `unknown` when never
  fetched). `store fetch` records when it reaches a chat's first message. `messages search` does not
  use it yet.
- **`BotPeople.senders()`**, optional on `BotAdapter`: who wrote the messages the adapter decoded,
  with their handle and whether each is a bot. The bot's message commands keep them in its copy, so
  `@username` finds a person in what the bot read.
- **`./testing`, the adapter kit** — not on the stable list yet. `fakeAdapter(seed)` is a messenger in
  memory with every method group, for command tests. `contractCases({ connect, ids, orderBy })` gives
  the port's promises as named cases that any test runner can run over an adapter: history oldest
  first and paging back to the end, the `around` window and its anchor, an ambiguous title refused,
  a send answering its send id and a repeat leaving one message, ids as strings, reads changing
  nothing, `capability()` refusing what an adapter lacks. `contractSeed` is the data they read.
  [`docs/dev/ADAPTERS.md`](docs/dev/ADAPTERS.md) is the guide for writing an adapter.
- **`Messenger.history: "store"`**, for a messenger that pushes its history instead of answering for
  it: `chats list|show`, `messages list|context` and `contacts list|show` answer from the local store
  and never connect, and writes still connect. A chat with nothing stored answers `not_found` with
  "nothing stored for this chat yet — keep `<cli> serve` running"; an empty profile says to run
  `<cli> serve` or `<cli> watch` once; a read warns on stderr when no `serve` holds the profile, with
  the time of the newest stored message. `store fetch`, `--estimate`, `--after-*` and
  `--before-time` refuse in this mode for now. The MCP chat resource reads the store too.
  `ServiceDeps.reads` carries the mode. Unset, nothing changes.
- **`inbox` and `review` in store mode** (`Messenger.history: "store"`): unread from the stored chats'
  counts, `--new`, `--since-time` and `review` from the stored messages by time — a chat counts as
  changed by its newest stored message. The same `--json` as online; the store knows no admins, so
  `review --unanswered` counts only the owner as answering. They never connect. `unreadIn`, `newIn`
  and `reviewIn` take an `InboxReader`, the four adapter methods they use.
- **MCP tools read the store in store mode**: `chats_list|show`, `messages_list|context`,
  `contacts_list|show`, `inbox` and `review` answer from it as their commands do, and never connect;
  writes and `transcribe` still go through the session's connection.
- **`PushedHistory`**, a new optional group on `MessengerAdapter`, for a messenger with
  `history: "store"`: `feed(onBatch, signal)` hands over chats, people and past messages as the
  messenger pushes them, as `HistoryBatch` objects. `serve` and `watch` run it beside `watch` and save
  each batch to the store — chats without marking the others as left, messages as history. A batch
  the store cannot take is a warning; a `feed` that fails stops the command. `fakeAdapter(seed,
  { feed: true })` pushes the seed, and `contractCases` has a case for `feed`, skipped without it.
- **`MessagesService.download(chat, message)`**: one message's files, from the messenger whatever its
  history is read from. `messages download --all` uses it.
- **`Capabilities` is deprecated**: nothing reads it. A later breaking release removes it.
- **`Messenger.deletedWithoutChat`**: which stored chats a deletion that names no chat may hit. `watch`
  passes it to the store as `markDeleted(…, { among })`, the new option of the same rule: the store
  tombstones a message only when exactly one live message with that id is left in the chats the rule
  accepts. A messenger that leaves it unset keeps Telegram's built-in rule for now; a later breaking
  release removes that rule, and then no rule means no tombstone without a chat.
- **`Messenger.inviteLinks`**: a messenger's own invite links, which `chats moderate` judges under
  `invites` beside the built-in Telegram and MAX ones; `judge` takes them as `invites`. The built-in
  patterns stay until tg-cli and max-cli set the field; a later breaking release removes them.
- **The search query's `in:` takes any messenger the store holds**, plus `all`: `parseQuery` is given
  the store's providers instead of a fixed `telegram`/`max` list.
- **A third CLI can join the parity manifest:** `pnpm parity:seed --cli <name>` adds it to the
  manifest's new `clis` list and plans every command and option for it, so its first parity check
  passes and every gap stays listed. `cli-messaging-parity <cli>` accepts any CLI the manifest lists.

### Changed — may break callers

- **The parity manifest marks `conversations` and `messages links` as in all CLIs**, with a row per
  subcommand: max mounts them since max-cli #308. `conversations links add|clear` wait for tg's move to
  0.97.0.
- **The parity manifest marks max's whole `store` group as in both tools** — `status`, `jobs`, `clear`,
  `info`, `check`, `migrate`, `backup`, `restore`, `fetch --background|--limit|--page-size|--since-time`,
  `export --since-time` — and drops `store fetch|export --since` and `--max-pages`: max's main moved onto the
  shared group (max-cli #307). A max older than that fails this manifest's parity check. `store reindex`
  stays planned until tg moves to 0.97.0; `--page-size`'s default differs by messenger, as its note says.
- **`parity.json` lists, for each command and option, the CLIs that have it** — `{ "in": "all" }`,
  `{ "in": ["max"], "reason": … }`, `{ "in": [], "planned": { "max": "T6", "tg": "T6" } }` — instead
  of `both`, `max-only`, `tg-only` and `planned`. Every planned row is now planned for both CLIs
  with its old `by`, so max and tg pass or fail exactly as before; a difference says "the manifest
  says all" where it said "both". `cli-messaging-parity` keeps its arguments, so `parity:check` does
  not change. In `./parity`: `Cli` is a string, `Entry` and `CommandRow` take the new shape,
  `wordingProblems(manifest, programs)` takes a list of programs known by their `cli`, and the audit's
  `AuditInput` takes `sides` by CLI name. What to change: nothing, unless you import `./parity`.

### Fixed

- **Commands that change only this computer no longer say they change the messenger.** `config set`
  and `unset`, `chats rules set` and `unset`, `recipients add`, `remove` and `clear`, and the bot's
  `auth set`, `auth remove` and `recipients add`, `remove` and `clear` are marked `local` (cli-core
  0.15.0), so the commands page gives them their own line. They are still writes: `commands --json`
  shows `writes: yes`. `chats moderate` still says it changes the messenger.
- **`messages download --all` works where message ids are not whole numbers.** It refused them, because
  its resume file compared ids as numbers — so it refused MAX, whose ids pass 2^53, and any messenger
  with ids made of letters. Where the messenger sets `fetching.orderBy: "time"`, it now keys by send
  time, as `store fetch` does, and pages back from an ISO time, as the adapter contract says. Messages
  that share a moment with a page's oldest message or a stretch's end are not skipped and not
  downloaded twice. The resume file gains `"by": "id" | "time"` and, by time, the ids walked at each
  stretch's two ends; a file without `by` is read as by id, so tg's files
  still resume, and one keyed the other way is set aside with a note. `--all` pages through the
  messages service, so with `Messenger.history: "store"` it pages the local store and only the files
  come from the messenger.
- **`bot messages send` and `edit` journal the text's length**, as the personal account's do — never the text.
- **A write cut off by `--timeout` is an unknown outcome, not a timeout.** When the command's time ran
  out with a send, an edit or any other write still waiting for its answer, the error was `timeout`
  — which reads as "nothing happened" and invites a second copy — and the journal had no line for
  it. Now it is `outcome_unknown` ("check before repeating it", exit 14) with the write's
  `operationIds`, and the journal records each one as `outcome_unknown`. Reads still time out as
  before. Per command, so an MCP server's calls do not cut each other's writes.

## 0.97.0 — 01.10.2026

Released early: max-cli 6c (T6 store group): its parity check needs the store rows planned (#333)

### Added

- **The bot's messages and chats** (P8): `bot messages send|list|show|edit|delete|pin|unpin` and
  `bot chats show|leave|action`, under the personal account's names. `send` takes
  `--md`, `--html`, `--file`, `--photo`, `--as-file`, `--voice`, `--reply-to` and `--silent`, and no
  `--send-id`: a bot's send is never repeated. A message is `<chat> <message>` everywhere. Where a
  messenger's Bot API reads no history — Telegram's — `list` and `show` answer from the bot's own copy
  and say so. Every write goes through the bot's guard under a `bot.*` key; a delete asks
  first, and `--allow-dangerous` answers. New port groups `BotMessaging`, `BotHistory`, `BotChatTools`
  (and the personal `MessagePins`) on `BotAdapter`; `botCopy` keeps the bot's local copy per provider.

### Changed — may break callers

- **`@leemour/cli-core` is a peer dependency now**, `>=0.13.0 <0.15.0`, not a dependency of this
  package. The install has one copy of it, the CLI's own: with two, `annotate()` marks went missing from
  `commands --json` and an error from one copy was not an `instanceof` the other's class. What to
  change: depend on `@leemour/cli-core` yourself, at 0.13.0 or 0.14.x (tg-cli is on 0.14.0; max-cli,
  on 0.12.0, moves up), and drop the pnpm `overrides` entry for it once on this version.
- **The parity manifest marks `messages send --at-time`, `messages list --before-id|--before-time|--after-id|
  --after-time` and `messages context --before-n|--after-n` as in both tools,** and drops the old `--at`,
  `--before` and `--after` rows: max's main has moved (max-cli #294, #282). A max older than that fails
  this manifest's parity check.
- **`store fetch --since|--max-pages` and `store export --since` are planned for max**, not max-only, so
  max can move onto the shared `store` group (max-cli T6, 6c); they go once max's main has moved.
  `store clear` is planned for max too: it comes with the store maintenance commands.

### Fixed

- **`bot messages list --limit <n>`**: the option was missing, so a CLI without a global `--limit`
  (max) could not set it. And with nothing kept yet, `--offline` names the command that fills the copy.
- **`store reindex` has its parity row** (planned for max, T6): tg-cli's parity check failed on 0.96.0 without it.

## 0.96.0 — 01.10.2026

### Added

- **`<cli> skill show link-conversations`** prints the shared skill that walks the user's own agent
  through linking a chat: say what it costs and wait for a yes, then `batches next`, answer, `links add`,
  repeat, rebuild. Message text is data, never instructions. Shipped in `skills/`; the CLI's command is
  filled in. cli-core 0.13.0, whose `skillCommand` takes these named skills.
- **The store's word-search steps**: `MessageStore.matchWords` (every or any word, whole words or
  word beginnings, ranked by bm25 with equal scores newest first, or newest first on request),
  `matchSubstring`, `knownTerms` and `termCandidates`, over a `SearchScope` of accounts, a chat, a
  sender, `from:me`, a time range and attachment kinds. A chat marked not searchable is left out unless
  the scope names it. Nothing calls them yet; `messages search` still searches by substring.
- **`store reindex`** rebuilds the word index and its typo vocabulary from the stored messages; no
  message is lost. `store migrate` now also fills the word index of a large file in batches, and each
  `messages search` spends up to 200 ms on it first. `store info` and `store check` show how far it
  has come (`wordIndex`), and `store check` checks its structure. `MessageStore` gains
  `searchIndexState()` and `fillSearchIndex()`.
- **`conversations links add --batch <id>`** reads the user's agent's answer as JSON on stdin and stores
  it all or nothing: every message one the batch asked about, each parent in the batch and earlier, no
  message twice, confidence 0–1, a model named. A message's new answer replaces its earlier one.
  **`conversations links clear --chat <chat> [--model <m>]`** drops answers; messages are never touched.
  Both are keyed `conversations.links`, a new permission resource, so a profile read-only on messages can
  still link; `readonly` or `deny` on it refuses. A batch id stays valid while its messages are answered,
  and not once a message inside it is added or deleted.
- **Our own SQLite where the runtime's falls short.** Bun on macOS now always uses the SQLite of
  `@leemour/cli-messaging-sqlite` (3.53.4) instead of the system's, which on macOS 13 is too old for
  the message store. `ensureSqlite()` (`@leemour/cli-messaging/sqlite-runtime`), run first by a
  command, starts it again on that SQLite when a Linux distribution's Node brings one the store
  cannot use. On every other setup nothing changes.

### Fixed

- **`bot recipients`' help names `clear`**, the command that removes the list; it said `off`, which
  does not exist.

## 0.95.0 — 01.10.2026

### Fixed

- **max can move `messages list|context` onto the shared commands.** The parity manifest required max to
  keep `--before` and `--after` on both, so the move failed max's parity check; they are planned until
  max's main moves.

## 0.94.0 — 01.10.2026

### Added

- **`skill install [--for claude|agents|all]`** beside `skill show`, from cli-core's `skillCommand`:
  it writes SKILL.md, stamped with the CLI's version, to `~/.claude/skills/<appName>/` and
  `~/.agents/skills/<appName>/`. It refuses a SKILL.md whose frontmatter `name` is not the app name.
  `skillCommand(app, skillUrl)` keeps its signature.
- **A daily hint for agents.** `run()` prints one line on stderr when `AI_AGENT` or `CLAUDECODE` is set
  and no copy of the skill is installed, or an older one: `` `<cli> skill install` installs this
  tool's guide``. It shares the update notice's state file, never prints on stdout, after a failure
  or under `--quiet`, and the setting `skillHint: false` in the configuration's `defaults` turns it off.
- **`Messenger.skill`**: the CLI's SKILL.md. When set, the MCP server serves it as the resource
  `<command>://skill` and names it in its instructions.

### Changed — may break callers

- **Depends on `@leemour/cli-core` 0.11.0.** A CLI that uses this package moves to cli-core 0.11.0 in
  the same change, or pins one copy with a pnpm override.

- **`BotMessenger.connect(command, token, { stop, events })`** (P8): the bot client gets the run's
  events, so `bot auth show --trace` prints each request and the run record counts it. The third
  argument was `stop` alone; no CLI implements it yet.

### Fixed

- **`serve` and `watch` stopped by SIGTERM or Ctrl-C finish normally.** Telegram's library closes its
  storage on the signal and then sends it again; with the command's handler already spent, the second
  one ended the process at once — `serve` left its lock (`server status` said `stale`) and printed no
  result. The handler now stays until the run is over.
## 0.93.0 — 01.10.2026

### Added

- **The agent's answers decide conversations** (storage phase 4): `conversations build` reads the user's
  agent's current answer for each message and chooses the messenger's reply first, then the agent's
  answer, then the rules. An answer whose message or parent changed after it was written is left out.
  Rules version 4, so `store check` names the chats to rebuild.
- **`conversations batches status|next --chat <chat> [--size <n>]`** (storage phase 4): a chat in
  windows for the user's own AI agent to link — the messages it is asked about, which have no messenger
  reply and no current answer, and the 50 before them as context, with the rules' candidate links.
  `status` says how many messages, batches and characters are left, to tell the user before starting.
  Message text goes to stdout only, never into a run record. The CLI calls no model.

### Fixed

- **A development checkout's `server start` no longer drives the installed tool's unit.** The unit
  was named by profile alone, so a checkout with its own `*_STATE_DIR` or `MESSAGING_STORE` found
  the real `tg-serve-default.service` and started it. A unit written with location variables now
  carries a short hash of them in its name; one written without (the installed tool) keeps its name.

## 0.92.0 — 01.10.2026

### Added

- **The shared `bot` group** (P8): `botCommand(bot)` builds `bot auth set|show|remove`, `bot list
  [--check]`, `bot chats list`, `bot recipients list|add|remove|clear` and `bot sends list` over a
  `BotMessenger`; a CLI adds the commands that are still its own with `addCommand`. `botContext` hands
  a command the bot's settings, token, seen chats, recipient list and journal. `BotMessenger` gains
  `readSecret`, a seam for the token prompt.

### Changed — may break callers

- **Depends on `@leemour/cli-core` 0.10.0.** A CLI that uses this package moves to cli-core 0.10.0 in
  the same change, or pins one copy with a pnpm override: with two copies, a command marked as
  changing something (`annotate`) loses the mark in the other copy's `describeProgram`, and errors
  from one copy are not instances of the other's classes.
- **`chats folders list` answers `{ items, page, limit, hasMore }`** in `--json`, and so does the tool
  `chats_folders_list`; they printed a bare array.

### Fixed

- **max can upgrade past `--at`.** The parity manifest required max to still have `messages send --at`,
  so max's own parity check failed on any release with `--at-time`; both rows are planned until max's
  main moves.

## 0.91.0 — 01.10.2026

## 0.90.0 — 01.10.2026

### Added

- **`serverCommand(messenger, options)`** — a CLI whose server is not tg's lock file says how it is
  found, started and stopped (`options.process`: `probe`, `launch`, `stop`), where it logs, what a
  unit runs (`serveArgv`), `--idle` on `start`/`restart` (`idle: true`), and the unit's purpose and
  the exit codes that must not restart it (`unit.noRestartOn`: systemd's `RestartPreventExitStatus`;
  launchd then does not restart at all). `start` takes the place of a server a command started.

### Changed — may break callers

- **`server` says "connected", not "listening"**, in its lines and errors; `server start` also
  answers `startedAt` and `log`; `server stop` answers `by` as `status` does.

## 0.89.0 — 01.10.2026

### Added

- **A chat the account has left leaves the store's lists, and `store clear --left` deletes it.** A
  chat list that names every chat (offset 0, nothing more) marks the chats it leaves out with
  `membershipState: "left"`; `chats`, `countChats` and `chatsWith` skip them, their messages stay,
  and a chat the list names again is unmarked. `markChatsLeft` and `leftChats` on the store,
  `archive.left` on the services. `store clear --left --allow-dangerous` deletes this account's left
  chats with their messages, members and leases; without `--allow-dangerous` it says how much it
  would delete. No schema change: version 6's `membership_state` already holds `left`.
- **`cli-messaging-parity wording <max.json> <tg.json>`** and `wordingProblems` in `./parity`: every
  `both` option the two tools describe in different words, unless its catalogue entry has a `note`.
  The parity workflow runs it on both CLIs' `main`.
- **The store reads and writes conversations**: `linkInputs` pages a chat's messages oldest first for
  the rules, `replaceConversations` writes a chat's new build of links and conversations in short
  transactions and makes it current in one (the agent's links stay, marked stale when their message
  changed after them), and `conversations`, `conversation`, `conversationOf`, `links` and
  `conversationState` read them back.
- **`conversations build --chat <chat>`**, **`conversations list --chat <chat> [--since-time]`** and
  **`conversations show <id>`** (or `show <chat> <message>`): the conversations inside a group chat,
  found in the stored messages by replies, mentions and who wrote next; nothing is built until asked.
  **`messages links <chat> <message>`** says why a message is where it is. MCP: `conversations_list`,
  `conversations_show`. The commands are shared; tg and max get them when they mount
  `conversationsCommand`. A profile that denies `messages` is refused them too.
- **`store check` reports conversations**: per built chat, the rules version that built it, whether it
  is this build's, and how many of the agent's links went stale; a note names the chats to rebuild.
- **`Message.mentions`**: the people a message mentions by id, where the messenger marks them; the store
  keeps it and the mention rule follows it, so a mention by name with no `@handle` links too (rules v3).

### Changed — may break callers

- **`chat_messages_edit` takes `md`**, as `chat_messages_send` does; the option is `--md`.

## 0.88.0 — 01.10.2026

### Added

- **`chats rules show|set|unset` and `chats moderate`**, with the tools `chats_rules_show` and
  `chats_moderate` (P2, `chats check` in max-cli). A group's rules live in
  `<state>/profiles/<profile>.moderation.json` — max-cli's file, so its rules carry over, its
  `forbid`/`flag`/`confirm` read as `deny`/`ask`/`ask`, the profile's own levels. Each kind of action has a level:
  `deny` never acts, `readonly` reports, `ask` asks at the terminal (`--allow-dangerous` says yes;
  over MCP it is planned), `allow` acts. Its deletions and removals go through the guard as
  `chats.moderate`, so `messages.delete` does not ask again. Where the next run starts is kept in the
  same file. `GroupMember.registeredAt`; `Messenger.knowsAccountAge: false` refuses the `newAccount`
  rule. `judge`, `act` and `Moderator` are exported for a bot.
- The manifest says the contact writes and `account update|sessions end` are in both tools.
- **`@leemour/cli-messaging/background`** (P6): the lock per app and profile, `alive`/`carries`/
  `holdersOf`, the `ServerSystem` seam, and systemd and launchd units, moved out of the `serve` and
  `server` commands so max's server can use them too. The commands behave as before; `./cli` still
  exports `servingProfiles` and `ServerSystem`.
- **A test can hand in the local speech recognizer**: `recognizer` in the environment `run()` and
  `provide` take, used by `messages list --transcribe` and `messages transcribe` in place of the
  downloaded model.
- **Conversation tables in the store (store version 13)**: `message_links`, `conversations`,
  `conversation_messages` and `conversation_state`, empty until phase 3's `conversations build` fills
  them. Every foreign key cascades, so deleting messages or chats — by any build — takes their
  conversation rows with them. Each rebuild of a chat is written under its own build number and made
  current at once, so a big chat's rebuild never holds the write lock for long. `messages.mentions`
  keeps whom a message mentions by id, where the messenger says so.
- **A bot's pieces, for the shared bot commands** (P8): `BotTokenStore` (keyring account
  `bot:<profile>` under the app's own service, `<PREFIX>_BOT_TOKEN` first, then a 0600 file),
  `ChatRegistry` and `registryProfiles` (the chats a bot has seen, one 0600 file per bot),
  `botFiles` and `botsDirectory` (max-cli's paths, unchanged), and the types `BotMessenger` and
  `BotAdapter`. From `@leemour/cli-messaging/cli`.

- **A bot's settings** (P8): the file gains `personal` and `bot` sections, each with `defaults` and
  `profiles`; the most specific entry wins — this profile's bot entry, the profile, every bot,
  everyone. `resolveSettings(flags, { kind: "bot" })` reads them; `Settings` gains `kind` and
  `readOtherBots` (a bot setting: which other bots' local copy it may read). A bot has no hourly
  limit unless its section sets `sendsPerHour`. `config show --bot`, and `config set|unset --bot`
  or `--personal`, write into a section.
- **Bot permission keys**: `bot` is a resource, and every bot command is keyed under it —
  `bot.messages.send`, `bot.chats.members.remove`; `bot auth|list|recipients|sends|mcp` are never
  gated. `bot.messages.delete` asks by default. A bot's old `readOnly` and `allow` become `bot.*`
  levels (`fromOldSettings(…, { bot: true })`) and leave the personal account's alone.
- **`messages list --before-time`**, reading back from a moment, and the optional adapter method
  `historyBefore` in `ChatReading` behind it. A messenger without it is refused, saying so.

### Changed — may break callers

- **MCP arguments carry their option's name** (STANDARD, MCP rule 2), and agents must use the new
  ones: `chat_messages_list` takes `before_id`, `before_time`, `after_id`, `after_time` — at most one —
  instead of `before`, `after`; `chat_messages_context` takes `before_n`, `after_n`; `since` is
  `since_time` in `chat_inbox`, `chat_review`, `chat_chats_events`, whose `event` is `type`;
  `chat_messages_send` takes `md` and `at_time`. `chat_messages_list`, `chat_messages_context` and
  `chat_chats_events` answer `{ items, page, limit, hasMore }`, as their commands do. `afterOf` and
  `oneDirection` are gone; `listStart` takes the four starting points and how to spell them.
- **`messages send --at` → `--at-time`**: every option that takes a time names it. No alias; the MCP
  argument is `at_time` too.
- **`server status` answers the shape both tools share** (STANDARD, Output rule 6):
  `since` → `startedAt`, `listening` → `connected`, `listeningSince` → `connectedAt`; new `cliVersion`,
  `log`, and `stale` for a lock a serve that is gone left behind. `server start` answers `startedAt`
  and `connectedAt` the same way.

## 0.87.0 — 01.10.2026

### Added

- **`account update`** — `--first-name`, `--last-name`, `--description`, `--photo <file>` — and
  **`account sessions end --others`**, with the tool `account_update` (P2). The answer masks the
  phone as `account show` does. Ending other sessions logs the owner out of the phone too: it asks
  first by default (`account.sessions.end: ask`; `--yes` answers), and it has no MCP tool at any
  level. A new port group, `AccountEditing` (`updateProfile`, `endOtherSessions`), `ProfileChange`,
  and `Services.account`.

- **`contacts add|remove|block|unblock <person>`, `contacts rename <person> <first-name> [last-name]`
  and `contacts import <file>`**, with the tools `contacts_add|remove|block|unblock|rename` (P2).
  Each goes through the guard as an `account` write. `import` reads a file — one `number, name` per
  line, comma, tab or semicolon between — so no number is on the command line; a bad line is named
  by its number only, and the answer and the journal hold counts, never a number. It has no MCP
  tool. A new port group, `ContactBook`; `PhoneBookEntry` in the domain; `PeopleService` gains the
  writes.
- The manifest says `chats folders list|create|update|delete` are in both tools.
- **A duration takes `h` and `d` too** — `--timeout 1h`, `--pause`, and every option that reads one
  with `parseDuration`.
- **`listed` and `renderList`** in `./cli`: a list with no pages in the envelope a paged one uses —
  `page: 1`, `limit` the count, `hasMore: false`.

### Changed — may break callers

- **Options name the kind of value they take** (STANDARD rule 5; no aliases, the old names are
  unknown options now):
  - `messages list --before` → `--before-id`; `--after` → `--after-id` or `--after-time`, so a
    message id that looks like a time is never read as one;
  - `messages context --before`/`--after` → `--before-n`/`--after-n`;
  - `--since` → `--since-time` in `chats events`, `inbox`, `review`, `store export`, `store fetch`;
  - `store fetch --max-pages` → `--limit <n>`, messages in one run, and `--page-size <n>`, messages
    per request; the run stops at exactly `--limit`. A job records `limit` and `pageSize`.
    `FetchOptions` and `archive.estimate` take `limit` and `pageSize` instead of `maxPages`;
    `Fetching.maxPages` stays, as the messenger's default;
  - `messages download --output` → `--output-dir`; `chats events --event` → `--type`.
- **`review --unanswered` takes a duration** — `4h`, `1d` — not bare hours; `24h` without a value,
  as before. `--unanswered 4` is now refused, with the units it takes. The MCP tool's `unanswered` stays
  a number of hours.
- **Every list answers `{ items, page, limit, hasMore }` in `--json`.** `store status` and
  `store jobs list` printed a bare array; `messages scheduled`, `messages context`,
  `account sessions list` and `models audio list` printed only `items` (`directory` stays beside
  them); `messages list` gains `page: 1`. `chats events` moves `events` to `items` and `more` to
  `hasMore`, keeping `chatId` and `since`; `server logs` moves `lines` to `items`, keeping `profile`
  and `unit`. `--jsonl` and the tables a person sees do not change.
- **`messages send` and `messages edit` drop `--markdown`; `--md` stays.** The standard allows no
  alias. A script that types `--markdown` now fails with an unknown option.
- **`messages send --file`, `--photo`, `--voice` show their value as `<file>`**, the argument name
  the standard fixes. Only the help text changes.

### Fixed

- **A person or a stored chat named by an id that is not digits is found by that id.** `pickPerson`
  looks the reference up as an id before matching names, and `--offline` reads match a stored chat's
  exact id before titles. Telegram and MAX ids are digits and behave as before.
- **`messages download --all` walks each page in the order the messenger returned it**, newest first,
  instead of sorting the page by id as a number. Ids that are not safe integers are still refused,
  since the progress file compares them. Telegram's history comes oldest first, so its order is unchanged.

## 0.85.0 — 01.10.2026

### Added

- **`Messenger.fetching`: how `store fetch` reads a messenger's history** — messages per request,
  the least pause between requests (with `jitter`, each up to twice that), pages per run, and
  `orderBy: "time"` for a messenger whose ids pass 2^53 and do not count messages: its held stretches
  are kept by send time and `before` reaches the adapter as an ISO time; `--estimate` refuses there.
  `--max-pages` and `--pause` default to the messenger's. Without it, nothing changes. `history`
  takes `reactions: false`, which `store fetch` passes: a page it stores needs none.
- **`store export --format jsonl`**, the default said out loud: one message per line, on stdout or
  in `--output`.

- **`cli-messaging-parity <cli> --pages <file...>`** checks user pages against the command tree on
  stdin: every `<cli> <command> --option` a page names must exist on that command, or be in the
  manifest for it and not only for the other tool. `pageProblems` in `./parity` is the same check.

### Changed — may break callers

- **A message id is opaque, not digits.** An MCP tool's `message` or `before` takes any id up to 256
  characters with no space or control character, and `--after` / `after` reads a time only
  when it looks like one — an ISO 8601 date or time, or `30m`, `2h`, `1d`. Anything else now reaches
  the messenger as a message id instead of being refused by the argument check, so the adapter must
  check an id's shape itself. Ids with a space are still refused up front.

- **`new RecipientList(path, command)` requires its second argument**, the app's `command`; the hints
  in a refusal no longer default to `tg`. `sendGuard` without `command` now takes the recipient
  list's.

### Fixed

- **`watch` keeps the last messages before it exits.** Closing waits up to 5 seconds for the saves
  still being written; one that takes longer is a warning, and the command still ends normally.

## 0.84.0 — 01.10.2026

### Added

- **`chats folders list|create|update|delete`**, and the tools `chats_folders_list|create|update|delete`
  (P2). A folder is named by its id or its title exactly; two with the same title are refused. Each
  change goes through the guard as an `account` write (`folder-create`, `-update`, `-delete`). A new
  port group, `ChatFolders`; `Folder` and `FolderChange` in the domain; `Services.folders`.
- The manifest says `chats members add|remove` and `chats admins add|remove` are in both tools.

### Fixed

- **On a SQLite without full-text search, the store refuses with a message that says what to do**,
  before it writes anything: official Node 22.0–22.15 and 23.x ship one, and so may Bun on an old
  macOS. Before, the store failed on such a Node with `no such module: fts5` and could not be used at
  all. `engines.node` is now `^22.16.0 || >=24`, the Node versions the store works on.

- **A message deleted with `messages delete` is gone from the store too**, so `messages search` and
  `messages list --offline` stop showing it; an edit replaces the stored text, and a forwarded copy is
  kept in the chat it went to. Before, the store kept what the read before the write had saved.

## 0.83.0 — 01.10.2026

### Added

- **`chats members add <chat> <person...>`** (`--history` where the messenger has it),
  **`chats members remove`**, **`chats admins add <chat> <person> --can <rights>`** and
  **`chats admins remove`**, with the tools `chats_members_add|remove`, `chats_admins_add|remove`
  (P2). The people are resolved to ids first; adding counts each person toward the hourly limit and
  refuses one the recipient list does not name. `members add` answers `added` and `notAdded`.
  `GroupAdmin` gains `addMembers`, `removeMembers`, `addAdmin`, `removeAdmin`; `ADMIN_RIGHTS` and
  `AdminRight` in the domain; `Messenger.addsWithHistory` and `Messenger.adminRights` say what a
  messenger offers.
- The manifest says `chats update` (title, description, `--all-can-pin`, `--only-admins-add`) and
  `chats link show|reset` are in both tools.

- **Store version 12: a word index over the normalized text**, for the ranked search that comes
  next. A file of up to 5,000 messages is indexed when it is opened; a larger one is indexed later
  in batches. Older builds keep opening the file (`min_compatible` stays 6), and what they write is
  indexed. Saving messages is about a quarter slower and the file about 15% larger (measured, 100,000
  messages through the store).

## 0.82.0 — 01.10.2026

### Added

- **`chats update <chat>`** — `--title`, `--description` and the group's settings as `--<setting> on|off`,
  one write — **`chats link show|reset`**, and the tools `chats_update`, `chats_link_show`,
  `chats_link_reset` (P2). `chats show` adds a group's `description`, `link` and `settings` where
  the messenger reads them. `GroupAdmin` gains `group`, `updateGroup` and `resetInviteLink`;
  `Messenger.groupSettings` names the settings a messenger has, and `chats update` offers only those.
  `GroupChange` and `GROUP_SETTINGS` in the domain.
- The manifest says `chats create`, `join` and `leave` are in both tools.

## 0.81.0 — 01.10.2026

### Added

- **`chats create <title> [person...]`, `chats join <link>`, `chats leave <chat>`**, and the tools
  `chats_create`, `chats_join`, `chats_leave` (parity plan P2). Each goes through the guard as a
  `chat` write and answers `{ operationId, chat }` (`leave`: `{ operationId, chatId }`); the people
  added are resolved to ids first, so the recipient list and the hourly limit count them. A new port
  group, `GroupAdmin` (`people`, `createGroup`, `join`, `leave`), and `GroupCard` / `GroupSettings`
  in the domain; `Services.admin`. A messenger without the group refuses with "this messenger
  cannot …".
  conversation rows with them.
  Each rebuild of a chat is written under its own build number and made current at once, so a big
  chat's rebuild never holds the write lock for long.
  `messages.mentions` keeps whom a message mentions by id, where the messenger says so.

## 0.80.0 — 01.10.2026

## 0.79.0 — 01.10.2026

### Fixed

- **`chats show`, `contacts list` and `contacts show` no longer fail online when the store does not
  know the profile's account yet** — before the first connection that names it. They answer with
  what the messenger gave, as they did before they read the store.
- **`contacts list` asks for the chats before it reads the store**, so on a messenger whose login
  brings the people the first run lists them rather than the dialogs.

## 0.78.0 — 01.10.2026

### Added

- **`messages list --mark-read`** marks the chat read up to the newest message shown — the other
  person sees it — and answers `markedRead: { operationId, until }`; refused with `--offline`.
  Nothing else in `messages list` marks anything read. The `messages_list` tool stays read-only:
  `chats_mark_read` does that behind its own permission.
- **`--model <id>` beside `--transcribe`** on `messages list` and `inbox`, and `model` on their tools:
  which downloaded speech model hears the voice messages. Alone it is refused rather than ignored.
- **`review --transcribe`** and `--model`, and `transcribe` and `model` on the `review` tool: voice
  messages in a review come with their text, and `unheard` lists the rest.
- **`messages send --voice <file>`**: an Ogg Opus file (`.ogg`, `.oga`, `.opus`) as a voice message,
  alone — no text, no file, no photo beside it. **`--as-file`** sends the `--file` as a file to
  download even where the messenger would play it, a video included. The `messages_send` tool takes
  `voice` and `as_file`. `UploadKind` gains `voice`, `Upload` gains `asFile`, and `readAttachments`
  reads what a send attaches, the same for the command and the tool.

## 0.77.0 — 01.10.2026

### Changed — may break callers

- **MCP offers tools by the profile's permissions, not by flags.** With the defaults, every write
  tool is offered and acts without a form; `messages_delete` (level `ask`) shows the owner a form
  first, which `mcp --allow-dangerous` skips, as the global `--yes` does for any other write at
  `ask`. `deny` hides a tool, `readonly` hides the writing ones, and with `messages: deny` the
  prompts and resources are not offered either. `--confirm-send` still puts every write through
  the form. `--allow-send`, `--allow-mark-read` and `--allow-delete` decide nothing: they are
  accepted with a warning so a configured agent still starts. `createServer` takes `confirmSend`,
  `yes` and `allowDangerous`; `instructions` takes the offered `writes`; `<cli>_status` answers
  `permissions` instead of `allow`.

### Fixed

- **A `--limit` or `--page` that is not a whole number is refused as typed**: `--limit abc` said
  `not NaN`, and `--limit 12abc` was quietly read as 12. Both are now `validation_error` quoting the
  value. `positiveCount(flag)` in `cli/paging.ts` is the one parser for them.
- **The transcript speaks the app's language.** `AppIdentity.locale` (for example `en-GB`) sets the
  day headings and the word for your own messages in every command that prints a conversation;
  tg printed `вы` and `3 января 2026`. Unset, it stays `ru-RU`, so max-cli does not change.

- **Saving messages compiled every SQL statement again on every call.** The store now queries through
  Drizzle, one module per kind of record under `src/store/sqlite/`, and prepares the statements each
  saved message runs once per open store: 9,131 rows/s at a million messages instead of 6,900, with a
  sixth less peak memory. Search answers as before. `MessageStore` does not change.

## 0.76.0 — 01.10.2026

### Added

- **`deny` stops reading too.** A command whose key is `deny` is refused (`permission_error`) before
  it connects or opens the store — `messages list`, and everything else that shows messages:
  `inbox`, `review`, `watch`, `serve`, `store fetch|export|search|status|jobs`. Housekeeping
  (`config`, `doctor`, `runs`, `store info|check|migrate|backup|restore`, …) is never stopped.
  `keyForCommand(path)` says which key a command path is checked against.
- **Permissions: one level per command path.** A profile's `permissions` setting maps command paths
  to `deny`, `readonly`, `ask` or `allow` — `config set permissions.messages.delete allow` — and the
  most specific key the owner set wins. A key starts with a resource (`messages`, `reactions`,
  `polls`, `topics`, `chats`, `contacts`, `account`), so a misspelled one is refused. By default
  everything is allowed except `messages.delete` and `account.sessions.end`, which ask; a built-in
  default only ever tightens a broader key. `ask` asks y/N at the terminal, never under `--json` or
  `--jsonl`; `--allow-dangerous` (deleting) or the new global `--yes` (every other write) answers
  yes, and with nobody at a terminal the write is refused (`confirmation_required`). `readOnly` and
  `allow` keep working, read as levels. Exports `LEVELS`, `levelFor`, `DEFAULT_PERMISSIONS`,
  `fromOldSettings`, `keyForWrite`; `sendGuard` takes `permissions` and `ask`, and without them
  decides as before; `SendGuard.ask` is the question `guardedWrite` awaits before `check`, and
  `check` refuses an `ask` write that was never asked. MCP is unchanged for now.

- **`polls create --revote`**, and `revote` on the `polls_create` tool: people may change their vote.
  Without it they cannot, in every messenger — MAX's default, and now Telegram's too: a tg poll made
  without `--revote` stops allowing a changed vote. `NewPoll.revote`; an adapter treats it absent as
  `false`.
- **`store fetch --last <n>`**: stop once the newest n messages of the chat are held, counted in the
  store, so a later run with the same `--last` asks for nothing. Not with `--since`. `FetchOptions.last`;
  the answer carries `reachedLast: true` when it stopped there.
- **`chats show` and `contacts show` answer with `--offline`**, from the store. `chats show` fills
  `members` from the member list the store holds, online too when the messenger gave none; with no
  list saved it stays `null`. `contacts show` fills the shared chats the same way.
- **`contacts list` reads the store's contacts where it holds who is in each one-to-one chat** —
  ordered by the newest conversation, or by name — and from the dialogs as before where it does not.

### Changed — may break callers

- **`messages delete` asks instead of refusing** when `--allow-dangerous` is missing and someone is
  at a terminal; with nobody there it is refused as before.

- **`store fetch --max <n>` is gone; `--max-pages <n>` caps a run instead**, in pages of 100 (10 by
  default, so 1000 messages, as `--max` was). The same names as max-cli's, so one limit has one name
  in both. No alias.
  `FetchOptions.max` and the `estimate` option `max` become `maxPages`; `estimate`'s `runs` counts
  requests per run, a held stretch to step over included. A background job records `maxPages` and
  `last` instead of `max`, and `store jobs` prints them; a job started before shows neither.

## 0.75.0 — 01.10.2026

### Changed — may break callers

- **`runs list`, `sends list` and `recipients list` answer the list envelope** in `--json`,
  `{ items, page, limit, hasMore }`, as every other list does; they printed a bare array. A script
  that read `.[]` reads `.items[]`. `--jsonl` is unchanged: one item per line. `sends list` and
  `runs list` say `hasMore: true` when `--limit` cut the list short.

## 0.74.0 — 01.10.2026

### Added

- **`account show --show-phone`.** `Account` gains `phone`, filled where the messenger tells it;
  `account show` prints its last four digits (`***1234`) unless `--show-phone` is given, and the
  `account_show` tool always does. `maskedAccount` is exported from `./cli`.
- **`store export --output <file> --since <time>`.** `--output` writes JSON lines, or the transcript
  with `--format markdown`, to a new file with mode 600 and answers `{ path, format, count }`; it
  refuses a file that exists. `--since` exports from an ISO 8601 time or `30m`/`2h`/`1d` ago on.
  `ArchiveService.export` takes `{ since }`.

## 0.73.0 — 01.10.2026

### Added

- **`messages edit --md`**, and `markdown` on the `messages_edit` tool: the new text's marks become
  formatting, as in `messages send --md`. `MessageEditing.edit` receives `{ markup }` as a fourth
  argument; an adapter that cannot format refuses it rather than dropping it.
- **`messages forward --send-id <id>`**, and `send_id` on the `messages_forward` tool: a forward whose
  outcome was unknown is repeated with its send id, and the messenger keeps one copy. The answer now
  carries `sendId`. `MessageEditing.forward` receives `sendId` in its options; an adapter passes it as
  the messenger's own deduplication id (Telegram's `random_id`, MAX's `cid`).

## 0.72.0 — 01.10.2026

### Added

- **`guardedVote`, `guardedClose`, `guardedCreatePoll`** from `./cli`: the guarded poll writes, for max-cli's MCP tools while they answer through the shared code.

## 0.71.0 — 01.10.2026

### Added

- **`sendCommand`**, `messages send` on its own from `./cli`, for max-cli's group 4 move.

## 0.70.0 — 30.09.2026

### Changed — may break callers

- **Depends on `@leemour/cli-core` 0.9.0.** A CLI that uses this package moves to cli-core 0.9.0 in the
  same change: two copies of cli-core in one install lose the error codes, because an error from one
  copy is not an instance of the other's classes.

## 0.69.0 — 30.09.2026

## 0.68.0 — 30.09.2026

### Added

- **Each write command on its own**, from `./cli`: `deleteCommand`, `editCommand`, `forwardCommand`,
  `pinCommand`, `unpinCommand` and `markReadCommand`, for a CLI that moves its commands onto the
  shared ones one at a time — max-cli, group by group.

- **`parity.json`, the parity manifest of tg and max**, in the package: every command and option of
  both CLIs, each `both`, one-sided with a reason, or `planned` with who closes it, and the option
  catalogue — one name, one meaning. A CLI checks itself against it with
  `<tool> commands --json | cli-messaging-parity <max|tg>`, which exits 1 and names each difference;
  `@leemour/cli-messaging/parity` exports the same check.

## 0.67.0 — 30.09.2026

### Added

- **`store backup <file>` and `store restore <file>`.** `store backup` copies `messages.db` into a new
  file while it is in use, readable by the owner alone, and never overwrites a file. `store restore`
  puts a backup in place of the store and keeps the store it replaces beside it, as
  `messages.db.before-restore-<time>`; nothing is deleted. It refuses a backup that is damaged or that
  a newer version wrote, a store that another process has open or is writing to, and a store this
  CLI's `serve` is keeping; it ends by saying to restart any running `serve` and `mcp`. `store check`
  now suggests a backup before `store migrate`.

## 0.66.0 — 30.09.2026

### Added

- **`guard` on `Messenger`, optional**: the send guard a command writes through, when the messenger's
  is not the profile's plain one. max-cli's background server journals every write it forwards, so a
  command going through it must record only its own refusals, or each write counts twice.

## 0.65.0 — 30.09.2026

### Added

- **`events` in `ConnectOptions`**: `Messenger.connect` gets the run's diagnostics, from commands and
  from MCP alike, so a messenger can report its own wire — max-cli's frames, with opcode and size —
  beside the adapter's calls.

## 0.64.0 — 30.09.2026

### Added

- **`newSendId()` on the adapter port, optional**: a send id in the messenger's own form. `messages
  send` and `polls create` ask the connection for one before falling back to `newSendId`. MAX's
  official client sends a millisecond timestamp, and max-cli must look like it.

## 0.63.0 — 30.09.2026

### Added

- **`store info`, `store check` and `store migrate`: looking after `messages.db`.** `store info` says
  where the file is, its size, its schema and how many rows it holds. `store check` reports whether it
  is healthy — SQLite's integrity check, foreign keys, the three search indexes against their tables,
  free disk against the file's size, messages waiting for normalization — and names every chat whose
  held history stops before the chat's newest message, with when the chat was last refreshed. It
  repairs nothing. Neither of the two migrates the file. `store migrate` brings the file up to this
  build's schema, then normalizes the messages stored before version 6, in batches, with the progress
  on stderr; stopping it loses nothing. `pendingNormalization` and `backfillNormalized` are exported
  from `./store`.

## 0.62.0 — 30.09.2026

### Added

- **Diagnostic events for a frame protocol.** A request or response event may carry `opcode`, `seq`,
  `status` and `bytes`; a new `cache` event says a read was answered locally, and why; a warning may
  carry `detail`. `renderEvent` shows them. max-cli writes its run records in this one format.
- **`startRecording`**: `recorded` in two halves, for a caller that starts a run before its command
  and ends it after. Exported from `./cli` with `Recording`, `wasSettled` and `runtime`.
- **`allowFix` on the send guard**: the command that changes `allow`, for a CLI whose configuration
  has more places than profiles and defaults.

## 0.61.0 — 30.09.2026

### Added

- **An `operationId` on every write.** Each write the send guard sees — send, edit, forward, delete,
  pin, unpin, react, mark read, poll vote, close and create — has an id. It is in the write's answer,
  on each of its lines in the send journal, and in the `--trace` and run events of the calls it makes,
  so one write can be followed through all three. A send's `operationId` is its `sendId`.
  `newOperationId` and `currentOperation` are exported from `./sends`.
- **The send journal takes max-cli's entries.** Attachments may be `video` and `voice`; account
  actions may be `contact-rename`, `contact-block` and `contact-unblock`, under the `contacts`
  permission.

### Changed — may break callers

- **Every write's `--json` answer and MCP result gains `operationId`.** `messages edit` and
  `messages forward` services return `{ operationId, message }` instead of a bare `Message`; the
  commands already printed `{ message }`. `polls vote` and `polls close` print `{ operationId, poll }`
  instead of a bare poll. `guardedWrite` requires an `operationId` in its attempt.

## 0.60.0 — 30.09.2026

### Removed

- **`drizzle-orm` is no longer installed with this package.** The store's Drizzle modules are bundled
  into `dist/` at build time: loaded from `node_modules`, Drizzle cost Node about 200 ms per process;
  bundled, opening it takes about 6 ms. About 16 MB less for tg-cli and max-cli to install.

## 0.59.0 — 30.09.2026

### Added

- **The adapter port in named groups** — step 3 of the layer design. `MessengerAdapter` is now
  `MessengerCore` (the required methods) plus optional groups: `ChatReading`, `MessageEditing`,
  `MessagePins`, `MessageReactions`, `ReadState`, `MessagePolls`, `LiveUpdates`, `MessageMedia`,
  `ScheduledMessages`, `GroupModeration`, `AccountTools`, all exported from `./cli`. The type is the
  same as before, so no adapter changes; one that has a group can say `implements MessageEditing` and
  be held to the whole group.

## 0.58.0 — 30.09.2026

### Added

- **`@leemour/cli-messaging/services`, and a CLI's own version of a use case** — the last step of
  `docs/plans/2026-09-30-services.md`. The new entry exports the services (`messages`, `chats`,
  `people`, `inbox`, `archive`), their factories, `ServiceDeps`, `onlineDeps`, `storedDeps` and
  `Override`. `Messenger.services` takes an `Override`: it returns the services it changes and can
  call the shared method inside, and commands and MCP tools both get the replacement. MCP tools now
  build their services through `servicesFor`, so the override reaches them. Nothing changes for a
  CLI that sets no override.
- **Services: inbox and archive**, the fourth step of `docs/plans/2026-09-30-services.md`.
  `services.inbox` (`read`, `review`) and `services.archive` (`status`, `held`, `export`, `estimate`,
  `fetch`) take over `inbox`, `review`, `store status|export|fetch` and the MCP `inbox` and `review`
  tools. The `--offline` refusals of `inbox` and `review` moved into the service with the same words.
  Nothing a person or a script sees changes.

## 0.57.0 — 30.09.2026

### Changed — may break callers

Commands follow one naming standard: a noun, then a verb. The old names are gone, with no aliases —
they now fail as unknown commands or options.

- **`export <chat>` is `store export <chat>`**, **`sync status [chat]` is `store status [chat]`**,
  **`backfill <chat>` is `store fetch <chat>`**, and **`backfill list|status|cancel` is
  `store jobs list|show|cancel`**. `store fetch` still fetches by default; `--estimate` only estimates.
  Its `--pace` is **`--pause <duration>`**, and so is `messages download --all --pace`. `--max` keeps
  its name: it counts messages, not pages. A CLI now adds one `storeCommand(messenger)` in place of
  `exportCommand`, `syncCommand` and `backfillCommand`. Jobs started by an earlier version are still
  listed.
- **`messages reply` is gone**: `messages send <chat> [text] --reply-to <message>` answers a message,
  with every send option. The locator form (`messages reply msg:… <text>`) has no replacement;
  `--reply-to` takes the message id in the chat named. The MCP send tool already took `reply_to`.
- **`chats read` is `chats mark-read`**, and its MCP tool `<cli>_chats_read` is
  `<cli>_chats_mark_read`.
- **`messages search <words...>` names its argument `<text...>`**; the search is unchanged.
- **`recipients off` is `recipients clear`**: it deletes the list. The answer is unchanged,
  `{ off: true, wasOn }`.
- **A heard voice message is kept in the shared store, not in `transcripts-<profile>.db`.** The
  transcript belongs to the account the profile last logged in as; a profile never online keeps none.
  `Kept` answers promises now (`get`, `keep`, `close`). Transcripts kept in the old per-profile files
  are not read: each voice message is heard once more, and the old files can be deleted.
- **A deleted message leaves no text behind.** `markDeleted` keeps the tombstone and now empties the
  text, drops the search copy, the edit history and the transcript — in tg-cli and max-cli alike.
  `saveMessages` leaves a deleted message as it is, unless `seenAt` says the messenger returned it
  after the deletion: then it comes back with its text. A caller that read a deleted message's text
  from the store gets `""`.

### Added

- **`Message.senderUsername`** — the sender's handle without `@`, where the messenger has one. The
  store saves it on the sender's identity, and a later message without it keeps the one saved, so
  `people` answers it and a mention can be matched to its sender. An adapter that leaves it out
  changes nothing.
- **Services: chats and people** — the third step of `docs/plans/2026-09-30-services.md`.
  `services.chats` (`list`, `show`, `members`, `events`, `inspect`, `markRead` through the guard) and
  `services.people` (`list`, `show`, `lookup`, `sync`) take over `chats list|show|members list|events|inspect|mark-read`,
  `contacts list|show|lookup|sync` and their MCP tools. `CHAT_SCAN`, `EVENTS_DAYS` and `phoneOf` now come
  from `src/services/`. Nothing a person or a script sees changes.
- **Contacts in the store** (store version 10): `contacts(key, { order: "recent" | "name", query?,
  limit, offset? })` lists the people in the account's one-to-one chats — as far as the saved member
  lists go — with `countContacts` for the same filter; `refreshRecency(key)` works out again when each
  was last written to. A person now keeps `description` (`PersonFacts.description`). Additive: a
  build on version 6 keeps working on the file.
- **Transcripts in the store** (store version 11): `transcript(key, chatId, messageId)` and
  `keepTranscript(...)`, per account, keyed by chat and message id — a message can be heard before
  the store holds it. Additive: a build on version 6 keeps working on the file.
- **Store reads for the services** (no schema change): `chats` takes `query` (three letters or more
  of a title), `kind` and `unread`, with `countChats` for the same filter; `messages` takes `since`,
  with `countMessages`; `messagesWindow(key, chatId, { at, before, after })` reads around a moment,
  as `around` reads around a message id. Type `StoredChatFilter`.
- **`purge(key)`** removes everything one account holds — chats, messages, members, sync state,
  leases, transcripts, whom it has seen — for `cache clear`; other accounts stay whole.
- **`applyDelta(key, { chats?, people?, members?, state? })`** writes a catch-up's whole answer in one
  transaction — chats, people, each listed chat's members, sync state such as a delta marker — so a
  failure leaves nothing half-written. Type `Delta`.
- **`store fetch <chat> --since <time>`** stops after the page that reaches a message older than the
  time: ISO 8601, or `2h` / `1d` ago. The answer then carries `reachedSince: true`. A background job
  gets the time as ISO, so it does not move when the job starts later. Refused beside `--estimate`,
  which prices a full fetch.

## 0.56.0 — 30.09.2026

### Added

- **Sync state in the store** (store version 8): `syncState(key, name)` answers what a sync remembered
  for the account — a delta marker, when a list was last complete — with when it was set;
  `setSyncState` and `clearSyncState` change it. Values are text; a caller encodes a number itself.
  Additive: a build on version 6 keeps working on the file.
- **Fetch leases in the store** (store version 9): `claim(key, chatId, anchor, holder, forMs)` takes a
  stretch of a chat for a while and answers whether this holder has it — refused while another
  holder's lease runs, renewed for the same holder — and `release` gives it back. Two processes
  backfilling one chat no longer fetch the same pages. Additive: a build on version 6 keeps working.

## 0.55.0 — 30.09.2026

### Added

- **Services: the message writes too** — the second step of `docs/plans/2026-09-30-services.md`.
  `services.messages` gains `send` (a reply is a send with `replyTo`), `edit`, `delete`, `forward`,
  `pin`, `unpin` and `react`, each through the send guard. `messages send|reply|edit|delete|forward|pin|unpin`,
  `reactions add|remove` and the MCP write tools call them. The internal `guarded*` helpers are gone;
  `DELETE_AT_ONCE` now comes from `src/services/`. Nothing a person or a script sees changes.
- **Chat members in the store** (store version 7): `saveMembers(key, chatId, ids)` replaces who is in
  a chat with the list given, `members(key, chatId)` reads them back by name, and
  `chatsWith(key, id)` lists the chats a person is in, newest first. Additive: a build on version 6
  keeps working on the file.

## 0.54.0 — 30.09.2026

### Fixed

- **A deletion that names no chat skips a Telegram supergroup or channel the store knows only by its id.**
  0.52.0 recognised them by their kind or chat type; a chat first seen through one of its messages has
  neither yet, but its id is marked `-100…`. Only Telegram accounts are affected; other providers as before.
- **A message the store marked deleted by mistake comes back on the next read that returns it.**
  `saveMessages` takes `seenAt`, when the messenger was asked; a tombstone older than that is lifted and
  the message is searchable again, a newer one stays. `history`, `around` and live edits pass it, so the
  messages an earlier version wrongly marked deleted reappear once their chat is read again.

## 0.53.0 — 30.09.2026

### Added

- **`messages download <chat> --all`** saves every file of a chat into `--output`, newest first, page
  by page with a `--pace` between pages (1 s). Messages with no file cost no download request. It is
  resumable: the stretches of messages already walked are kept in `.download-<chat>.json` beside the
  files, written after every file, so a run cut short by `--timeout` or Ctrl-C repeats at most the file
  it was in; running it again jumps over what is done and picks up newer messages too. Rate limits
  ("wait N seconds") up to five minutes are sat out. File names are as for one message; a name another
  message already took gets the message's prefix (`<id>-<n>-<name>`), and nothing is overwritten.
  `<message>` is now optional, and refused beside `--all`. No MCP tool: it runs long, and
  `<cli>_messages_download` covers one message.

## 0.52.0 — 30.09.2026

### Fixed

- **A deletion that names no chat no longer hides messages in other chats.** Telegram reports a
  deletion in a private chat or a basic group by message id alone. The store used to mark every
  message of the account with that id as deleted, channels and supergroups included, where the same
  id is a different message. Now it skips channels and supergroups, and skips the deletion when the
  id still matches more than one message.

## 0.51.0 — 30.09.2026

### Added

- **Services: each use case once, for commands and MCP tools alike** — the first step of
  `docs/plans/2026-09-30-services.md`. `withServices` on the messenger context
  hands a command `services.messages` (`list`, `around`, `search`), which chooses between the
  messenger and the store; it opens the connection or the store only when asked, and closes them
  after. `messages list|context|show|search` and the MCP read tools use it. Nothing a person or a
  script sees changes.

### Fixed

- **A local model no longer drops quietly spoken speech.** The voice detector that cuts a recording
  into pieces took a quiet stretch for silence and threw it away: in a 19-second voice message both
  GigaAM and Parakeet lost the middle 10 seconds that Telegram heard. Its threshold goes from 0.5 to
  0.3. Transcripts a local model kept before are forgotten once, so `--transcribe` hears them again;
  the messenger's are kept.

## 0.50.0 — 30.09.2026

### Added

- **`pollsCommand` — `polls show|vote|close|create`**, max-cli's. `show` answers a poll (`Poll`,
  `PollAnswer`) with each answer's id; `vote <chat> <message> <answer ids...>` votes by those ids, never
  by position, and `--retract` takes the vote back; `close` closes the owner's own poll; `create <chat>
  <question> <answers...> [--multiple] [--anonymous] [--silent] [--send-id]` sends one, public unless
  `--anonymous`. The send guard checks a vote as a `reaction`, closing as an `edit` and a new poll as a
  `message` with a send id, so a retry after an unknown outcome is safe. MCP: `<cli>_polls_show` reads;
  `--allow-send` adds `<cli>_polls_vote`, `_close` and `_create`. An adapter offers the optional
  `poll`, `vote`, `closePoll` and `createPoll`; a CLI adds the command group itself.

## 0.49.0 — 30.09.2026

### Changed — may break callers

- **Store version 6, and builds before it refuse the file.** `min_compatible` rises to 6: a tg or
  max built on an earlier cli-messaging opens an upgraded `messages.db` only to say «the message
  store was written by a newer version … — upgrade this tool». Release a CLI's bump of this package
  together with the other's, then upgrade both: `npm install -g @leemour/tg-cli@latest
  @leemour/max-cli@latest`. Version 6 adds `chats.username`, `membership_state`, `is_searchable` and
  `message_count` (kept by triggers), and `messages.normalized_text` with `normalizer_version`. The
  upgrade holds the write lock for about 0.4 s on a million messages.

### Added

- **Every saved message keeps a normalized copy of its text** — accents and marks removed, ё as е,
  lowercase, whitespace collapsed — for the word search to come; the original text is untouched. A
  deleted message gets none. Messages stored before version 6 are filled on the first open when
  there are at most 5,000 of them; a larger store is filled by `db migrate`, still to come, and
  nothing reads the copy before then.
- **`Chat.membershipState`** (`joined`, `left`, `public`, `imported`, `archived`, `external`), absent
  where the messenger does not say. The store keeps the last one it was told.

## 0.48.0 — 30.09.2026

### Added

- **`messages delete <chat> <messages...> [--for-everyone] --allow-dangerous`**, max-cli's: at most 10
  messages, for the owner only unless `--for-everyone`, and nothing without `--allow-dangerous` — no
  prompt asks instead. The send guard checks it as a `delete` and counts each message toward the hourly
  limit. The answer is `{ chatId, deleted, forEveryone }`. An adapter offers it with the optional `delete`.
- **`mcp --allow-delete`** offers `<cli>_messages_delete`, which deletes the owner's own copy only; for
  everyone is the command's alone. `--allow-send` does not imply it, and `mcp config` carries it.
  `ServerOptions` and `McpFlags` gain `allowDelete`, and `--confirm-send` is accepted with it alone.

## 0.47.0 — 30.09.2026

### Added

- **`topicsCommand` — `topics list <chat>` and `topics search <chat> <text>`** and the `topics_list`
  tool: a forum group's topics, newest activity first, paged, each with the id its messages carry as
  `threadId` (type `Topic`). Telegram has forums, MAX does not. A messenger offers it with the
  optional `topics`; a CLI adds the command group to its program.
- **`chats inspect <link>`**, max-cli's, and the `chats_inspect` tool: what an invite or public link
  leads to, read without joining — `LinkTarget`: kind, title, id (`null` for a private chat the owner
  is not in), members, description, whether the owner is already in it, and whether joining needs
  approval. A messenger offers it with the optional `inspect`.
- **Voice messages carry their text in `messages list` and `inbox`.** A transcript heard once is kept
  per profile in the CLI's own cache (`transcripts-<profile>.db`, not the store) and shows on every
  later read as `transcript` — under the text, with 🎤, for a person. `--transcribe` hears the rest —
  by the messenger or a model on this machine, as `messages transcribe` chooses — within two minutes
  for the whole list; what is left is in `unheard`, never a failure. `transcribe` on the list and
  inbox tools does the same. `messages transcribe` keeps what it hears too.

### Fixed

- **`config show` says `transcribeWith` is `auto` when unset**, not `null`.

## 0.46.0 — 30.09.2026

### Added

- **`chats read <chat> [--until <message>]`** marks a chat read, to its newest message or to the one
  named; the other side sees it. The MCP tool `<cli>_chats_read` is offered only with the new
  `mcp --allow-mark-read`, which `--allow-send` does not imply, and `mcp config` carries the flag. The
  send guard checks it as a `read`, which never counts toward the hourly limit. The answer is
  `{ chatId, until }`. An adapter offers it with the optional `markRead`.

### Changed — may break callers

- **`--confirm-send` is accepted with `--allow-mark-read` alone**; it refused anything but `--allow-send`.
  `ServerOptions` and `McpFlags` gain `allowMarkRead`.

## 0.45.0 — 29.09.2026

### Added

- **`account sessions list`**, max-cli's, and the `account_sessions` tool: every device and app logged
  in to the account — `current`, `client`, `device`, `location`, `lastActiveAt` (type
  `AccountSession`). It reads only. A messenger offers it with the optional `sessions`; `account
  sessions` is a command group of its own file, for `end-others` to join.

## 0.44.0 — 29.09.2026

### Added

- **`reactionsCommand` — `reactions add <chat> <message> <emoji>` and `reactions remove <chat> <message>`**,
  and with `--allow-send` the MCP tools `<cli>_reactions_add` and `<cli>_reactions_remove`. The send guard
  checks them as a `reaction`, which never counts toward the hourly limit; the confirmation form shows
  the emoji. The answer is `{ chatId, messageId, reaction }`, `null` once taken off. An adapter offers it
  with the optional `react`; a CLI adds the command group itself.

## 0.43.0 — 29.09.2026

### Added

- **`server status` says when the running `serve` is older than the CLI** — "It runs tg 0.8.0, and tg
  is now 0.9.0 — `tg server restart`", as max-cli's does; `--json` gains `version`. `serve` records its
  version in the lock. **`servingProfiles(app, env)`** names the profiles a serve runs for, for an
  update to restart.
- **`messages send --file <path>` and `--photo <path>`**, the text as the caption, and `file` and
  `photo` on the MCP send tool. A file is read before connecting, with max-cli's rule: hidden files
  and folders (`~/.ssh`), the CLI's own folders and the message store file are refused — the command takes
  `--allow-any-file`, the MCP tool never does. The journal records each attachment's kind and size,
  never its name. An adapter receives them as `SendOptions.attachments` (`Upload`: kind, name, bytes);
  `readUpload` is exported from `./sends`.

## 0.42.0 — 29.09.2026

### Changed — may break callers

- **Speech models move to `~/.cache/cli-common/models/audio`**, a folder named for the whole family of
  CLIs rather than for this package, and `CLI_COMMON_CACHE_DIR` moves it (was `MESSAGING_CACHE_DIR`).
  A model downloaded into `~/.cache/cli-messaging/models/audio` is not found there: move the folder.

### Added

- **`contacts lookup`**, max-cli's: who has a phone number, read from stdin or asked for — **never an
  argument**, which `ps` and shell history would keep; one given anyway is refused without being
  repeated. Also the `contacts_lookup` tool. A messenger offers it with the optional `lookup`.
- **`contacts sync`**: the messenger's own contact list — the address book, not the chats — into the
  local store, answering `{ added, changed, known }`. A messenger offers it with the optional
  `addressBook`.

- **`chats members list <chat>`**, max-cli's, and the `chats_members` tool: everyone in a group, paged
  like every listing (`--limit`, `--page`, `--all`). A member may carry `role` (`owner`, `admin`,
  `member`) and `lastSeenAt` (`null` when their privacy hides it) — type `GroupMember`. A messenger
  offers it with the optional `members`. `chats members` is its own command group, in
  `chats-members-command.ts`, for the subcommands that change membership to join.
- **`messages pin <chat> <message> [--notify]` and `messages unpin <chat> <message>`**, and with
  `--allow-send` their MCP tools `<cli>_messages_pin` and `<cli>_messages_unpin`. A pin is quiet
  unless `--notify`; the send guard checks both as a `pin`, and only a pin that notifies counts toward
  the hourly limit. The answer is `{ chatId, messageId, pinned }`. An adapter offers them with the
  optional `pin` and `unpin`.
- **`messages send --at <time>`** — the messenger sends it later: `2026-09-25T09:00` (local time) or
  `30m`, `2h`, `1d` from now, rounded down to the minute, as in max-cli. The answer carries
  `scheduledFor`, the journal counts it in the hour it goes, and the store does not keep it — it will
  arrive under another id. Refused with `--send-id`: a repeat would schedule it twice.
- **`messages scheduled <chat>`**, the MCP tool `messages_scheduled`, and `at` on the send tool. The
  confirmation form shows the clock time a delay becomes. An adapter lists the queue with the optional
  `scheduled(chat)` and receives the time as `SendOptions.at`.
- **`drizzle-orm` 1.0.0-rc.4 is a dependency** (about 16 MB installed), for the store's move to
  Drizzle. Nothing loads it yet, so no command changes and startup time stays the same.

## 0.41.0 — 29.09.2026

### Added

- **`chats events <chat> [--since] [--event join,leave,…]`**, max-cli's, and the `chats_events` tool:
  who joined, left, was added or removed, and by whom — plus `create`, `title` and `pin` — from the
  chat's service messages, oldest first, seven days back without `--since`. A messenger offers it
  with the optional `chatEvents` (types `ChatEvent`, `ChatEvents`); `more` says one run did not reach
  back to `--since`.

## 0.40.0 — 29.09.2026

### Changed — may break callers

- **`serviceCommand` is now `serverCommand`: `server start|stop|restart|status|logs|install|uninstall`**,
  the words max-cli's `server` uses. `service …` and `serve status` are gone: `server status` answers for
  both — whether serve runs, since when, whether it is listening yet, who started it (`unit`, `server` or
  `hand`) and the unit if there is one. `ServiceSystem` is `ServerSystem`, with `spawn` and `pause`.
  Unit names are unchanged, so a unit written by `service install` is still found.
- **`Defaults`, what an MCP tool's `online` receives, carries `settings` and `env`.** A CLI that
  builds its own tools from `tool()` and calls them directly must pass both.
- **`@leemour/cli-messaging` now depends on `sherpa-onnx` and `ogg-opus-decoder`** (about 15 MB of
  WebAssembly). Both are loaded only when a model runs.

### Added

- **`messages list --after <id-or-time>`**, max-cli's, and `after` on the `messages_list` tool: the
  oldest messages newer than a message id or a moment, for reading a chat forward. Digits are a
  message id — exact within one chat — anything else a time (ISO 8601, `2h`, `1d`). `--before` with
  `--after` is exit 2, and so is `--after` offline. A messenger offers it with the optional
  `historyAfter` (type `After`); without it the command says it cannot read forward.

- **`chats list --search <text> --kind <kind> --unread`**, max-cli's, and `search`, `kind` and
  `unread` on the `chats_list` tool. The filters combine; `--search` takes at least 3 characters and
  matches the chat's name. A filtered list searches the newest 200 chats — paging through every chat
  hit Telegram's rate limit once — and says so, `partial: true` on the tool, when older ones exist.
  Offline it searches every stored chat.
- **`server start` runs `serve` in the background when no unit is installed**, as its own process with a
  log in `<state>/serve/<profile>.log`, and answers only once `serve` is listening — the lock now records
  `listeningAt`. With a unit it goes through systemd or launchd. `server stop` signals only a serve that
  `server start` started (its environment says so); one started by hand is named and left alone.
- **Sentences for a person** from every `server` subcommand; `--json` keeps the data.
- **Speech recognition on this machine, shared by every messenger CLI.** `modelsCommand(messenger)`
  adds `models audio list|download <id>`: Parakeet v3 (25 languages), GigaAM v3 and GigaAM v3 CTC
  (Russian), each pinned to one commit and checked by sha256, run with sherpa-onnx — moved from
  max-cli. The models live in one folder for every CLI (`<cache>/cli-messaging/models/audio`,
  moved by `MESSAGING_CACHE_DIR`), so one download serves them all. **Parakeet is first by default**;
  a CLI puts its own first with `Messenger.speechModels` — max-cli would pass `["gigaam-v3"]`.
- **`messages transcribe` chooses between the messenger and this machine.** The profile's
  `transcribeWith` is `auto` (default: the messenger, and the local model when it refuses the
  account), `messenger` or `local`; `speechModel` picks the model. `--local` and `--model <id>` on
  the command, `local` on the tool. The answer says `via` (the provider, or `local`) and `model`.
  Nothing ever downloads a model by itself: a missing one is refused with the command that does.

### Fixed

- **A launchd agent no longer starts at the next login just because `server install` wrote it.** launchd
  loads every agent in `~/Library/LaunchAgents` at login, so the file is written disabled; `server start`
  enables it and `server stop` disables it again.
- **`serve`'s log no longer says "Ctrl-C to stop"** — it says which profile it listens for.

## 0.39.0 — 29.09.2026

### Added

- **`messages forward <chat> <message> --to <chat> [--silent]`** forwards one message, and
  `--allow-send` adds its MCP tool `<cli>_messages_forward`. The send guard checks it as a `forward`
  against the chat it goes to — the recipient list and the hourly limit apply there — and the
  confirmation form shows both chats. The answer is the copy in the target chat. An adapter offers it
  with the optional `forward`. There is no retry handle: after an unknown outcome, look in the target
  chat before forwarding again.

## 0.38.0 — 29.09.2026

### Added

- **`review`**, max-cli's: every message, the owner's too, in each chat that changed since `--since`
  (three days without it), cut at the chat list's newest message so `until` is where the next review
  starts. `--chat` reads one chat, `--unanswered [hours]` keeps the questions nobody answered, `--all`
  takes in muted and archived chats. The `review` tool and the `review` prompt answer the same.
  History pages backwards from the newest message, so a chat cut short keeps its newest 300 and the
  review says it is incomplete. A messenger that knows a group's admins offers the optional `admins`,
  and their answers count too.

## 0.37.0 — 29.09.2026

### Added

- **`messages transcribe <chat> <message>` and the MCP tool `<cli>_messages_transcribe`** turn a
  voice or video note into text with the messenger's own speech recognition, through the new
  optional adapter method `transcribe?()` (`Transcript`). `pending: true` means the messenger was not
  finished; the command says so on stderr.

### Fixed

- **The photo tool's refusal names a command that runs**: `messages download <chat id> <message>`,
  with the chat resolved to its id, not the words the caller typed. Its text part says `chatId`.

## 0.36.0 — 29.09.2026

### Changed — may break callers

- **Every `MessageStore` method returns a `Promise`**, `close` included, so a store that is not
  SQLite can stand behind the same interface later. The work passed to `withStore`, and an MCP
  tool's `stored`, return a `Promise` too. A caller adds `await`; one that keeps a store open around
  its own work writes `return await work(store)` inside `try/finally`, or the store closes before
  the work finishes. A refusal — a search too short, a `find` with neither text nor sender, a
  `message` id two chats share — is now a rejected promise: a `try/catch` without `await` no longer
  catches it.

## 0.35.0 — 29.09.2026

### Added

- **The MCP photo tool, `<cli>_messages_photo`**, answers a message's photo as image content, up to
  512 KB, with the chat, message id and size as text. A larger photo, a file, a video or a voice
  message is refused with the `messages download` command that saves it. A tool answer may now be a
  `Picture` rather than JSON.

## 0.34.0 — 29.09.2026

### Added

- **`inbox` leaves out muted and archived chats** unless they mention the owner or reply to them;
  `--all`, and `all` on the `inbox` tool, take them in. The answer's `quiet` counts the chats left out,
  and a note says so. On the owner's Telegram account 83 of 88 unread chats were muted.
- **`Chat` gains `muted`, `archived` and `unreadMentions`**, each absent where the messenger does not
  say. A messenger fills them in its adapter.

## 0.33.1 — 29.09.2026

### Fixed

- **`service install` writes a `$` in a path as itself in `Environment=`**, where systemd gives it no
  meaning; it was doubled, which changed the path. `ExecStart=` still doubles it. On macOS `install`
  now creates the folder the agent's log goes to, which launchd does not create.
- **`backfill status` and `backfill cancel` confirm that a job's PID is still the job** — its
  environment names the job — before calling it running or signalling it. A PID is handed out again
  after a crash or a reboot; `cancel` could have sent SIGTERM to an unrelated process, and `status`
  reported such a job as running. Unconfirmed, it is `died`. Linux and macOS.

## 0.33.0 — 29.09.2026

### Added

- **`messages edit <chat> <message> [text]`** changes the text of the owner's own message, and
  `--allow-send` adds its MCP tool `<cli>_messages_edit`. Both go through the send guard as an `edit`:
  the profile's `allow`, the recipient list, the hourly limit, and a journal line without the text.
  An adapter offers it with the optional `edit`; without it the command says the messenger cannot edit.
- **`guardedWrite`** (`./sends`): check, act, then record on every outcome — the shape of a write
  that is not a message send.

## 0.32.0 — 29.09.2026

### Added

- **`messages send --silent`, `--no-preview` and `--md`**, and `silent`, `no_preview` and `markdown` on
  the MCP send tool. They reach the adapter as `SendOptions` (`silent`, `noPreview`, `markup`).
  `--md` reads the same inline marks as max-cli's — `**bold**`, `_italic_`, `~~struck~~`, `` `code` `` —
  and `parseMarkdown` is exported, so a messenger formats one message alike. An adapter that cannot
  honour one of these options should refuse the send, not drop the option.

## 0.31.0 — 29.09.2026

### Added

- **`qrPng(link, scale?)`** — the login QR code as a PNG image, beside `terminalQr`, for a CLI to write
  to a file an agent can pass on. 8-bit greyscale, 8 pixels a module by default, written with
  `node:zlib` and no new runtime dependency.
- **`doctor report` and `doctor report create [--run <id>] [--output <file>]`** — a problem report
  as one JSON file: what `doctor` answers, the failed run's requests (the newest, or the one named) and
  the last 20 send attempts. Every chat, message and account id becomes a label salted per report, the
  home folder becomes `~`, and a run event keeps only its named fields — never message text, a title,
  a name, a phone number or the session (copied from max-cli). `AppIdentity.issues`, when set, is where
  the report says to send it.
- **`messages search --regex <pattern>`** — the words are one regular expression, case-insensitive,
  tested against every stored message's text, newest first, until `--limit` match. No index serves it
  and the store is unchanged: it reads the chat (`--chat`) or the whole account a chunk at a time.
  `MessageFilter.pattern` does the same for a caller of the store.
- **`export <chat> --format markdown`** — the chat as a transcript a person reads: a heading per day,
  `hh:mm Name`, replies and forwards quoted, attachments as links, control characters shown rather than
  obeyed (max-cli's `toMarkdown`). A reply Telegram sent only the id of is quoted from the export when
  that message is in it. Any other `--format` is refused; `--json` and `--jsonl` stay the data formats.
- **`backfill <chat> --estimate`** — how many messages, requests, runs at `--max` and seconds a full
  backfill would still take, from the store alone: no request. Message ids leave gaps, so the ids not
  held are priced at the density of the stretches held — an estimate, and FloodWait comes on top. With
  nothing held of the chat, `missing` is `null` and the note says to run a small backfill first.

## 0.30.0 — 29.09.2026

### Added

- **`backfill --background` runs a backfill as a job that outlives the command**, and `backfill list`,
  `backfill status [job]` and `backfill cancel <job>` follow it. A job is a detached process with a
  record and a log under the state folder (`backfill/<job>.json`, `.log`); the record holds its progress
  after every page and how it ended, and `status` adds the stretches the store now holds of the chat.
  One job per chat at a time. The job gets the profile pinned and none of the shell's `<PREFIX>_TIMEOUT`.
- **`serviceCommand(messenger)` — `service install|uninstall|start|stop|status|logs`** runs `serve` as a
  user service: a systemd user unit on Linux, a launchd agent on macOS, one per profile. `install` only
  writes the file — nothing starts or enables it until `service start`, so serve never starts by itself. The unit runs the same
  node binary and script that installed it, with the profile and the location variables
  (`<PREFIX>_CONFIG_DIR`/`_STATE_DIR`/`_CACHE_DIR`, `MESSAGING_STORE`) of that shell, so a unit written
  from a development checkout opens that checkout's files. `status` reads the unit and the serve lock.

- **`messages download <chat> <message> [--output dir]`** saves every file of one message into a
  folder (the current one by default, created if missing) and answers each file's path and size.
  A name another person chose is stripped of folders, a leading dot and control or direction
  characters; a file already there is never overwritten. The adapter supplies the bytes through the
  new optional `download?()` method (`Download`, `RemoteFile`); a messenger without it refuses.

### Fixed

- **`backfill` stops cleanly on Ctrl-C or SIGTERM** — which `backfill cancel` sends — after the page in
  hand, keeps it, and answers `"stopped": true`. It was killed mid-page before.

## 0.29.1 — 29.09.2026

### Fixed

- **`messages list --jsonl` and `messages search --jsonl` print one message per line**, as `inbox`,
  `watch` and their own `--help` promise. They printed the whole page as one JSON line. A script that
  worked around it by reading `.items` from that line must now read each line as a message; the hint
  about older messages goes to stderr.

## 0.29.0 — 29.09.2026

### Fixed

- **Depends on `@leemour/cli-core` 0.8.0** (was 0.7.0), the version max-cli uses. With two versions a CLI
  installed two copies, and `isCliError()` — an `instanceof` check — did not recognise an error made by
  the other copy.

Nothing in the package yet. The repository gained a coverage floor, `pnpm test:slow`,
`pnpm docs:check` and developer docs, and `bin/release` takes the next free version itself.

## 0.28.0 — 29.09.2026

### Added

- **A read across a chosen list of accounts.** `accounts` in a message filter and in `people()`
  names several accounts of one provider by native id — max-cli's `--bots a,b`. A list without its
  provider is refused, so a read is never across every account by accident.

### Changed — may break callers

- **Message search finds any three letters inside a word** (store migration 5 rebuilds the index
  with the trigram tokenizer). Every word of three characters or more must appear; shorter ones are
  ignored, and a query of only short words is refused.

## 0.27.0 — 29.09.2026

### Added

- **A new `MessengerAdapter` method is optional** and reached with `capability()`, which refuses
  with `validation_error` rather than crashing when the adapter lacks it. `observed` and `stored`
  pass through any method they do not list, so an adapter's new method needs no wrapper edit.
  Inside, the shared commands and the MCP tools are one file per resource; the exports and the
  behaviour are unchanged.

## 0.26.0 — 29.09.2026

### Changed — may break callers

- **People are kept per account** (store migration 4, `account_identities`). An identity stays one
  per provider, and which account has seen it is a row of its own, so one bot's people are not
  another's. `savePeople` takes an `AccountKey` instead of a `Provider`, and `people()` reads through
  the account.

## 0.25.0 — 29.09.2026

### Added

- **`inboxCommand`**: other people's unread messages in every chat, or with `--new` what arrived
  since the last check — each message once, the saved point moved only by a run that printed.
  `--since` takes an ISO time or `30m`/`2h`/`1d`. With the MCP tool `<cli>_inbox` and the
  `catch-up` prompt.

## 0.24.0 — 28.09.2026

### Added

- **`skillCommand(app, url)`**: `skill show` prints the CLI's own SKILL.md for an agent.
- **MCP prompts** `reply` and `find`, and the resource `<cli>://chat/{id}` — a chat and its recent
  messages, listed from the store without connecting.

Older versions: `git log --oneline v0.23.0` and the release commits (`chore: release X`).
