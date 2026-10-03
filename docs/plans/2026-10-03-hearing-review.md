# Reuse a read connection for hearing and review voice questions before filtering

Status, 2026-10-03: proposed for owner review; no implementation. Read at cli-messaging
`ca66eb2`, MAX `04c70e4`. Read-only synthetic probes reproduced both defects: compiled CLI transcription opens two
provider connections, while unanswered review drops a voice question before retained/fresh hearing.
Permanent failing regressions are the first implementation step. MAX task CLI-63 and the audio handoff's FIND-509.

## Goal and current state

A CLI read with local transcription should use one provider connection, download all recordings,
close it, and only then run the recognizer. Unanswered review should judge retained and newly heard
voice questions, with the existing age, reply, owner/admin and snapshot rules.

- `src/cli/messenger/messages-command.ts:65-73` finishes `withServices` before hearing;
  `context.ts:312-315` closes the held connection; `hearing-command.ts:42` opens another.
- `src/services/inbox.ts:209-223` filters unanswered questions before callers hear them;
  `review.ts:56-69` and `src/mcp/tools/review.ts:41-55` hear only the filtered messages.
- MAX `src/mcp/tools.ts:256-268` has the same order. Its existing native recognizer and
  provider-specific hearing stay in MAX.

## Decisions

1. Extend the services callback with an optional borrowed connector. Existing callbacks and context
   implementations remain source-compatible. The connector reuses the held adapter and releases it
   once after audio fetch, before local recognition; final cleanup still runs on errors. No automatic
   reconnection after a release. Services that only use the store remain lazy and offline stays offline.
2. Let CLI hearing accept that connector optionally, preserving the existing fallback for independent
   callers. Keep message list/show/context and inbox/review hearing inside the service scope. For an
   explicit mark-read, finish it on the same connection before fetching/recognizing; without the flag,
   never mark read. Do not change MCP session connection ownership.
3. Add an optional review enrichment hook. Read all candidate messages and load required admin IDs
   before calling the hook; enrich the snapshot before unanswered filtering. The predicate uses the
   transcript alongside text without rewriting the returned message text or saving synthetic text to
   the message archive. Callers retain unheard/complete diagnostics. Unenriched service callers retain
   existing behavior. No new schema, command names, permission changes or breaking stable exports.
4. Apply enrichment in shared CLI/shared MCP and MAX's legacy MCP wrapper; keep filtering in the shared
   service. Preserve chronological order, replies, age boundaries, muted-chat rules, caps and snapshot.

## Work and tests

1. Add failing synthetic regressions: one login for fresh transcription, download before close and
   recognition after close; retained and freshly heard voice questions survive unanswered filtering;
   owner/admin answers remove them, even when hearing closes the connection; incomplete hearing keeps
   review incomplete. Record what fails before the fix.
2. Implement scope connector and optional hearing injection; integrate read callers. Cover cached,
   model-missing, offline, multiple voice, explicit mark-read, fetch/recognizer failure and cleanup.
3. Implement review enrichment and transcript predicate; integrate CLI and both MCP paths. Assert
   original text and transcript output separately, caps/snapshot and unknown-admin fallback unchanged.
4. Run library lint/typecheck/coverage/docs/build/Node+Bun dist checks/Bun smoke; rebase, PR, CI, merge.
   Release with the documented cadence; if MAX adoption is blocked, identify the consumer truthfully.
5. MAX exact pin, consumer CLI/MCP regressions, backlog/changelog/docs, generation/matrix/parity and
   coverage/Bun/platform CI. Merge only owned PRs. Do not change Telegram's checkout.
6. Prepare the next MAX release including already merged audio catalogue/installer and provider-owned
   Markdown. Audit docs against all changes, run release:check and the owner-approved live scope,
   record limitations and delegated sign-off, publish and verify npm/tag/GitHub/installed version.

## Live scope and open questions

Owner approval of this plan is required by MAX's working rules. New Markdown live scope is specified
in MAX's private companion plan; synthetic tests do not need model downloads or real stores.
Merge/release and delegated signature authorization already exists in the session. No new product
choice is proposed. No P7 migration, real-model download, store migration or production bot writes.
