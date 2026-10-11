# Messenger feature gaps

Proposed, not claimed. Slices 1, 2 and mute are owned by other plans (see Ownership). Each slice below is its own docs PR, then code PR, per
[REVIEW.md](../dev/REVIEW.md).

## Goal and evidence

The docs site's Features page (wirecat.dev `/docs/features`) names the gaps a user looks for. This
plan closes the ones worth closing, in value-for-effort order, shared where both CLIs can do it.

Evidence, read at tg-cli `5168117`, max-cli `8888844`, cli-messaging `99c8793`, mtcute 0.32.3
(layer 229):

- Both `messages search` commands read only the local store:
  `src/cli/messenger/messages-search-command.ts:11` ("never asks the messenger").
- tg refuses more than one `--file` in a message: tg-cli `src/telegram/adapter.ts:354`. The shared
  option is already repeatable (`parity.json:161-163`) and max sends several uploads in one
  message (max-cli `src/adapter/max-adapter.ts:286-288`).
- The shared model has no button, keyboard or callback field (`src/domain/models.ts`, tg `map.ts`).
- No `parity.json` row exists for drafts, location, typing, video notes, stories, clearing a chat,
  cloud password or server-side search.
- Coverage measured the same day: tg calls about 62 of 813 MTProto methods (58 of 357 in
  messages, channels, contacts, users, photos); max sends 42 of about 152 opcodes known from
  community lists. The owner decided (2026-10-04) not to publish a percentage; the feature list
  and its gaps are the public statement.

## Ownership: what other plans already cover

Three of these gaps already have an owner. This plan does not duplicate them; it records the
decisions taken here and points there.

| Gap | Owner | Where |
|---|---|---|
| Server-side search | search lane | `--backend archive\|server\|both` on `search messages` and `search all` (messages only there), default `both` — first decided 2026-10-04 (max-cli private `docs_ai/journal/2026-10-04-competitor-parity.md`, NEED-563) |
| Drafts | Telegram actions, G4 (B3) | local draft revisions, publish/pull |
| Mute and notification settings, remote media search | Telegram actions, G3 (B4) | same plan, §3 and §4 G3 |

Slices 1, 2 and the mute half of 4 below are therefore coordination notes, not work to start
from this plan. Slices 3, 4 (archive), 5, 6, 7 and 8 have no other owner.

## Rules every slice follows

- [STANDARD.md](../dev/STANDARD.md): `<resource> <verb>` with a listed verb (lines 27-49);
  permissions (314-368); MCP (370-385); documents (423-442); parity manifest (444+). **A new verb
  or option needs the owner's yes.**
- Docs PR first: `parity.json` option(s) → `pnpm parity:render`, manifest row `planned`, both CLIs'
  user pages at the same depth (max in Russian, tg in English).
- Code PR: command and MCP tool call one service; service calls a port group; a new port method
  goes in a named optional group in `src/cli/messenger/port.ts`, never the core. Tests go through
  the command and include a failure path. `## Unreleased` changelog entry. The manifest row turns
  `in` only when the command is on that CLI's `main`.
- Every write: a `SendKind` or `AccountAction` (`src/sends/journal.ts:11,32`), a key in
  `src/sends/permissions.ts` (26-38, 173-185), the one-key-per-command test
  (`src/cli/messenger/permission-keys.test.ts`). Anything that cannot be undone defaults to `ask`
  (`permissions.ts:66-71`). The send guard is `src/sends/guard.ts`.
- Per CLI: `pnpm generate` (commands.md), test matrix, skill (`skills/<tool>-cli/SKILL.md`),
  `pnpm parity:check`, `pnpm docs:check`; the MCP tool ships in the same PR as the command
  (tg-cli `HANDOFF.md` §3b.5).
- MAX: each new opcode gets a row in max-cli `docs/dev/protocol.md` saying what it rests on
  (claim, source or capture). A MAX write is measured in Saved Messages first and needs the
  owner's yes (max-cli `docs/dev/BACKLOG.md`, "From the PyMax comparison").
- Releases: at most one cli-messaging release every 2 hours (`CLAUDE.md`).

Shared examples to copy: `src/cli/messenger/polls-command.ts` (`annotate(..., {mutates: true})`,
`capability(...)`), `messages-send-command.ts`, `admin-folders-command.ts`; MCP tools in
`src/mcp/tools/*.ts`, registered in `src/mcp/tools.ts`; guarded writes in `src/sends/polls.ts`
and `src/sends/guarded.ts`. tg: `src/telegram/adapter.ts` + `map.ts`, registered in
`src/program.ts:72-76`. max: `src/spec/operations/*.ts` → `pnpm generate` → `src/client.ts` →
`src/adapter/max-adapter.ts`, registered in `src/program.ts:69-75`.

## Slices, in order

### 1. Server-side search — both, shared (owned by the search lane)

Today an agent can search only what was fetched; a question about an unfetched month needs a
fetch first.

- Shape: `search messages` and `search all` take `--backend archive|server|both`, default `both`;
  `search all` asks the server for messages only, mail and notes stay local. `--source` keeps
  meaning which messenger or account. Each hit says where it came from.
- tg: mtcute `searchMessages` / `searchGlobal`. Easy.
- max: opcode 73 `{query, count, chatId}` (max-api-docs `protocol/messaging.md:946`, a claim).
  Measure first. Leave 68 and 60 out: sources disagree on what they are.
- Guard: read, `messages`.
- Decided 2026-10-04: a `live` result is also written to the local store, as `messages list`
  already does, so the next archive search finds it.

### 2. Drafts — both, shared (owned by Telegram actions G4, B3)

The agent writes the reply into the chat's draft; the person reads it and presses send.

- tg: `saveDraft(chat, draft | null)`; raw `messages.getAllDrafts` to list. Easy.
- max: 176 is a name only, no payload anywhere; 177 was captured as `{userId, time:0}`
  (`docs_ai/captures/2026-09-25-res-10.jsonl:278`), which looks like a user lookup, not a
  discard. Stays `planned` until a capture of the web client saving a draft.
- Guard: a write the other person never sees, but still its own key (for example `drafts`).
- Decided 2026-10-04: the first user-facing shape is `messages send --draft` — it puts the text
  into the chat's draft instead of sending. No new verb. G4's local revisions and publish/pull can
  build on it; agree with G4 before any code so it is one design, not two.

### 3. Albums — tg only

- tg adapter: allow several `--file` in one message through raw `messages.sendMultiMedia` with
  random ids derived from the send id. mtcute's `sendMediaGroup` makes its own random id per item
  (`highlevel/methods/messages/send-media-group.js:47`), which breaks "repeating a send id leaves
  one copy".
- `Sent` returns one message; the album returns several — the result shape changes for this case.
- Guard: `messages.send`, normal send guard; each item counts toward the hourly limit (decide).
- Medium. Remove the line from tg's roadmap and "Not in tg yet" when it ships.

### 4. Archive and mute — `chats update --archived` / `--muted` (mute owned by G3, B4)

No new verb: the same pattern as `--all-can-pin`.

- tg: `archiveChats` / `unarchiveChats`; raw `account.updateNotifySettings` for mute. Easy.
- max: no known opcode for either. Mark the options unsupported there (or `planned` after a
  capture).
- Guard: `chats.update`.
- Mute belongs to G3's notification-settings slice; agree the option there. `--archived` can go
  ahead alone.

### 5. Typing and location — both, shared

- Typing: tg `sendTyping`; max 65 `{chatId, type}`, captured
  (`res-10.jsonl:274`); the server acknowledges any payload, so success proves nothing. A write
  the other person sees: its own key (for example `messages.typing`).
- Location: tg `InputMedia.geo` (`input-media/factories.d.ts:68`); max coordinates in the
  `MSG_SEND` body or a `LOCATION` attachment (max-api-docs `messaging.md:298-321`, a claim) —
  measure in Saved Messages. Probably `messages send --location <lat,lon>`. Guard: `messages.send`.

### 6. Pressing buttons in bot messages — shared model first

- The shared model gains buttons (text, kind, callback data) on a message; tg `map.ts` fills them.
- tg: `getCallbackAnswer({chatId, message, data})`. Never pass its `password` parameter.
- max: opcode 118 appears only in PyMax's enum; no capture shows callback buttons. tg-only first.
- Guard: a guarded write with the recipient list, default `ask`: a button can confirm or pay.
- Decision needed: the verb (not on the list today) and the command shape.

### 7. MAX cloud password, then video notes — max only, CLI only

- Cloud password: 112 → 107 → 111 flow (PyMax `src/pymax/api/auth/service.py:291-456`,
  payloads `auth/payloads.py:100-123`; tsmax `src/api/auth.ts:200-224`). Typed at a prompt, never
  an argument, never an MCP tool. Default `ask`. On the MAX roadmap (`docs/roadmap.md:14`).
- Video notes: backlog MAX-48 has the payload (opcode 82 `{type:1, uploaderType:1}`,
  `videoType:1`) and the encoding limits (`docs/dev/BACKLOG.md:43`). Guard: `messages.send`.
- tg has cloud password helpers (`enable/change/removeCloudPassword`) if parity is wanted later.

### 8. Later, or only after a ruling

- **Clear chat:** tg `deleteHistory` is easy; max 54 has no payload. Close to the ruling that left
  chat deletion out (max-cli `src/generated/opcodes.generated.ts`, comment on `CHAT_DELETE`), and
  clearing for everyone conflicts with "an agent never deletes for everyone". Owner decides first.
- **Stories, reading:** tg has helpers; max 208/209 are captured. Never call `readStories` or
  `incrementStoriesViews` — the story's owner sees the view. Posting is a separate decision.
- **Privacy settings:** tg-local at the lowest priority; risky (can expose the phone number).

### Not doing

Secret chats (no end-to-end support in mtcute: we would write key exchange, encryption and key
storage, and the chat is bound to one device) and calls (no voice or video stack). The docs say so.

## After each slice

- Update the docs site's Features page (cli-docs `content/docs/features.md`): add the row, remove
  the gap from "Not there yet".
- Update each CLI's roadmap.

## Decisions for the owner

Taken: server search is `--backend archive|server|both`, default `both`, and server results are
stored locally (slice 1); drafts start as `messages send --draft` (slice 2).

Open:

1. Whether album items count once or per item toward `sendsPerHour` (slice 3).
2. A verb for pressing a button (slice 6).
3. Whether clear chat is allowed at all (slice 8).
