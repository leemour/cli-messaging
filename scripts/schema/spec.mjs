import { readFileSync } from "node:fs"

const scratch = process.env.SCRATCH ?? new URL(".", import.meta.url).pathname
const info = JSON.parse(readFileSync(`${scratch}/info.json`, "utf8"))
const docs = JSON.parse(readFileSync(`${scratch}/docs.json`, "utf8"))
const current = new Map(info.tables.map((t) => [t.name, t]))

const TYPE = { INTEGER: "integer", TEXT: "text", REAL: "real", BLOB: "blob" }
const ruleName = (name) =>
  name === "pk"
    ? "id"
    : name === "native_id"
      ? "external_id"
      : name === "provider_metadata"
        ? "metadata"
        : name.replace(/_native_id$/, "_external_id").replace(/_pk$/, "_id")

// Per-table edits to today's tables. `cols` renames beyond the rule, `drop` removes, `add` appends.
const EDITS = {
  accounts: {
    doc: "Every integration the owner connects: a messenger account, a mailbox, Zoom, a notes folder.",
    add: [
      ["settings", "text", { note: "JSON: per-integration settings, e.g. a folder's path and format" }],
      ["status", "text", { note: "active, paused, failed" }],
      ["updated_at", "integer", { notnull: true }],
      [
        "scope",
        "text",
        {
          notnull: true,
          note: "`personal` or `work`; what a context query may read for a given purpose, so a work question never pulls private chats",
        },
      ],
      ["organization_id", "integer", { ref: "organizations.id", note: "the organization a work account belongs to" }],
    ],
    note: "Gains the integrations that were tables of their own (`note_folders`).",
  },
  persons: { cols: { is_self: "owner" }, drop: ["uid"], note: "`uid` goes: `id` everywhere (owner)." },
  identities: { cols: { is_bot: "bot", first_seen_at: "created_at" } },
  identity_links: {
    cols: { linked_at: "created_at", linked_by: "author" },
    add: [
      ["source", "text", { note: "which integration or importer proposed it" }],
      ["updated_at", "integer", { notnull: true }],
    ],
  },
  identity_link_events: { cols: { at: "created_at", by: "author" } },
  identity_revisions: { cols: { captured_at: "created_at" }, keys: ["INDEX (identity_id, created_at)"] },
  account_identities: { cols: { first_seen_at: "created_at" }, add: [["updated_at", "integer", { notnull: true }]] },
  contact_aliases: {
    rename: "aliases",
    replaceCols: [
      ["id", "integer", { pk: true }],
      [
        "aliasable_type",
        "text",
        {
          notnull: true,
          note: "what the alias names: `identity`, `person`, `organization`, `chat`, `project`, `bot`, …",
        },
      ],
      ["aliasable_id", "integer", { notnull: true }],
      [
        "account_id",
        "integer",
        {
          ref: "accounts.id",
          note: "set when the alias holds only as seen from one account, as a contact name in one messenger does; null when it holds everywhere",
        },
      ],
      ["name", "text", { notnull: true, note: "the alias as written: a nickname, a short name, a former name" }],
      ["name_folded", "text", { notnull: true, note: "`name` folded for matching: lower case, accents removed" }],
      [
        "display",
        "integer",
        { notnull: true, note: "1 for the alias to show instead of the real name; at most one per thing and account" },
      ],
      ["source", "text", { notnull: true, note: "owner, agent, an import" }],
      ["created_at", "integer", { notnull: true }],
      ["updated_at", "integer", { notnull: true }],
    ],
    keys: [
      "UNIQUE (aliasable_type, aliasable_id, ifnull(account_id, 0)) WHERE display = 1",
      "INDEX (aliasable_type, aliasable_id)",
    ],
    doc: "Other names for anything: a person's nickname, a contact's name in one messenger, a project's short name. Search and name matching read them.",
    note: "`contact_aliases` → `aliases`, polymorphic (owner); several aliases per thing, one of them shown.",
  },
  chats: {
    cols: { is_searchable: "searchable", members_tracked_at: "members_tracked_at" },
    add: [
      ["description", "text", { note: "the chat's description, as the messenger gives it" }],
      ["details_fetched_at", "integer", { note: "when title, username and description were last read" }],
      ["created_at", "integer", { notnull: true }],
      [
        "parent_chat_id",
        "integer",
        {
          ref: "chats.id",
          note: "the chat this one sits inside: a forum topic in its group, a channel's discussion group, a channel in a workspace",
        },
      ],
      ["scope", "text", { note: "overrides the account's scope for this chat; null takes the account's" }],
    ],
    note: "`chat_metadata` merged in (owner).",
    keys: ["INDEX (account_id, last_message_at DESC)"],
  },
  chat_members: { add: [["created_at", "integer", { notnull: true }]] },
  member_stays: {
    cols: { gone_at: "left_at", invited_by_pk: "invited_by_identity_id" },
    add: [
      ["created_at", "integer", { notnull: true }],
      ["updated_at", "integer", { notnull: true }],
    ],
    keys: ["UNIQUE (chat_id, identity_id) WHERE left_at IS NULL"],
  },
  member_counts: {
    cols: {
      day: "date",
      participants: "reported_count",
      listed: "listed_count",
      complete: "complete_list",
      at: "created_at",
    },
    colNotes: {
      date: "`YYYY-MM-DD`, UTC; SQLite has no date type",
      reported_count: "the count the messenger reports",
      listed_count: "how many members one read actually returned",
      complete_list: "whether that read returned the whole list",
    },
    note: "Renamed so each column reads on its own (owner).",
  },
  messages: {
    cols: { ingested_at: "created_at", ingested_via: "source" },
    add: [
      ["updated_at", "integer", { notnull: true }],
      [
        "thread_root_id",
        "integer",
        {
          ref: "messages.id",
          note: "the message a thread hangs from: a Slack thread, comments under a channel post, replies in a topic; null outside a thread",
        },
      ],
    ],
    keys: [
      "INDEX (chat_id, sent_at DESC)",
      "INDEX (chat_id, reply_to_external_id) WHERE reply_to_external_id IS NOT NULL AND deleted_at IS NULL",
      "INDEX (account_id, external_id)",
      "INDEX (id) WHERE normalized_text IS NULL AND deleted_at IS NULL",
    ],
  },
  message_revisions: { addPk: true, cols: { captured_at: "created_at" } },
  message_links: {
    addPk: true,
    add: [["updated_at", "integer", { notnull: true }]],
    keys: ["UNIQUE (message_id, ifnull(parent_id, 0), source, kind, ifnull(build, 0))", "INDEX (chat_id, build)"],
  },
  message_counter_observations: { cols: { observed_at: "created_at" } },
  attachments: {
    drop: ["message_pk"],
    prepend: [
      ["attachable_type", "text", { notnull: true, note: "`message`, `email` or `meeting`" }],
      ["attachable_id", "integer", { notnull: true }],
    ],
    add: [
      ["text", "text", { note: "the text extracted from the file" }],
      ["normalized_text", "text"],
      ["extraction", "text", { note: "how the text was got: `text`, `ocr`, `agent`, `failed`" }],
      ["extractor", "text"],
      ["extraction_error", "text"],
      ["content_sha256", "text"],
      ["extracted_at", "integer"],
      ["created_at", "integer", { notnull: true }],
      ["updated_at", "integer", { notnull: true }],
    ],
    doc: "A file of a message, an email or a meeting, with its extracted text.",
    keys: ["UNIQUE (attachable_type, attachable_id, position)"],
    note: "Polymorphic (owner: attachments serve messages and mail); `attachment_texts` merged in; meeting files land here too.",
  },
  transcripts: {
    rename: "message_transcripts",
    addPk: true,
    cols: { message_native_id: "message_external_id" },
    prepend: [["message_id", "integer", { ref: "messages.id", note: "set once the message is stored" }]],
    add: [
      ["created_at", "integer", { notnull: true }],
      ["updated_at", "integer", { notnull: true }],
    ],
    note: "Renamed and linked to its message (owner); still keyed by chat + external id, because a voice message can be heard before it is stored.",
  },
  sync_state: {
    rename: "sync_cursors",
    cols: { at: "updated_at" },
    add: [["created_at", "integer", { notnull: true }]],
  },
  sync_ranges: {
    add: [
      ["created_at", "integer", { notnull: true }],
      ["updated_at", "integer", { notnull: true }],
    ],
  },
  conversations: {
    add: [
      ["created_at", "integer", { notnull: true }],
      ["updated_at", "integer", { notnull: true }],
    ],
    keys: ["INDEX (chat_id, build, first_at)"],
  },
  searches: {
    add: [["updated_at", "integer", { notnull: true }]],
    keys: ["UNIQUE (command, params) WHERE name IS NULL", "INDEX (last_run_at DESC)"],
  },
  tags: {
    replaceCols: [
      ["id", "integer", { pk: true }],
      [
        "name",
        "text",
        { notnull: true, unique: true, note: "unique across tags and topics, so one name is never both" },
      ],
      [
        "kind",
        "text",
        {
          notnull: true,
          note: "`tag`: a free label; `topic`: what a thing is about, from a short list only the owner creates (agents propose)",
        },
      ],
      ["created_at", "integer", { notnull: true }],
      ["updated_at", "integer", { notnull: true }],
    ],
    doc: "A tag's name, stored once. Which things carry it is `taggings`.",
    note: "Split into `tags` + `taggings` (owner).",
  },
  auto_tag_claims: {
    cols: { tag: "tag_id" },
    colTypes: { tag_id: "integer" },
    colRefs: { tag_id: "tags.id" },
    add: [["updated_at", "integer", { notnull: true }]],
  },
  links: {
    pkInteger: true,
    drop: ["from_ref", "to_ref"],
    prepend: [
      ["from_type", "text", { notnull: true }],
      ["from_id", "integer", { notnull: true }],
      ["to_type", "text"],
      ["to_id", "integer", { note: "null while the link names nobody yet" }],
    ],
    cols: { origin: "source", provenance: "metadata" },
    colNotes: { kind: "the connection; the kinds are listed in the table's description" },
    add: [
      ["author", "text", { note: "`owner`, `agent`, `rule`" }],
      ["updated_at", "integer", { notnull: true }],
    ],
    keys: ["INDEX (target_folded) WHERE to_id IS NULL"],
    doc: "Every connection between two things that no column holds. Kinds: `links-to` (a document or note links to something, as written in it), `about` (a note or document is about a person, project, …), `member-of` (a chat or person belongs to a project or organization), `labelled` (a folder account → a tag, the subfolder's path in `anchor`, so every document under it carries the tag), `answered-by` (a question task → the message that answered it), `evidence` (a decision or memory → its source), `created-from` (a thing → what it was made from). Kinds the store does not write yet: `duplicate-of` (the same question asked again), `related-to`, `assigned-to`.",
    note: "String references → polymorphic columns, type as a string (owner).",
  },
  chunk_vectors: {
    rename: "embeddings",
    note: "Renamed: one table of vectors for every chunk, found by `content_hash`.",
    doc: "One embedding vector per model and text: any chunk whose `content_hash` matches uses it.",
    add: [["updated_at", "integer", { notnull: true }]],
  },
  knowledge_reminders: {
    rename: "reminders",
    drop: ["uid", "task_id"],
    prepend: [
      ["id", "integer", { pk: true }],
      ["task_id", "integer", { notnull: true, ref: "tasks.id" }],
    ],
    note: "`uid` → integer `id`; points at a task row.",
    keys: ["INDEX (account_id, state, due_at)"],
  },
}

const DROPPED = {
  chat_metadata: "merged into `chats` (owner)",
  attachment_texts: "merged into `attachments` (one row per attachment today)",
  membership_batches: "→ `member_observations`: stays and counts alone lose a checkpoint a later roster overwrites",
  membership_batch_members: "→ `member_observation_members`",
  owner_targets: "taggings and links point at a person, organization, project, task or folder directly",
  entities: "split into `organizations` and `projects` (owner); a family or a group is an organization",
  note_folders: "become `accounts` rows of provider `folder`",
  notes: "split: files and pages → `documents`; short text about something → the new `notes`",
  note_revisions: "→ `document_revisions` and `note_revisions`",
  note_chunks: "→ `chunks` (polymorphic: documents, notes, emails, transcripts, tasks, events)",
  note_index_pending: "→ `document_index_pending`, `note_index_pending`",
  note_words: "→ `document_words`, `note_words`",
  note_stems: "→ `document_stems`, `note_stems`",
  conversation_chunks: "merged into `chunks`; the messages a piece spans are `chunk_messages`",
  tasks: "replaced by the task system below; today's kinds (question, request, mention, promise) become task types",
}

const c = (name, type, o = {}) => ({ name, type, ...o })
const id = () => c("id", "integer", { pk: true })
const ts = () => [c("created_at", "integer", { notnull: true }), c("updated_at", "integer", { notnull: true })]
const del = () => c("deleted_at", "integer", { note: "gone at the source; sync never hard-deletes" })
const meta = () =>
  c("metadata", "text", { note: "JSON: what the source sends that has no column, and is not searched" })
const fk = (name, table, o = {}) => c(name, "integer", { ref: `${table}.id`, ...o })
const poly = (name, note) => [
  c(`${name}_type`, "text", { notnull: true, note }),
  c(`${name}_id`, "integer", { notnull: true }),
]
const actor = (name, o = {}) => [
  c(`${name}_type`, "text", { note: "`person` or `bot`", ...o }),
  c(`${name}_id`, "integer", o),
]
const fts = (name, doc, cols) => {
  const words = name.endsWith("_words")
  const sql = `CREATE VIRTUAL TABLE ${name} USING fts5(${cols}, content = '', contentless_delete = 1, tokenize = 'unicode61 remove_diacritics 2'${words ? ", prefix = '3'" : ""})`
  return {
    name,
    virtual: true,
    doc,
    sql: words ? `${sql};\nCREATE VIRTUAL TABLE ${name}_vocab USING fts5vocab(${name}, 'col')` : sql,
  }
}
const queue = (name, of) => ({
  name,
  doc: `Rows of ${of} waiting to be indexed: triggers enqueue, JS normalizes, stems and writes the index.`,
  cols: [c("id", "integer", { notnull: true }), c("indexable_type", "text", { notnull: true })],
  keys: ["PRIMARY KEY (indexable_type, id)"],
})

const NEW = {
  chats: [
    {
      name: "member_observations",
      doc: "One read of a chat's member list: when, whether it was the whole list, and how many it reported and returned. Retention reads presence at a checkpoint from these.",
      cols: [
        id(),
        fk("chat_id", "chats", { notnull: true }),
        c("observed_at", "integer", { notnull: true }),
        c("started_at", "integer", { note: "when the read began, for a list read in pages" }),
        c("complete", "integer", {
          notnull: true,
          note: "1 when the read returned the whole list, so a member missing from it is gone",
        }),
        c("reported_count", "integer", { note: "the count the messenger reports" }),
        c("listed_count", "integer", { notnull: true, note: "how many members this read returned" }),
        c("source", "text", { notnull: true, note: "what read it: a sync, a command, an import" }),
        ...ts(),
      ],
      keys: ["INDEX (chat_id, observed_at, id)"],
    },
    {
      name: "member_observation_members",
      doc: "Who one member-list read saw.",
      cols: [
        fk("member_observation_id", "member_observations", { notnull: true }),
        fk("identity_id", "identities", { notnull: true }),
        fk("member_stay_id", "member_stays", { notnull: true, note: "the stay the member was in when seen" }),
      ],
      keys: ["PRIMARY KEY (member_observation_id, identity_id)", "INDEX (member_stay_id)"],
    },
  ],
  sources: [
    {
      name: "bot_updates",
      doc: "Every update a bot account received through the Bot API, kept as it came, so it can be inspected and replayed.",
      cols: [
        id(),
        fk("account_id", "accounts", { notnull: true, note: "the bot account" }),
        c("external_id", "text", { notnull: true, note: "the update id" }),
        c("kind", "text", { notnull: true, note: "message, callback, member change, …" }),
        c("payload", "text", { notnull: true, note: "JSON, exactly as received" }),
        c("received_at", "integer", { notnull: true }),
        c("handled_at", "integer", { note: "null until handled" }),
        c("error", "text", { note: "why handling failed" }),
        c("replayed_at", "integer", { note: "when it was last replayed" }),
        c("created_at", "integer", { notnull: true }),
      ],
      keys: ["UNIQUE (account_id, external_id)", "INDEX (account_id, received_at DESC)"],
    },
    {
      name: "syncs",
      doc: "One run of an integration's sync: what it did and how it ended.",
      cols: [
        id(),
        fk("account_id", "accounts", { notnull: true }),
        c("kind", "text", { notnull: true, note: "full, incremental, import" }),
        c("started_at", "integer", { notnull: true }),
        c("finished_at", "integer"),
        c("status", "text", { notnull: true, note: "running, succeeded, failed" }),
        c("counts", "text", { note: "JSON: created, updated, deleted, skipped" }),
        c("error", "text"),
        ...ts(),
      ],
    },
  ],
  actors: [
    {
      name: "organizations",
      doc: "A company, team, family or community the owner deals with. Projects, work accounts and people's identities belong to one.",
      cols: [
        id(),
        c("kind", "text", { notnull: true, note: "company, team, family, community" }),
        c("name", "text", { notnull: true }),
        c("scope", "text", {
          notnull: true,
          note: "`personal` or `work`; what a context query may read for a given purpose, so a work question never pulls private chats",
        }),
        meta(),
        ...ts(),
        del(),
      ],
    },
    {
      name: "bots",
      doc: "An AI agent or a script that works here: it registers itself, owns projects and tasks, is assigned work, writes notes. A bot of a messenger (a Telegram bot) is an identity, not this.",
      cols: [
        id(),
        c("name", "text", { notnull: true, unique: true, note: "handle, e.g. `zm-puller`" }),
        c("kind", "text", { notnull: true, note: "agent, script, integration" }),
        c("description", "text"),
        fk("owner_person_id", "persons", { note: "who runs it" }),
        c("model", "text", { note: "the model it runs on, when an agent" }),
        c("token_digest", "text", { note: "hash of its access token, for when bots authenticate" }),
        c("last_seen_at", "integer"),
        c("disabled_at", "integer"),
        meta(),
        ...ts(),
      ],
    },
  ],
  mail: [
    {
      name: "email_threads",
      doc: "A conversation by mail.",
      cols: [
        id(),
        fk("account_id", "accounts", { notnull: true }),
        c("external_id", "text", { notnull: true, note: "Gmail thread id, or derived from References" }),
        c("subject", "text"),
        c("last_email_at", "integer"),
        c("emails_count", "integer", { notnull: true }),
        meta(),
        ...ts(),
        del(),
      ],
      keys: ["UNIQUE (account_id, external_id)"],
    },
    {
      name: "emails",
      doc: "One email.",
      cols: [
        id(),
        fk("account_id", "accounts", { notnull: true }),
        fk("email_thread_id", "email_threads", { notnull: true }),
        c("external_id", "text", { notnull: true, note: "the Message-ID header" }),
        c("subject", "text"),
        fk("from_identity_id", "identities"),
        c("from_address", "text"),
        c("from_name", "text"),
        c("sent_at", "integer"),
        c("received_at", "integer"),
        c("in_reply_to", "text"),
        c("references", "text", { note: "JSON: the References header" }),
        c("body_text", "text"),
        c("body_html", "text"),
        c("snippet", "text"),
        c("outgoing", "integer"),
        c("read", "integer"),
        c("flagged", "integer"),
        c("draft", "integer"),
        c("size", "integer"),
        c("headers", "text", { note: "JSON: every header, as received" }),
        meta(),
        ...ts(),
        del(),
      ],
      keys: ["UNIQUE (account_id, external_id)", "INDEX (account_id, sent_at DESC)"],
    },
    {
      name: "email_recipients",
      doc: "One address on an email.",
      cols: [
        id(),
        fk("email_id", "emails", { notnull: true }),
        fk("identity_id", "identities"),
        c("address", "text", { notnull: true }),
        c("name", "text"),
        c("role", "text", { notnull: true, note: "to, cc, bcc, reply_to" }),
        c("position", "integer", { notnull: true }),
        ...ts(),
      ],
    },
    {
      name: "mailboxes",
      doc: "An IMAP folder or a Gmail label. The owner's own tags are taggings.",
      cols: [
        id(),
        fk("account_id", "accounts", { notnull: true }),
        c("external_id", "text", { notnull: true }),
        c("name", "text", { notnull: true }),
        c("kind", "text", { note: "inbox, sent, archive, label, folder" }),
        ...ts(),
      ],
      keys: ["UNIQUE (account_id, external_id)"],
    },
    {
      name: "email_mailboxes",
      doc: "Which mailboxes an email is in; Gmail puts one email in several.",
      cols: [
        fk("email_id", "emails", { notnull: true }),
        fk("mailbox_id", "mailboxes", { notnull: true }),
        c("created_at", "integer", { notnull: true }),
      ],
      keys: ["PRIMARY KEY (email_id, mailbox_id)"],
    },
    fts("email_words", "Word index over email subjects and bodies.", "normalized_text, scope"),
    fts("email_stems", "Stem index, the pair of email_words.", "stems, scope"),
    queue("email_index_pending", "emails"),
  ],
  documents: [
    {
      name: "documents",
      doc: "A file or page that stands on its own: a file in a notes folder (md, pdf, docx, xlsx…), a Notion page, a Drive file, a memo wiki page.",
      cols: [
        id(),
        fk("account_id", "accounts", { notnull: true, note: "the folder, Notion, Drive" }),
        c("external_id", "text", { notnull: true, note: "path in the folder, page id, file id" }),
        c("kind", "text", { notnull: true, note: "file, page, wiki" }),
        c("title", "text"),
        c("location", "text", {
          note: "where it lives in its source: the folder path, the Drive folder, the Notion parent page",
        }),
        c("file_name", "text", { note: "with its extension; null for a page that is not a file" }),
        c("extension", "text", { note: "lower case, without the dot: md, pdf, docx" }),
        c("url", "text", { note: "where the source opens it" }),
        c("storage", "text", { note: "local, drive, notion, web — where the bytes are" }),
        c("local_path", "text", {
          note: "a copy on this machine, when one is kept; for a local folder, the file itself",
        }),
        c("mime", "text"),
        c("size", "integer"),
        c("content_hash", "text"),
        c("front_matter", "text", { note: "JSON, as written in the file" }),
        c("body", "text", { note: "Markdown as is; extracted text for PDF and Office; OCR for scans" }),
        c("normalized_text", "text"),
        c("extraction", "text", { note: "none, text, ocr, agent, failed" }),
        c("extraction_error", "text"),
        c("language", "text"),
        c("revision", "integer", { notnull: true }),
        c("export_path", "text", { note: "where memo exported it, for wiki pages" }),
        c("external_created_at", "integer"),
        c("external_updated_at", "integer"),
        meta(),
        ...ts(),
        del(),
      ],
      keys: ["UNIQUE (account_id, external_id)"],
    },
    {
      name: "document_revisions",
      doc: "Earlier bodies of a document.",
      cols: [
        id(),
        fk("document_id", "documents", { notnull: true }),
        c("body", "text", { notnull: true }),
        c("revision", "integer", { notnull: true }),
        c("created_at", "integer", { notnull: true }),
      ],
    },
    fts("document_words", "Word index over documents.", "normalized_text, scope"),
    fts("document_stems", "Stem index, the pair of document_words.", "stems, scope"),
    queue("document_index_pending", "documents"),
    {
      name: "notes",
      doc: "Short text about something: a person, a chat, an event, a document, a task. Comments on a task are notes too.",
      cols: [
        id(),
        ...poly(
          "notable",
          "what the note is about: `person`, `chat`, `event`, `document`, `task`, …; a note about nothing in particular is about the owner's person",
        ),
        c("title", "text"),
        c("body", "text", { notnull: true }),
        ...actor("author"),
        c("revision", "integer", { notnull: true }),
        ...ts(),
        del(),
      ],
    },
    {
      name: "note_revisions",
      doc: "Earlier bodies of a note.",
      cols: [
        id(),
        fk("note_id", "notes", { notnull: true }),
        c("body", "text", { notnull: true }),
        c("revision", "integer", { notnull: true }),
        c("created_at", "integer", { notnull: true }),
      ],
    },
    fts("note_words", "Word index over notes.", "normalized_text, scope"),
    fts("note_stems", "Stem index, the pair of note_words.", "stems, scope"),
    queue("note_index_pending", "notes"),
    {
      name: "memories",
      doc: "What an agent concluded: a summary, a daily digest, a fact, a preference. Derived and fallible, so it carries its evidence (`links` of kind `evidence`), its confidence and its status; notes are what a person wrote.",
      cols: [
        id(),
        c("kind", "text", { notnull: true, note: "summary, digest, fact, preference" }),
        c("body", "text", { notnull: true }),
        c("subject_type", "text", {
          note: "what it is about: `person`, `chat`, `meeting`, `project`, …; null for a general fact",
        }),
        c("subject_id", "integer"),
        ...actor("author", { notnull: true }),
        c("model", "text", { note: "the model that wrote it" }),
        c("confidence", "real", { note: "0–1, as the author rated it" }),
        c("status", "text", { notnull: true, note: "proposed, confirmed, stale, superseded" }),
        c("last_verified_at", "integer", { note: "when its evidence was last checked" }),
        fk("supersedes_id", "memories", { note: "the memory this one replaces" }),
        c("scope", "text", { notnull: true, note: "personal or work, from its evidence" }),
        ...ts(),
      ],
    },
    fts("memory_words", "Word index over memories.", "normalized_text, scope"),
    fts("memory_stems", "Stem index, the pair of memory_words.", "stems, scope"),
    queue("memory_index_pending", "memories"),
  ],
  actions: [
    {
      name: "proposed_actions",
      doc: "Something an agent wants done outside the store — reply, send, delete, ban, mute, pin, invite, create a task — waiting for a person to approve it. Nothing external happens without approval.",
      cols: [
        id(),
        c("kind", "text", { notnull: true, note: "reply, send, delete, ban, mute, pin, invite, create_task, …" }),
        fk("account_id", "accounts", { note: "the account that would act" }),
        c("target_type", "text", { note: "what it acts on: `message`, `chat`, `identity`, `task`, …" }),
        c("target_id", "integer"),
        c("payload", "text", { note: "JSON: what to do, e.g. the reply text" }),
        c("reason", "text", { note: "why the agent proposes it" }),
        c("status", "text", { notnull: true, note: "proposed, approved, rejected, executed, failed" }),
        ...actor("proposed_by", { notnull: true }),
        ...actor("decided_by"),
        c("decided_at", "integer"),
        c("executed_at", "integer"),
        c("result", "text", { note: "JSON: what the provider returned" }),
        c("error", "text"),
        c("verdict", "text", { note: "useful or not_useful, as the owner judged the proposal" }),
        ...ts(),
      ],
      keys: ["INDEX (status, created_at)"],
    },
    {
      name: "agent_actions",
      doc: "Every tool an agent called through the CLIs or MCP: who, which tool, at what access tier, on what. The audit trail of what agents did.",
      cols: [
        id(),
        ...actor("actor", { notnull: true }),
        c("tool", "text", { notnull: true, note: "the command or MCP tool" }),
        c("tier", "text", { notnull: true, note: "read, draft, write-private, write-public, destructive, admin" }),
        c("target_type", "text"),
        c("target_id", "integer"),
        c("status", "text", { notnull: true, note: "ok, refused, failed" }),
        c("error", "text"),
        c("started_at", "integer", { notnull: true }),
        c("finished_at", "integer"),
        c("created_at", "integer", { notnull: true }),
      ],
      keys: ["INDEX (started_at DESC)"],
    },
  ],
  embeddings: [
    {
      name: "involvements",
      doc: 'Who took part in what, and when: one row per person or identity per message, email, meeting, task or document. Derived from senders, recipients, participants, assignees and links, and rebuilt at will; it turns "everything about Alex" into one indexed range.',
      cols: [
        id(),
        fk("person_id", "persons", { note: "null while the identity is linked to nobody" }),
        fk("identity_id", "identities"),
        ...poly("subject", "`message`, `email`, `meeting`, `task`, `document`, `note`, …"),
        c("role", "text", {
          notnull: true,
          note: "sender, recipient, participant, assignee, author, mentioned, linked",
        }),
        c("occurred_at", "integer", { notnull: true, note: "when the subject happened" }),
        c("scope", "text", { notnull: true }),
        fk("account_id", "accounts"),
        fk("project_id", "projects"),
        c("created_at", "integer", { notnull: true }),
      ],
      keys: ["INDEX (person_id, occurred_at DESC)", "INDEX (identity_id, occurred_at DESC)"],
    },
    {
      ...queue("involvement_pending", ""),
      doc: "Things whose `involvements` rows are stale: a message, chat, meeting, email, task or anything a link starts from. Triggers enqueue; the drain recomputes that thing's rows.",
    },
    {
      name: "chunks",
      doc: "Pieces of a longer text, the unit that gets an embedding: ranges of a document, an email, an attachment's text, a note, a meeting transcript or summary; a short task or event is one chunk. A conversation of messages is cut into pieces here too, one `conversation` row per piece, and `chunk_messages` says which messages each piece spans; so one search can read every kind of text, filtered by scope, account, project and time.",
      cols: [
        id(),
        ...poly(
          "chunkable",
          "`document`, `email`, `attachment`, `note`, `memory`, `conversation`, `meeting_transcript`, `meeting_summary`, `event`, `task`",
        ),
        c("position", "integer", { notnull: true }),
        c("start_offset", "integer", {
          notnull: true,
          note: "where the piece starts in the parent's text, in characters",
        }),
        c("end_offset", "integer", { notnull: true, note: "where it ends, exclusive" }),
        c("content_hash", "text", {
          notnull: true,
          note: "hash of the piece's text; its embedding is the `embeddings` row with this hash, so equal text is embedded once",
        }),
        c("scope", "text", {
          note: "copied from the parent's account, chat or project, so a vector search filters before it compares; triggers follow a chat's or account's change",
        }),
        fk("account_id", "accounts", { note: "copied from the parent, a filter for vector search" }),
        fk("project_id", "projects", { note: "copied from the parent when it belongs to one" }),
        c("occurred_at", "integer", {
          note: "when the parent happened (sent, held, written), a filter for vector search",
        }),
        ...ts(),
      ],
      keys: ["UNIQUE (chunkable_type, chunkable_id, position)", "INDEX (content_hash)", "INDEX (scope, occurred_at)"],
    },
    {
      name: "chunk_messages",
      doc: "Which messages a conversation's chunk is cut from. One row per `conversation` row of `chunks`; deleting either message deletes the chunk.",
      cols: [
        fk("chunk_id", "chunks", { pk: true, note: "the chunk, of type `conversation`" }),
        fk("first_message_id", "messages", { notnull: true }),
        fk("last_message_id", "messages", { notnull: true }),
        c("text_start", "integer", {
          note: "where the piece starts inside the first message's text, when it begins mid-message",
        }),
        c("text_end", "integer", { note: "where it ends inside the last message's text" }),
      ],
    },
  ],
  tags: [
    {
      name: "taggings",
      doc: "One tag on one thing.",
      cols: [
        id(),
        fk("tag_id", "tags", { notnull: true }),
        ...poly(
          "taggable",
          "`chat`, `identity`, `message`, `email`, `document`, `note`, `person`, `organization`, `project`, `task`, `event`, …",
        ),
        c("main", "integer", { notnull: true, note: "1 on the thing's main topic; at most one per thing" }),
        c("source", "text", { notnull: true, note: "where it came from: owner, agent, auto, an import" }),
        ...actor("author"),
        ...ts(),
      ],
      keys: ["UNIQUE (tag_id, taggable_type, taggable_id)", "UNIQUE (taggable_type, taggable_id) WHERE main = 1"],
    },
  ],
  events: [
    {
      name: "event_series",
      doc: "A repeating event, above any one provider's recurrence.",
      cols: [
        id(),
        c("title", "text"),
        c("recurrence", "text", { note: "RRULE when known" }),
        c("origin", "text", { notnull: true, note: "auto or owner" }),
        ...ts(),
      ],
    },
    {
      name: "events",
      doc: "The owner's own record of something that happened, as a person is the owner's record of someone. Holds no provider fields: sources point at it.",
      cols: [
        id(),
        fk("event_series_id", "event_series"),
        c("title", "text"),
        c("description", "text"),
        c("location", "text"),
        c("starts_at", "integer"),
        c("ends_at", "integer"),
        c("timezone", "text"),
        c("origin", "text", { notnull: true, note: "auto or owner" }),
        ...ts(),
        del(),
      ],
      keys: ["INDEX (starts_at)"],
    },
    {
      name: "meeting_series",
      doc: "A provider's recurring or scheduled meeting.",
      cols: [
        id(),
        fk("account_id", "accounts", { notnull: true }),
        c("external_id", "text", { notnull: true, note: "Zoom meeting id" }),
        fk("event_series_id", "event_series"),
        c("title", "text"),
        c("description", "text"),
        c("kind", "text", { note: "instant, scheduled, recurring" }),
        c("recurrence", "text", { note: "JSON, the provider's rule" }),
        fk("host_identity_id", "identities"),
        c("join_url", "text"),
        meta(),
        ...ts(),
        del(),
      ],
      keys: ["UNIQUE (account_id, external_id)"],
    },
    {
      name: "meetings",
      doc: "One occurrence: it happened once, at one time.",
      cols: [
        id(),
        fk("account_id", "accounts", { notnull: true }),
        fk("meeting_series_id", "meeting_series"),
        fk("event_id", "events", { note: "set by event linking" }),
        c("external_id", "text", { notnull: true, note: "Zoom occurrence UUID" }),
        c("title", "text"),
        c("description", "text", { note: "agenda; also what a calendar entry carries" }),
        c("location", "text"),
        c("join_url", "text"),
        c("started_at", "integer"),
        c("ended_at", "integer"),
        c("duration_ms", "integer"),
        c("timezone", "text"),
        fk("host_identity_id", "identities"),
        c("participants_count", "integer"),
        meta(),
        ...ts(),
        del(),
      ],
      keys: ["UNIQUE (account_id, external_id)", "INDEX (account_id, started_at DESC)"],
    },
    {
      name: "meeting_participants",
      doc: "One person in one meeting, as that meeting saw them; the name and email stay with this meeting.",
      cols: [
        id(),
        fk("meeting_id", "meetings", { notnull: true }),
        fk("identity_id", "identities", {
          notnull: true,
          note: "keyed by the provider's user id, else email, else name@meeting",
        }),
        c("display_name", "text"),
        c("email", "text"),
        c("role", "text", { note: "host, co-host, attendee, panelist, guest" }),
        c("joined_at", "integer", { note: "first join" }),
        c("left_at", "integer", { note: "last leave" }),
        c("duration_ms", "integer"),
        c("sessions", "text", { note: "JSON: each join and leave" }),
        c("external_id", "text"),
        meta(),
        ...ts(),
      ],
      keys: ["UNIQUE (meeting_id, identity_id)"],
    },
    {
      name: "meeting_transcripts",
      doc: "One transcript of a meeting: Zoom's, a bot's, or a corrected version, which supersedes the old one.",
      cols: [
        id(),
        fk("meeting_id", "meetings", { notnull: true }),
        c("source", "text", { notnull: true, note: "api, file, fireflies" }),
        c("format", "text", { note: "vtt" }),
        c("language", "text"),
        c("content_hash", "text", { note: "the same file imported twice is skipped" }),
        c("external_created_at", "integer"),
        c("superseded_at", "integer"),
        meta(),
        ...ts(),
        del(),
      ],
    },
    {
      name: "meeting_transcript_rows",
      doc: "One row of a transcript (a WebVTT cue): who spoke, when, and what they said.",
      cols: [
        id(),
        fk("meeting_transcript_id", "meeting_transcripts", { notnull: true }),
        c("position", "integer", { notnull: true }),
        c("start_ms", "integer", { notnull: true }),
        c("end_ms", "integer", { notnull: true }),
        fk("speaker_participant_id", "meeting_participants", {
          note: "the participant whose name the cue gives, matched within the meeting; null when no single participant matches",
        }),
        c("speaker_name", "text", { note: "as written in the cue" }),
        c("text", "text", { notnull: true }),
        c("normalized_text", "text"),
        meta(),
        c("created_at", "integer", { notnull: true }),
      ],
      keys: ["UNIQUE (meeting_transcript_id, position)"],
    },
    {
      name: "meeting_chat_messages",
      doc: "The in-meeting chat.",
      cols: [
        id(),
        fk("meeting_id", "meetings", { notnull: true }),
        c("external_id", "text"),
        c("sent_at", "integer", { notnull: true }),
        fk("sender_participant_id", "meeting_participants"),
        c("sender_name", "text"),
        c("recipient", "text", { note: "everyone, or a name for a private message" }),
        c("text", "text", { notnull: true }),
        c("normalized_text", "text"),
        meta(),
        ...ts(),
      ],
      keys: ["UNIQUE (meeting_id, external_id) WHERE external_id IS NOT NULL", "INDEX (meeting_id)"],
    },
    {
      name: "meeting_summaries",
      doc: "A summary of a meeting, from the provider's AI, a bot, the owner or an LLM run here.",
      cols: [
        id(),
        fk("meeting_id", "meetings", { notnull: true }),
        c("source", "text", { notnull: true, note: "zoom-ai, fireflies, owner, llm" }),
        c("title", "text"),
        c("overview", "text"),
        c("sections", "text", { note: "JSON: [{label, text}]" }),
        c("next_steps", "text", { note: "JSON: [text]" }),
        c("content", "text", { note: "the provider's full text" }),
        c("doc_url", "text"),
        c("external_created_at", "integer"),
        c("external_updated_at", "integer"),
        meta(),
        ...ts(),
      ],
      keys: ["UNIQUE (meeting_id, source)"],
    },
    fts("meeting_words", "Word index over transcript rows, meeting chat and summaries.", "normalized_text, scope"),
    fts("meeting_stems", "Stem index, the pair of meeting_words.", "stems, scope"),
    queue("meeting_index_pending", "transcript rows, meeting chat and summaries"),
  ],
  tasks: [
    {
      name: "projects",
      doc: "A place for tasks, with the short key their ids start with (`MEET-12`).",
      cols: [
        id(),
        c("key", "text", { notnull: true, unique: true, note: "uppercase, e.g. MEET" }),
        c("name", "text", { notnull: true }),
        c("description", "text"),
        c("type", "text", {
          notnull: true,
          note: "work, client, personal, oss, other; tags group projects beyond that",
        }),
        fk("organization_id", "organizations"),
        fk("account_id", "accounts", {
          note: "the account an inbox project collects tasks for; null for a project of the owner's own",
        }),
        c("scope", "text", {
          notnull: true,
          note: "`personal` or `work`; what a context query may read for a given purpose, so a work question never pulls private chats",
        }),
        ...actor("owner"),
        c("tasks_count", "integer", {
          notnull: true,
          note: "the last number given out; the next task takes +1 in the same transaction",
        }),
        c("status", "text", { note: "active, archived" }),
        ...ts(),
        del(),
      ],
    },
    {
      name: "tasks",
      doc: "A task or ticket, for people and agents alike. Everything it concerns — people, messages, emails, documents, meetings — is a `links` row; its tags are taggings; its comments are notes.",
      cols: [
        id(),
        fk("project_id", "projects", { notnull: true }),
        c("number", "integer", { notnull: true, note: "per project" }),
        c("key", "text", {
          notnull: true,
          unique: true,
          note: "`<project key>-<number>`, the id people and agents use",
        }),
        c("title", "text", { notnull: true }),
        c("description", "text"),
        c("type", "text", {
          notnull: true,
          note: "bug, feature, chore, question, request, mention, promise — the last four are what the task package finds in messages",
        }),
        c("status", "text", { notnull: true, note: "open, in_progress, blocked, done, dismissed" }),
        c("priority", "integer", { note: "0 urgent … 4 low" }),
        fk("parent_id", "tasks", { note: "a subtask's parent" }),
        c("due_at", "integer"),
        c("started_at", "integer"),
        c("closed_at", "integer"),
        ...actor("closed_by"),
        c("close_reason", "text"),
        ...actor("author", { notnull: true }),
        c("source", "text", { notnull: true, note: "owner, agent, rule, or an import" }),
        c("package_id", "text", {
          unique: true,
          note: "the task package's own id for the task; null for a task made here",
        }),
        c("source_locator", "text", { note: "what the task came from: a message locator, never its text" }),
        c("source_kind", "text", { note: "the kind of thing `source_locator` names" }),
        c("source_group", "text", { note: "the group the task package files it under" }),
        c("resolution", "text", {
          note: "how it ended, in words; a question's answer. Where the answer came from is a `links` row of kind `answered-by`",
        }),
        c("verdict", "text", {
          note: "useful or not_useful, as the owner judged a task an agent raised; null until judged",
        }),
        meta(),
        ...ts(),
        del(),
      ],
      keys: [
        "UNIQUE (project_id, number)",
        "INDEX (project_id, status, due_at)",
        "INDEX (project_id, source_locator)",
        "INDEX (source_group)",
      ],
    },
    {
      name: "task_assignments",
      doc: "Who works on a task: a person or a bot, in a role.",
      cols: [
        id(),
        fk("task_id", "tasks", { notnull: true }),
        ...actor("assignee", { notnull: true }),
        c("role", "text", { notnull: true, note: "assignee, reviewer, watcher" }),
        ...ts(),
      ],
      keys: ["UNIQUE (task_id, assignee_type, assignee_id, role)"],
    },
    {
      name: "task_events",
      doc: "The history of a task: created, status changed, assigned, due date moved.",
      cols: [
        id(),
        fk("task_id", "tasks", { notnull: true }),
        ...actor("actor"),
        c("kind", "text", { notnull: true }),
        c("changes", "text", { note: "JSON: {field: [from, to]}" }),
        c("created_at", "integer", { notnull: true }),
      ],
    },
    {
      name: "decisions",
      doc: "A choice that was made and holds until replaced: why we do something. Its evidence — the message, transcript row or document — is `links` of kind `evidence`; a decision an agent proposed links back to that memory with `created-from`.",
      cols: [
        id(),
        fk("project_id", "projects"),
        c("statement", "text", { notnull: true, note: "the decision in one sentence" }),
        c("status", "text", { notnull: true, note: "proposed, accepted, superseded, reversed" }),
        c("decided_at", "integer", { note: "when it was made, as the evidence shows" }),
        fk("supersedes_id", "decisions", { note: "the decision this one replaces" }),
        ...actor("confirmed_by", { note: "who accepted it; null while proposed" }),
        c("source", "text", { notnull: true, note: "owner, agent, an import" }),
        meta(),
        ...ts(),
        del(),
      ],
    },
  ],
}

const transform = (name) => {
  const t = current.get(name)
  const e = EDITS[name] ?? {}
  const d = docs[name] ?? { doc: "", cols: {} }
  const fks = new Map(t.fks.map((f) => [f.from, f]))
  const singlePk = t.cols.filter((y) => y.pk).length === 1
  let cols
  if (e.replaceCols) cols = e.replaceCols.map(([n, ty, o]) => c(n, ty, o))
  else {
    cols = t.cols
      .filter((x) => !(e.drop ?? []).includes(x.name))
      .map((x) => {
        const now = e.cols?.[x.name] ?? ruleName(x.name)
        const f = fks.get(x.name)
        const isTextId = x.name === "id" && e.pkInteger
        return c(now, isTextId ? "integer" : (e.colTypes?.[now] ?? TYPE[x.type] ?? x.type.toLowerCase()), {
          pk: x.pk === 1 && singlePk,
          notnull: (!!x.notnull || x.pk > 0) && !(x.pk && singlePk),
          was: now !== x.name ? x.name : undefined,
          ref: e.colRefs?.[now] ?? (f ? `${EDITS[f.table]?.rename ?? f.table}.${ruleName(f.to ?? "pk")}` : undefined),
          note: e.colNotes?.[now] ?? d.cols[x.name],
        })
      })
    if (e.addPk) cols.unshift(id())
    if (e.prepend) cols.splice(cols[0]?.pk ? 1 : 0, 0, ...e.prepend.map(([n, ty, o]) => c(n, ty, o)))
    for (const [n, ty, o] of e.add ?? []) if (!cols.some((x) => x.name === n)) cols.push(c(n, ty, o))
  }
  const multiPk = t.cols.filter((x) => x.pk).map((x) => e.cols?.[x.name] ?? ruleName(x.name))
  const keys = []
  if (multiPk.length > 1 && !e.replaceCols) keys.push(`${e.addPk ? "UNIQUE" : "PRIMARY KEY"} (${multiPk.join(", ")})`)
  if (!e.replaceCols) {
    for (const i of t.idx.filter((i) => i.unique && i.origin === "u")) {
      if (i.cols.some((x) => (e.drop ?? []).includes(x))) continue
      if (i.cols.length === 1) {
        const only = cols.find((x) => x.name === (e.cols?.[i.cols[0]] ?? ruleName(i.cols[0])))
        if (only) only.unique = true
        continue
      }
      keys.push(`UNIQUE (${i.cols.map((x) => (x == null ? "expression" : (e.cols?.[x] ?? ruleName(x)))).join(", ")})`)
    }
  }
  keys.push(...(e.keys ?? []))
  return {
    name: e.rename ?? name,
    was: e.rename ? name : undefined,
    doc: e.doc ?? d.doc,
    note: e.note,
    cols,
    keys,
    status:
      e.rename || e.note || e.replaceCols
        ? "changed"
        : cols.some((x) => x.was) || e.add?.length || e.addPk
          ? "renamed"
          : "kept",
  }
}

const virtualKept = (name, rename) => {
  const t = current.get(name)
  const sql = t.sql.replace(/\s+/g, " ").replace(/content_rowid='pk'/, "content_rowid='id'")
  const vocab = /prefix = .3./.test(sql) ? `;\nCREATE VIRTUAL TABLE ${name}_vocab USING fts5vocab(${name}, 'col')` : ""
  return {
    name: rename ?? name,
    was: rename ? name : undefined,
    virtual: true,
    doc: docs[name]?.doc || "Full-text index.",
    sql: sql + vocab,
    status: "kept",
  }
}

const GROUPS = [
  [
    "sources",
    "Sources",
    "Every integration is an account; each sync run is logged.",
    ["accounts", "sync_cursors:sync_state", "sync_ranges", "fetch_leases"],
    NEW.sources,
  ],
  [
    "people",
    "People, organizations and bots",
    "Humans, the per-source identities they have, the organizations they belong to, and the agents that work here.",
    [
      "persons",
      "identities",
      "identity_links",
      "identity_link_events",
      "identity_revisions",
      "account_identities",
      "aliases:contact_aliases",
      "~identities_fts",
    ],
    NEW.actors,
  ],
  [
    "chats",
    "Chats and messages",
    "What messengers bring.",
    [
      "chats",
      "chat_members",
      "member_stays",
      "member_counts",
      "messages",
      "message_revisions",
      "message_links",
      "message_counter_observations",
      "message_transcripts:transcripts",
      "~chats_fts",
      "~messages_fts",
      "~message_words",
      "~message_stems",
      "message_stems_pending",
    ],
    NEW.chats,
  ],
  ["mail", "Mail", "Email has tables of its own: threads, subjects, recipients, mailboxes.", [], NEW.mail],
  [
    "attachments",
    "Attachments",
    "Files of a message, an email or a meeting, with their extracted text.",
    ["attachments", "~attachment_words"],
    [],
  ],
  [
    "documents",
    "Documents, notes and memories",
    "Documents are files and pages that stand on their own; notes are what a person wrote about something; memories are what an agent concluded.",
    [],
    NEW.documents,
  ],
  ["events", "Events and meetings", "The owner's events, and each meeting app's record of them.", [], NEW.events],
  [
    "tasks",
    "Tasks",
    "A task and ticket system for people and agents: projects with keys, typed and prioritised tasks, assignees that are people or bots, and the decisions made along the way. A promise is a task of type `promise`; a question is a task of type `question` whose answer is linked.",
    ["reminders:knowledge_reminders"],
    NEW.tasks,
  ],
  [
    "actions",
    "Agents and actions",
    "What agents propose and what they did: every external action waits for approval, every tool call is logged.",
    [],
    NEW.actions,
  ],
  [
    "tags",
    "Tags, links and saved searches",
    "Polymorphic: `<name>_type` text + `<name>_id` integer.",
    ["tags", "auto_tag_claims", "links", "searches"],
    NEW.tags,
  ],
  [
    "derived",
    "Chunks, embeddings and search state",
    "Derived: can be rebuilt from the tables above. Every long text is cut into `chunks`; each chunk's text has one row in `embeddings`.",
    [
      "conversations",
      "conversation_messages",
      "conversation_state",
      "embeddings:chunk_vectors",
      "search_index_state",
      "search_terms",
      "search_term_trigrams",
    ],
    NEW.embeddings,
  ],
  ["store", "Store", "Bookkeeping for the file itself.", ["schema_migrations", "store_settings"], []],
]

const readJson = (file) => {
  try {
    return JSON.parse(readFileSync(`${scratch}/${file}`, "utf8"))
  } catch {
    return {}
  }
}
const NOTES = [readJson("notes-new.json"), readJson("notes-existing.json")]
const { patternNote } = await import("./patterns.mjs")
const explain = (t) =>
  t.virtual
    ? t
    : {
        ...t,
        cols: t.cols.map((col) =>
          col.note || col.pk
            ? col
            : { ...col, note: NOTES.map((n) => n[t.name]?.[col.name]).find(Boolean) ?? patternNote(t, col) },
        ),
      }

const build = () =>
  GROUPS.map(([key, title, blurb, existing, added]) => ({
    key,
    title,
    blurb,
    tables: [
      ...existing.map((spec) => {
        const virtual = spec.startsWith("~")
        const [now, from] = spec.replace("~", "").split(":")
        const source = from ?? now
        return virtual ? virtualKept(source) : transform(source)
      }),
      ...added.map((t) => ({ ...t, status: "new" })),
    ].map(explain),
  }))
export const model = build
export const dropped = DROPPED

const fkIndexes = (t) => {
  if (t.virtual) return []
  const covered = new Set(
    (t.keys ?? []).map((k) =>
      k
        .replace(/^[A-Z ]+\(/, "")
        .split(/[,)]/)[0]
        .trim(),
    ),
  )
  const out = []
  for (const col of t.cols ?? []) {
    if (col.pk) continue
    if (col.ref && !covered.has(col.name)) out.push(`INDEX (${col.name})`)
    if (
      col.name.endsWith("_type") &&
      t.cols.some((x) => x.name === col.name.replace(/_type$/, "_id")) &&
      !covered.has(col.name)
    )
      out.push(`INDEX (${col.name}, ${col.name.replace(/_type$/, "_id")})`)
  }
  return out
}
export const indexes = fkIndexes
