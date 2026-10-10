# Cross-source knowledge metadata

The `./store` export provides `MessageStore.knowledge`, over the same SQLite connection as messages,
people and tasks. Every operation takes an explicit `AccountKey`; it never connects to a messenger.
Its rows are the store's tables ([`schema.md`](../storage/schema.md)): an annotation is a `notes` row
about its target, a label a `taggings` row, a relationship a `links` row, a reminder a `reminders` row.

## Annotations and labels

`addAnnotation`, `annotation`, `annotations`, `editAnnotation` and `removeAnnotation` support message
locators, chats, contact identities, persons, tasks, organizations, projects, notes and documents. The
target is the note's subject (`notable_type`/`notable_id`); a contact note is a note about an `identity`. An
annotation has
a stable ID, owner authorship, creation/update times and a revision. Edits require the current revision.
Listing accepts an optional target, literal text, limit (1–500) and offset (0–100000).

Source annotations survive source edits and deletion. Reads report `available`, `deleted` or
`unavailable`, resolving the source now; no source excerpt is copied into the annotation record.
Explicit account purge removes that account's metadata. Existing private contact note IDs remain
readable/editable through both interfaces. Legacy contact notes retain their existing identity-purge
policy; general source annotations retain their target reference when an identity disappears.

Labels on messages/chats/identities reuse the messenger tags. Labels on a person, task, organization,
project, note, document or notes folder are taggings on that row; a subfolder's label is a `labelled` link
from the folder, anchored at the path. A tag of kind `topic` is made by the owner only (`createTag` refuses
an agent's: it goes to `proposedActions`), its name is never also a tag's, and `setMainTopic` marks one
topic per thing as its main one. A reference from the old `messages.db` (a ULID, `entity:`) resolves as not found. A
message or chat reference of an `email` account names the email or the email thread in the mail tables,
and falls back to a message or chat saved before mail had tables of its own. They are explicit metadata and do not
automatically relabel every linked identity or its messages. `labelled` returns references, labels,
current target state and truthful pagination. Identity link/unlink does not silently transfer or
duplicate owner annotations, labels or relationships attached to a different person UID.

## Relationships

`addOrganization` creates a company, team, family or community; `addProject` a project with its task key
(made from the name when none is given) and type. `relate` records manual `member-of`
or `related-to` links between explicit references, with optional role/evidence. `assigned-to` links
a task in the selected account to an explicit canonical person UID, including document tasks whose
account has no contact roster. A relationship is a confirmed owner statement or an explicitly
unconfirmed weak suggestion with provenance. `confirmRelation` records owner acceptance; weak
suggestions are excluded from confirmed person/task context. Domain matching never links identities.
Listing/removal are account-scoped. Repeating the same relation preserves
its ID; remove and add again to correct its role/evidence. References stay on their original UID
through identity linking and splitting, so correction is explicit rather than guessed.

## Local reminders

Reminders point only at tasks (`tasks.id`; callers name a task by the task package's id or its key) and store an absolute ISO instant plus an IANA display timezone.
`schedule` requires an open task; the same active task/time returns the existing reminder.
`claimReminders` leases due work, bounded at 500 deliveries, with compare-and-set updates so competing
workers cannot claim the same live lease. Expired leases can be retried with a new receipt.
The host deduplicates by reminder ID and revision. `acknowledgeReminder` accepts only the current
receipt before lease expiry; repeating an already completed acknowledgement is idempotent.

Snooze requires the current revision and creates a new delivery identity. Cancellation invalidates
receipts. Closing a task cancels pending/leased reminders through a trigger. State survives restart.
Delivery is a host decision: this store makes no outbound messenger/email call and sets no system timer.
An import timer does not authorize outbound reminder delivery.

## Decisions, memories and what agents do

`decisions` holds choices with their evidence (`links` of kind `evidence`): an agent's waits as proposed,
the owner's is accepted at once, and accepting one that supersedes another ends the older. `memories`
holds what agents concluded — summary, digest, fact, preference — with author bot and model, confidence,
status and a scope that has no default: a memory without scope or evidence is refused. Memories have their
own words index. `proposedActions` keeps what an agent wants done outside the store until the owner
approves or rejects it; a messenger adapter executes an approved one and reports `executed` or `failed`.
The payload may hold a reply's text, shown to the approver and never logged. `agentActions` is the audit
trail: the MCP server writes one row per tool call (tool, tier, outcome code, times), never its arguments.

## Document extraction

`./documents` exposes `extractText`, `importEngine`, limits and extraction types. Markdown/TXT/CSV/TSV
use UTF-8 text. PDF and DOCX reuse the optional `unpdf` and `mammoth` engines; XLSX and other modern office formats use the existing bounded built-in readers and preserve sheet/cell addresses. PDF results expose page spans. Missing engines,
unreadable files, scans requiring an agent, unsupported formats and oversized inputs are distinct.
Legacy DOC/XLS and automatic OCR are not advertised as supported formats.
