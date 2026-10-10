import sys, re
p = sys.argv[1]; s = open(p).read()
def before(anchor, comment, count=1):
    global s
    assert s.count(anchor) >= 1, anchor
    m = re.search(r"\n( *)" + re.escape(anchor.lstrip()), s)
    indent = m.group(1)
    block = "\n".join(indent + line if line else line for line in comment.strip("\n").split("\n"))
    s = s[:m.start()] + "\n" + block + s[m.start():]

before('export const accounts = sqliteTable(', '''/**
 * The store's base tables, v2 — what `drizzle-kit generate` diffs against. Every column is explained in
 * `docs/storage/schema-v2.md`; the two must agree. A change here becomes a migration, under the rules at the
 * top of `../migrations.ts`. FTS5 tables, their triggers and the `WITHOUT ROWID` search-term tables are not
 * modelled by Drizzle and live in hand-written SQL.
 */
''')
before('export const syncCursors = sqliteTable(', '/** Per account, what a sync remembers between runs: a delta marker, when a list was last complete. */')
before('export const fetchLeases = sqliteTable(', '/** Who is fetching a stretch of a chat right now, so two processes do not fetch the same pages. */')
before('export const identityRevisions = sqliteTable(', '/** Each profile a person was seen with, a row when it differs from the one before; `identities` holds the latest. */')
before('lastMessagedAt: integer("last_messaged_at"),', '/** Their one-to-one chat\'s newest message, as `refreshRecency` last worked it out: the contact order. */')
before('membershipState: text("membership_state"),', '/** `NULL` is unknown. Searchable does not follow from it: a chat left keeps its messages. */')
before('messageCount: integer("message_count").notNull().default(0),\n    membersTrackedAt', '/** Kept by triggers, so a query can choose how a filter reaches the index. */')
before('membersTrackedAt: integer("members_tracked_at"),', '/** When the owner asked `serve` to fetch its member list daily; `NULL` when not tracked. */')
before('export const chatMembers = sqliteTable(', '/** Who is in a chat, as the account last saw it: a list replaces the chat\'s membership whole. */')
before('export const memberStays = sqliteTable(', '''/**
 * One stay of a person in a group, from member lists read whole or in part. A return after leaving is a new
 * row. `left_at` is set only from a list read whole: a cut list says nothing about who is missing.
 */''')
before('date: text("date").notNull(),', '/** `YYYY-MM-DD`, UTC; a later read the same day replaces the row. */')
before('senderChatExternalId: text("sender_chat_external_id"),', '''// Not a key: the channel a post came from is often not a chat this account is in, and a row for it
// would appear in the chat list.''')
before('index("messages_to_normalize")', '// Empty once the backfill is done, so every open can ask "anything left?" without reading the table.')
before('export const messageLinks = sqliteTable(', '''/*
 * Conversations and the links they are built from are derived — rebuilt from `messages`, never the only copy
 * of anything — so every foreign key into them cascades.
 */

/** Each candidate for "the earlier message this one answers", and where it came from. */''')
before('chatId: integer("chat_id")\n      .notNull()\n      .references(() => chats.id, { onDelete: "cascade" }),\n    messageId', '/** The message\'s chat, kept here so a rebuild finds and drops an old build without reading `messages`. */')
before('parentId: integer("parent_id").references(() => messages.id', '/** `NULL`: the source says this message starts a conversation. */')
before('build: integer("build"),\n    createdAt', '/** The rebuild that wrote a provider or rule link; `NULL` for an agent\'s, which outlive rebuilds. */')
before('uniqueIndex("message_links_unique")', '// NULLs are distinct to a UNIQUE constraint: "starts a conversation" and agent links would repeat.')
before('export const messageTranscripts = sqliteTable(', '''/**
 * What a voice message said. Still keyed by chat and external id: a message can be heard before the store
 * holds it, and `message_id` is set once it does. Derived — it can be heard again.
 */''')
before('export const messageStemsPending = sqliteTable(', '/** Messages whose stems are stale. Triggers fill it, because SQL cannot stem; JS empties it. */')
before('export const taggings = sqliteTable(', '/** Polymorphic, so no foreign key to the tagged row: triggers drop a tagging when its chat or message goes. */')
before('export const searches = sqliteTable(', '''/**
 * Every run of `search messages` and `stats messages show`, with the parameters as the caller gave them — never
 * a message or a result. A row with a name is a saved search; an identical unnamed run counts on its row.
 */''')
before('build: integer("build").notNull(),', '/** Written in batches under a new number, then made current at once: readers never see half a build. */')
before('  (table) => [\n    primaryKey({ columns: [table.conversationId, table.messageId] }),', "  // A message is in one conversation of each build; the current build and the one being written overlap.")
before('currentBuild: integer("current_build"),', '/** The build readers see; a higher one is being written, or failed. */')
before('export const chunkMessages = sqliteTable(', '/** Which messages a conversation chunk is cut from; deleting either message deletes the chunk. */')
before('textStart: integer("text_start"),', '''/**
 * Set on a piece of one message longer than a chunk (`first_message_id` = `last_message_id`): the stretch
 * of its text the piece holds, as offsets. `NULL` is the whole of every message in range.
 */''')
before('export const embeddings = sqliteTable(', '/** One model\'s vector for one chunk text; no owner, so vectors outlive the builds and chunks that point at them. */')
before('model: text("model").notNull(),', '/** `<provider>:<model>:<dims>` — vectors of different models never mix. */')
before('vector: blob("vector"', '/** Float32, little-endian. */')
before('export const searchIndexState = sqliteTable(', '''/**
 * How far a derived search index is built, one row per index. `watermark` is the highest row id when the
 * index was created: rows above it are indexed by triggers, rows up to it by batches that have reached
 * `filled_through`.
 */''')
before('analyzer: text("analyzer"),', '/** The stemmer choices and Snowball version that built the stems row (`analyzerIdentity`); NULL until a fill claims it. */')
before('export const storeSettings = sqliteTable(', '/** Settings of the store file itself, shared by every profile, tg and MAX — unlike a profile\'s config file. */')
open(p, "w").write(s)
