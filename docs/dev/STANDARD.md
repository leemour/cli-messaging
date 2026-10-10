# The standard for tg and max

tg-cli and max-cli are one tool with two messengers behind it. This page holds the rules that make
them one: how a command, an option, an answer and an MCP tool are named and shaped, where code
lives, and which documents each has. It lives here because this package is where the two meet;
both CLIs' `CONVENTIONS.md` link it instead of keeping a copy.

How a pull request is checked against these rules is [REVIEW.md](REVIEW.md).

A rule changes here first, in its own pull request, and the owner approves new wording — a new verb
or option name especially. Then the code follows. A difference between the two CLIs is allowed only
where one messenger lacks the feature, and it is written down with its reason in the
[parity manifest](#the-parity-manifest).

## External references and our adoption profile

We use external conventions as a baseline, with explicit project decisions below. This is not a
claim of complete POSIX, GNU or agent-spec conformance. The [CLI compliance audit](CLI-COMPLIANCE.md)
records implemented behaviour, gaps and follow-up work; the [architecture](ARCHITECTURE.md#cli-design-references)
explains where these contracts are enforced.

| Reference | Role here |
|---|---|
| [POSIX Utility Conventions, §12](https://pubs.opengroup.org/onlinepubs/9799919799/basedefs/V1_chap12.html) | Established utility syntax, including the end-of-options delimiter. This is the formal standards reference; our modern long options and nested tree are a project profile, not strict POSIX utility conformance. |
| [GNU Command-Line Interfaces](https://www.gnu.org/prep/standards/html_node/Command_002dLine-Interfaces) | Conventional long-option names, help and version behaviour. We do not copy GNU-specific branding or licensing text. |
| [Command Line Interface Guidelines](https://clig.dev/) | Practical design baseline for command discovery, streams, scripting and compatibility. A guide, not a certification scheme. |
| [MCP tools specification, 2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25/server/tools) | The protocol contract for the MCP adapter; it does not define our shell grammar. Structured tool results and annotations are relevant; outputSchema is optional. |
| [JSON Schema specification](https://json-schema.org/specification) | The schema language for machine contracts. A future CLI schema surface must declare its dialect; a TypeScript interface alone is not runtime schema discovery. |
| [Agent Skills specification](https://agentskills.io/specification) | The portable SKILL.md packaging format and progressive loading of agent guidance. It does not prescribe CLI commands. |
| [Anthropic: writing effective tools for agents](https://www.anthropic.com/engineering/writing-tools-for-agents) | Engineering guidance for distinct tool purposes, informative results and economical discovery. Evaluate these choices against representative tasks. |
| [CLI Agent Spec](https://cli-agent-spec.github.io/) | Independent community requirements and conformance ideas to assess selectively. We do not adopt its exit-code table or response envelope wholesale, or claim a conformance level. |
| [Google Workspace CLI agent context](https://github.com/googleworkspace/cli/blob/main/CONTEXT.md) | A concrete example of schema discovery, response projection and request previews. This is a project example, not a standard or an officially supported Google product. |

[Agent Client Protocol](https://agentclientprotocol.com/get-started/introduction) addresses
editor-to-coding-agent communication. MAX/TG are tools an agent invokes, not coding-agent
implementations, so ACP does not add a compliance requirement to our CLI.

Our additional contract is **agent determinism before presentation convenience**: machine results
are stable data; actions are explicit; uncertain write outcomes are not instructions to retry.
Names, messages and retrieved documents remain untrusted data. Local guards enforce permissions;
MCP hints and agent instructions never substitute for enforcement.

Explicit choices and gaps:

- `stats` and its resource hierarchy are our policy; external references do not require that root.
- Data goes to stdout; failures go to stderr as `{ error: { code, message, ... } }`. We retain
  command-specific success shapes and our exit codes. Parser errors and explicit JSON with a TTY
  currently have gaps documented in the audit; the desired contract does not prove implementation.
- Explicit help/version requests retain conventional text on stdout. An agent discovering a
  command uses `commands <path> --json`; help is not a JSON data response. The independent agent
  spec's blanket non-TTY help-to-stderr rule is not adopted.
- Machine output suppresses write-confirmation prompts, but credentials and setup need a broader
  non-interactive contract. `--yes` grants confirmation; it is not a substitute for disabling input.
- A read can have documented local effects such as ingestion, a stable device identity or a failed-run
  record. Validation-before-remote-action does not promise zero local writes on every error.
- General stdout-only envelopes, automatic retry of all writes, logging full tool payloads and
  new output fields on every existing response are not adopted from agent examples.
- [Command names](#command-names) currently require immediate removal of renamed paths and no
  aliases. This differs from CLIG's deprecation guidance. The owner explicitly chose immediate
  relocation without a compatibility window. Old paths stop working at adoption; the release
  notes and user docs give the new paths.

New commands are reviewed against this profile and the audit. Existing gaps require explicit
implementation work with tests; citing a reference alone does not close them.

## Command names

A name a person reads once should say what the command does; a name an agent reads should be
guessable from the others.

1. **`<tool> [profile] [namespace] <resource> [subresource ...] <verb-or-view> [arguments]`.**
   A namespace groups one cross-resource purpose; `stats` groups statistics. Subresources are
   allowed when they identify a part of the resource (`chats members list`), not an implementation
   detail. A group without a leaf command shows help, never runs a hidden default action.
   The resource is a noun: **plural** for a
   collection (`chats`, `contacts`, `messages`, `polls`, `reactions`, `recipients`, `replies`, `sends`,
   `runs`, `topics`, `models`, `tags`, `searches`, `copies`, `attachments`, `tasks`), **singular** for what a profile has exactly
   one of (`session`, `account`, `config`, `server`, `store`, `skill`, `cache`, `flood`). A group is never
   named with a verb. `tags` and `searches` are the owner's own records in the local store, never
   sent; their writes have their own keys (`tags.add`), so a read-only profile hides them.
   `tasks` are what waits on the owner — a question nobody answered, a mention, a request, a promise —
   kept in the local store by `@wirecat/cli-tasks` and never sent: `tasks list|add|close|stats`, the
   type of a task is `--type` (`question`, `request`, `mention`, `promise`), and closing is
   `tasks close <task> --as done|dismissed [--reason <text>]`. The owner chose these on 2026-10-06.
   `attachments` are the files of stored messages: their text, read or written back, is kept in the
   local store for `content:` in a search and never sent; `attachments.extract` is a local write.
   `chats tracking` is the one collection named by what it does rather than a plural: the chats whose
   member lists `serve` fetches daily into the local store — owner's wording, 2026-10-05.
2. **Top-level words** only for what spans every chat or is the tool itself: `inbox`, `review`,
   `watch`, `serve`, `doctor`, `upgrade`, `commands`, `complete`, `mcp`, `bot`, `stats`, `search`. Prefer an
   existing resource or namespace before adding another root word. A new root needs a reason in
   its naming pull request: what existing group cannot express, which related commands it groups,
   and why the same hierarchy works for both CLIs. One new report never justifies its own root.
3. **Verbs come from this list, each with one meaning.** A verb not on it is added here first.
   - `list` many · `show` one · `search` find by text — the description says where it looks
   - `related` what is nearest in meaning to one thing, without a query (`conversations related`)
   - `info` facts about a singular thing itself — where it is, its size, its version, its schema
     (`store info`) · `status` how a thing stands right now — a running process (`server status`)
     or what the store holds per chat (`store status`)
   - `check` verify, and change nothing — the answer says what is wrong and how to fix it
     (`store check`)
   - `test` run rules over what is already stored and say what they would have done, doing none of
     it (`replies test`)
   - `pause` / `resume` stop and restart what a running process does for a profile, without stopping
     the process (`replies pause`)
   - `create` / `delete` make or destroy a thing · `add` / `remove` put an existing thing into or
     out of a set (members, admins, contacts, recipients, reactions) · `clear` empty a set
   - `update` change a thing's fields · `set` / `unset` one named key · `rename` its name only
   - `start` / `stop` / `restart` a running process · `start` / `end` a login session
     · `install` / `uninstall` a system unit · `cancel` a job
   - `fetch` from the messenger into the store · `export` from the store to a file · `import` ·
     `download` · `transcribe` · `sync` take a whole list again · `extract` read the text inside files
     already on this machine into the store (`attachments extract`)
   - `migrate` bring a file up to this build's schema · `backup` copy it somewhere safe ·
     `restore` put a backup back in its place · `repair` bring a file's tables to this build's shape
     without deleting anything — a table of the wrong shape is kept as a copy (`store repair`, its copies
     in `store copies`)
   - `link` / `unlink` record in the store that two identities are one person, or undo it — a
     decision someone made, never inferred from a name (`contacts link`)
   - `lookup` ask the messenger who is behind a phone number · `inspect` look at a link without
     joining it
   - the messenger's plain verbs: `send`, `edit`, `forward`, `pin`, `unpin`, `vote`, `close`,
     `join`, `leave`, `block`, `unblock`, `mark-read`, `reset` (replace; the old one stops
     working), `moderate` (apply a chat's rules: delete what breaks them, act on who broke them)
   - A **noun as the last word** names a view and shows it: `server logs`, `chats events`,
     `messages scheduled`, `messages context`, `runs path`, `mcp config`, `searches history`.
     `top` is a ranked view under `stats`, for example `stats messages top`. `official` is the view
     the messenger itself computed, under `stats`: `stats chats official`.
4. **One action or report, one leaf command.** A different action or independently useful report
   belongs in a nested command. Options choose the scope, measure, order or format of that action;
   they do not switch a search, send or list into another report. For example, ranking is
   `stats messages top`, not a ranking mode added to `search messages`. Views, reactions and
   replies are measures of the same ranking, so they stay options, not sibling commands.
   No command both shows and changes, except an explicitly documented preparatory fetch such as
   `--sync-first`, which retains its own permissions and reports its outcome.
   **No two commands overlap** (owner, 2026-10-08). If one command's results are a subset of
   another's, one of them goes: an agent that learns the narrow path never finds the wide one. A
   narrower scope is an option or a resource of the same command, never a sibling elsewhere in the tree.
5. **Options are plain words, never a wire field** (`--send-id`, not `--cid`). One meaning, one
   name, in every command of both tools. **A length of time is a `<duration>`** (`500ms`,
   `30s`, `2m`, `4h`, `1d`) — a number and a unit, never a bare number — parsed as `--timeout`
   is; `--since-time` takes a duration or a time.
   - **The kind of value is in the name** of every option that takes a time, and of one that marks
     a place in a history or a count around it: `-id` a message id, `-time` an ISO 8601 time or a
     duration from now or ago, `-n` a count — `--before-id`, `--after-time`, `--since-time`,
     `--at-time`, `--before-n`. Two kinds, two options, never one
     option that guesses which it was given.
   - **How much, in a list or a fetch:** `--limit <n>` how many items, `--page <n>` which page,
     `--page-size <n>` how many one request to the messenger asks for. A count of pages is never an
     option: it means a different amount in each messenger.
6. **Arguments have fixed names:** `<chat>`, `<message>`, `<person>`, `<text>`, `<link>`,
   `<file>`, `<job>`, `<task>`.
7. **One word per idea** in help, docs and errors. The **local store** is the message database
   both tools share; max's per-profile **cache** is a different thing until it is replaced, and
   keeps its name until then. `session` is this tool's login; `account sessions` are the other
   devices. **`flood`** is what the messenger told this profile to hold off on — the waits it asked
   for and a hold on writes — kept on this machine; `flood clear` is the owner's and has no MCP tool. The
   **pace** is how fast one profile may ask its messenger, counted across every process (`requestsPerMinute`).
8. **An MCP tool is named after its command** — see [MCP](#mcp).
9. **No aliases.** A renamed command's old name stops working, and the release notes say so under
   "may break scripts".

10. **`bot` is the profile's bot account**, through the messenger's official Bot API and a bot
    token — never the personal login. Below it, a command the personal account also has takes the
    same name, arguments and options: `bot messages send`, `bot messages show <chat> <message>`,
    `bot chats members remove`, `bot chats moderate`, `bot contacts show`, `bot watch`. What only a
    bot has: `bot auth`, `bot list`, `bot callbacks`, `bot commands` (the menu people see on `/`),
    `bot webhooks`, `bot uploads`, `bot api`. A bot's send is never repeated — neither Bot API makes
    a repeat safe — so `bot messages send` has no `--send-id`. A bot command may add an option only a
    bot has, as `bot watch --types` does.

`bot api` is exempt: its names mirror each messenger's official Bot API operations.

### Search hierarchy

**Every command whose primary result is a search lives under `search`, then its resource**
(owner, 2026-10-08), as statistics live under `stats`: `search all`, `search messages`,
`search mail`, `search notes`, `search conversations`, `search topics`; for the bot account
`bot search messages`. `search all` covers every resource the store holds and is the one an agent
should reach for first. A resource's own `search` leaf (`messages search`) does not exist beside it.
`searches` stays: it is the owner's saved searches, a resource, not a search.

### Statistics hierarchy

**Every command whose primary result is statistics lives under `stats`, then its resource.**
Use the same resource words as elsewhere: `messages`, `chats`, `contacts`, not another word for
the same thing such as `users` or `people`. `show` displays an aggregate report; `top` displays a
ranking. Nest a subresource only when the user selects a distinct subject, as with chat members;
do not add a level for an algorithm, provider or output format. All filters follow the leaf.

The canonical paths for the statistics migration and rankings are:

| Path | Purpose | Status |
|---|---|---|
| `stats messages show [query...]` | Count matching stored messages, with the existing groupings | Planned relocation of `stats messages show` |
| `stats chats show <chat>` | A chat's aggregate numbers for a period | Planned relocation of `stats chats show` |
| `stats chats official <chat>` | What the messenger itself computed for a group or channel it shows its admins: its own period, totals against the previous one, top people, graphs as JSON series. One object, `kind` `group` or `channel`; `--jsonl` refused. Mounted only where `Messenger.officialStats` is set (Telegram) | Added |
| `stats messages top [query...]` | Rank matching messages by a measure or score | Planned |
| `stats contacts top [query...]` | Rank the authors of matching messages by a measure or score | Planned |

These paths specify the command hierarchy, not implemented availability. Existing commands stay
registered until the coordinated migration; no additional statistics commands may be added
outside `stats`. The existing `stats charts` noun view remains under that namespace; review the
planned `stats tasks show` path as part of the same migration inventory. A normal entity card may
contain counts (`contacts profile`, `store info`);
that does not make it a statistics command. Its main purpose remains describing the entity.
For bot-account statistics the account namespace comes first: `bot stats <resource> ...`, with
the same meanings wherever the provider supports them; this rule does not add Bot API features.

**Relocations are coordinated changes, not aliases.** Move CLI paths, command discovery/help,
completion, generated docs, skills, MCP names, permission keys and saved-run command metadata
together. Preserve existing output semantics during the move. If a permission or stored record
contains an old path, give it an explicit migration; never broaden permissions or silently reuse
an old key for a different action. The release notes name the old and new paths under “may break
scripts”. Old paths stop working in the release that adopts the new tree. Consumers adopt the
same shared implementation and manifest; a provider-specific difference needs a reason.

### Before creating a command

The naming pull request answers these questions before implementation:

1. What does the user want to do or learn, and which existing resource or namespace owns it?
   If the answer is a statistical report, its path starts with `stats`.
2. Is this a new action/report or a scope/measure/format variant of an existing leaf? Put the
   former in the command tree and the latter in options. Show the proposed parent help so the
   new command can be found without knowing its flags.
3. Are every resource word, leaf verb/view, argument and option consistent with both CLIs?
   A nested path must explain each level. Do not abbreviate or invent another word for an
   existing subject. Check the option catalogue before proposing a new option.
4. What result, coverage and permission contract does the leaf have, and how does its full path
   map to its MCP name? Record planned paths/options in the parity manifest before code.
5. Does it move or replace an existing command? List callers, generated pages, saved records and
   configuration that need migration; describe the breaking change before shipping it.

The owner approves new wording in this naming pull request. The review checklist applies these
questions to every subsequent command addition; they are not specific to rankings.

Generated `bot api` commands use cli-core's generators and one command assembler in cli-messaging.
Only the source-specification adapter, transport and provider capabilities stay in the consumer.
Common inputs are `--body <json>` and `--body-file <path>`; `-` reads stdin. A native `timeout`
parameter is `--poll-timeout`, so it cannot replace the command's `--timeout` deadline.
Schema-declared file fields accept `@path`; ordinary strings never trigger a file read.

This advanced interface returns the official operation's native result, preserving MAX's existing
API contract. The normal bot commands use the shared domain output shapes. Both native interfaces
still use the common machine error contract, the profile's guard and send journal; a write with an
unknown outcome is never repeated automatically.

`--store-token <profile>` names the destination for an operation returning an authentication token.
It is required for those operations and rejected for other operations. The token is kept only in the
OS keyring and never printed; the result names the destination profile, bot id and storage kind.
A destination bound to a different bot is refused before a remote credential rotation. Secret
request fields have no generated argument flags: supply their JSON on stdin or in an existing
protected file. Tokens never enter diagnostics, traces or run records.


## Agent execution contract

The full audit remediation adds one scoped `commands schema <path...>` view, rather than a new
root or a schema mode on message commands. It describes raw argv inputs, result schemas, effects,
permissions, conditional arguments and safe-retry semantics in JSON Schema 2020-12. Open provider
extensions must be labelled; a structural schema is not evidence of complete business validation.
CLI and MCP use the same domain result definitions where available. MCP structured outputs are
validated against any output schema advertised by the server.

The shared shell adds these conventions; the manifest tracks adoption:

- `--no-input` prohibits prompts and browser login. JSON/JSONL with a TTY also suppresses prompts.
  Non-TTY data piped for an explicit command remains usable. Confirmation flags never lift deny.
- `--max-input-bytes` bounds buffered stdin (16 MiB by default); cancellation releases listeners
  and does not leave an open read waiting for EOF. Secrets have a tighter 64 KiB bound.
- One-shot actions have a 30-second default budget unless a flag/environment supplies another.
  Help/version and intended watch/serve/MCP lifetimes are exempt. Signals cancel tracked resources;
  SIGINT/SIGTERM follow shell exit conventions. Broken pipes end quietly without a stack trace.
- `--fields` projects machine result fields; list pagination/coverage metadata stays present.
  `--max-output-bytes` bounds serialized machine data (4 MiB; zero explicitly disables the bound).
  Exceeding a bound fails visibly with retryable:false, never a malformed or silently cropped JSON
  response. File exports retain their streaming contract.
- A global `--dry-run` validates parsed arguments and permission policy, then reports a preview
  without invoking the action, reading credentials or reserving a write. Local command-specific
  previews keep their richer behaviour. A preview declares unresolved targets and preparatory
  effects; it is never a guarantee that a subsequent write will succeed.
- Errors expose safe retry metadata. Unknown remote write outcomes remain non-retryable unless a
  provider confirms replay safety with the same caller-owned id. operationId is correlation only.
- Installed skills are checked against binary discovery. Synthetic task evaluations cover command
  selection, bounded paging, validation recovery and refusing replay after an unknown write outcome.

These defaults are technical execution limits, not profile data or new config-file keys.
User pages explain the effective defaults and how to override them after consumer adoption.

## Option catalogue

Every option of both tools, once: its value, what it means, its default and the commands that take
it. An option means one thing wherever it appears; a new one is added to `parity.json` first, with
its meaning, and this table is regenerated from it. **Bold** marks a clash still to resolve.

<!-- option catalogue: generated by `pnpm parity:render` from parity.json -->

| Option | Value | Meaning | Default | Commands |
|---|---|---|---|---|
| `--accept-terms` |  | accept the model's licence terms, for a model that has its own |  | `models text download` |
| `--add` | `<chat>` | put a chat into a folder; repeat it for more |  | `bot webhooks set` (max-only), `chats folders update` |
| `--after-id` | `<id>` | read what came after this message id; not with --after-time or the --before pair |  | `messages list` |
| `--after-n` | `<n>` | how many messages after it |  | `messages context` |
| `--after-time` | `<time>` | read what came after this ISO 8601 time, or 2h / 1d ago; not with --after-id or the --before pair |  | `messages list` |
| `--agent` | `<agent>` | install the skill for this agent; asks at a terminal, otherwise none |  | `setup` (planned) |
| `--agent-json` |  | agent-safe JSON output: control and direction characters visible in strings and keys; combine with --jsonl for streams |  | every command (planned) |
| `--ai` |  | call the configured reply model with stored message data; requires reply consent, otherwise uses fallback |  | `replies test` |
| `--all` |  | every row, no paging. **chats requests accept and decline take every pending request instead — Telegram counts them against its hourly limit first; MAX has no way to answer them all at once and refuses it, naming chats requests list — so it differs on purpose (Help text rule 4)** |  | `attachments list`, `chats list`, `chats members list` (planned), `chats requests accept`, `chats requests decline`, `contacts list`, `inbox` (planned), `messages download`, `review` (planned), `store export`, `store fetch` |
| `--all-bots` |  | also read every other bot's copy on this machine that readOtherBots allows |  | `bot contacts show`, `bot messages between`, `bot search messages` |
| `--all-can-pin` | `<on\|off>` | every member may pin messages |  | `chats update` |
| `--allow-any-file` |  | send a --file even from credential folders or the tool's own folders |  | `bot messages send`, `messages send` |
| `--allow-chats` | `<ids>` | replace allowed chat ids, comma-separated; empty clears |  | `replies audience` |
| `--allow-dangerous` |  | go ahead without the question an ask level puts before a deletion |  | `bot chats moderate`, `bot mcp`, `bot mcp config`, `bot messages delete`, `chats clear` (planned), `chats delete` (planned), `chats moderate` (planned), `mcp` (planned), `mcp config` (planned), `mcp doctor` (planned), `mcp setup` (planned), `messages delete`, `store clear` |
| `--allow-delete` |  | offer the tool that deletes messages for you only; it cannot be undone. **retired access flag: accepted with a warning, grants no permissions in either CLI** |  | `bot mcp`, `bot mcp config`, `mcp`, `mcp config`, `mcp doctor` (planned), `mcp setup` (planned) |
| `--allow-mark-read` |  | offer the tool that marks a chat read; the other person sees it. **retired access flag: accepted with a warning, grants no permissions in either CLI** |  | `mcp`, `mcp config`, `mcp doctor` (planned), `mcp setup` (planned) |
| `--allow-moderate` |  | offer the tool that applies a group's rules — delete others' messages, remove people. **retired access flag: accepted with a warning, grants no permissions in either CLI** |  | `bot mcp`, `bot mcp config`, `mcp` (planned), `mcp config` (planned), `mcp doctor` (planned), `mcp setup` (planned) |
| `--allow-people` | `<ids>` | replace allowed sender ids, comma-separated; empty clears |  | `replies audience` |
| `--allow-send` |  | offer the send tool; without it the server can only read. **retired access flag: accepted with a warning, grants no permissions in either CLI** |  | `bot mcp`, `bot mcp config`, `mcp`, `mcp config`, `mcp doctor` (planned), `mcp setup` (planned) |
| `--allow-writes` |  | acknowledge that the profile offers writing tools when installing local MCP |  | `mcp setup` (planned) |
| `--analyze` |  | link conversation batches using the configured analysis provider, with remembered chat/provider consent |  | `conversations build` |
| `--anonymous` |  | nobody sees who voted for what |  | `polls create` |
| `--answer` | `<id>` | only those who chose this answer, as `polls show` prints it |  | `polls voters` (tg-only) |
| `--answerer` | `<person>` | stored name, alias, @username, ID or scoped person locator; ambiguous names require a choice; repeat it for more |  | `stats chats newcomers`, `stats contacts responses`, `stats messages unanswered` |
| `--app` | `<how>` | the first time only: how to get this profile's app from my.telegram.org | `browser` | `session start` (tg-only), `setup` (planned) |
| `--approval` |  | who joins by it asks first, and an admin lets them in |  | `chats link create` (planned), `chats link update` (tg-only) |
| `--as` | `<state>` | how a task is closed: done, or dismissed — it needs no answer |  | `tasks close` |
| `--as-file` |  | send every --file as a plain file to download, a video included |  | `bot messages send`, `messages send` |
| `--as-reply` |  | send as a reply to the matched message |  | `replies edit` |
| `--at-time` | `<time>` | let the messenger send it later, even with this machine off: a local time like 2026-09-25T09:00, or 30m |  | `messages send` |
| `--attachment` | `<n>` | which file of the message, from 1; needed when it has more than one |  | `attachments show`, `attachments text set` |
| `--backend` | `<archive\|server\|both>` | where to search: the local archive, the messenger's server, or both (default: both; message discovery uses archive only) |  | `search messages` |
| `--background` |  | run as a job that outlives this command; `store jobs show` follows it |  | `store fetch`, `store gaps repair` |
| `--base-url` | `<url>` | a server with OpenAI's /v1/embeddings: Gemini, Jina, or Ollama and LM Studio on this machine |  | `conversations build`, `conversations embed`, `conversations embed clear`, `conversations embed status`, `conversations related`, `conversations status`, `search conversations` |
| `--batch` | `<id>` | the batch id `conversations batches next` printed |  | `conversations links add` |
| `--before-id` | `<id>` | read what came before this message id; not with --before-time |  | `chats media` (planned), `messages comments` (tg-only), `messages evidence`, `messages list` |
| `--before-n` | `<n>` | how many messages before it |  | `messages context` |
| `--before-time` | `<time>` | read what came before this ISO 8601 time, or 2h / 1d ago; not with --before-id |  | `messages list`, `tasks list` |
| `--block` | `<value>` | Set to `true` if user should be blocked in chat. |  | `bot chats members remove` |
| `--bot` |  | the bot section of the profile's settings, rather than the personal account's |  | `config set` (planned), `config show` (planned), `config unset` (planned) |
| `--bots` | `<profiles>` | also read these bots' copies, comma separated — each allowed by readOtherBots |  | `bot contacts show`, `bot messages between`, `bot search messages` |
| `--budget` | `<pages>` | at most this many pages of a list, with a pause between them |  | `chats members audit`, `chats members fetch` (planned) |
| `--by` | `<grouping>` | what to count by. **each command names its own groupings — stats messages show chat, sender, day or hour, and searches create the same for stats messages show --saved; stats chats show day or week, as a series beside its totals — so it differs on purpose (Help text rule 4)** |  | `searches create`, `stats charts`, `stats chats retention`, `stats chats show`, `stats messages show` |
| `--calls` | `<who>` | who may call: everyone, contacts or nobody |  | `account privacy set` (planned) |
| `--can` | `<rights>` | what they may do, comma-separated: read, members, admins, info, pin, link, post, edit, delete. **lists the rights each messenger has — MAX has `read`, Telegram does not — so it differs on purpose (Help text rule 4)** |  | `bot chats admins add`, `chats admins add` |
| `--caption-above` |  | show the text above the --photo or --file, not below it |  | `messages send` (tg-only) |
| `--catch-up` |  | prepare local search after this fetch |  | `store fetch`, `store gaps repair` |
| `--catch-up-chunks` | `<n>` | at most this many local vector chunks |  | `store fetch`, `store gaps repair` |
| `--catch-up-messages` | `<n>` | skip a graph rebuild above this message budget |  | `store fetch`, `store gaps repair` |
| `--catch-up-time` | `<duration>` | time budget for local preparation |  | `store fetch`, `store gaps repair` |
| `--channel` |  | a private channel instead of a group; people join it by its link |  | `chats create` |
| `--chart-kind` | `<messages\|active\|membership>` | what to draw: messages, active authors, or joins and leaves | `messages` | `stats charts` |
| `--chat` | `<chat>` | a chat, by id or name; repeat it for more. **chat addressing follows each messenger's supported names, usernames and Saved Messages aliases, so it differs on purpose (Help text rule 4); both message searches resolve stored names without networking** |  | `attachments extract`, `attachments list`, `chats folders create`, `contacts context`, `conversations batches next`, `conversations batches status`, `conversations build`, `conversations consents revoke`, `conversations embed`, `conversations embed clear`, `conversations embed status`, `conversations links clear`, `conversations list`, `conversations status`, `metadata get`, `metadata refresh`, `review`, `search conversations`, `search mail`, `search messages`, `searches create`, `stats contacts responses`, `stats contacts top`, `stats messages counters refresh`, `stats messages counters show`, `stats messages discussion`, `stats messages show`, `stats messages top`, `stats messages unanswered`, `stats tasks show`, `tags add`, `tags auto`, `tags remove`, `tasks list` |
| `--chat-invites` | `<who>` | who may add the account to groups and channels: everyone, contacts or nobody |  | `account privacy set` (planned) |
| `--chats` | `<ids>` | only these chat ids, comma-separated; empty for any |  | `replies edit` |
| `--check` |  | say whether a newer version exists, and install nothing |  | `bot list`, `upgrade` |
| `--checkpoints` | `<durations>` | elapsed joining ages to inspect, such as 1d,7d,30d |  | `stats chats retention` |
| `--chunk-bytes` | `<n>` | maximum source bytes returned from a retained attachment; 1–1048576 | `524288` | `attachments show` |
| `--close-time` | `<delay>` | it closes by itself this long after sending, like 90s or 5m |  | `polls create` (tg-only) |
| `--closed` | `<on\|off>` | on closes a forum topic to new messages, off reopens it |  | `topics edit` (tg-only) |
| `--comment-to` | `<post>` | comment on this channel post; the comment goes to the post's discussion group |  | `messages send` (tg-only) |
| `--component` | `<name>` | the ranking component whose contributing messages or answer pairs to read |  | `stats contacts evidence`, `stats messages evidence` |
| `--concurrency` | `<n>` | remote: requests at once (default: 4) |  | `attachments extract`, `conversations embed` |
| `--confirm-send` |  | no longer used: MCP writes show no form; the profile's permissions decide. **retired: accepted with a warning so an old setup still starts** |  | `bot mcp`, `bot mcp config`, `mcp`, `mcp config`, `mcp doctor` (planned), `mcp setup` (planned) |
| `--contact` | `<person>` | the person to tag or untag: their id, @username or name, as the local store knows them |  | `tags add`, `tags remove` |
| `--contacts-only` |  | match only contacts |  | `replies edit` |
| `--context` | `<n>` | messages before and after each hit |  | `search mail`, `search messages`, `searches create` |
| `--correct` | `<n>` | with --quiz: the right answer's position, from 1 |  | `polls create` (tg-only) |
| `--counters` | `<names>` | the counter fields: views,reactions,comments |  | `stats messages counters refresh`, `stats messages counters show` |
| `--cursor` | `<cursor>` | continue from the extraction or ranking-evidence cursor |  | `attachments extract`, `stats contacts evidence`, `stats messages evidence` |
| `--days` | `<days>` | days of the working window, such as mon-fri or sat,sun |  | `replies edit` |
| `--deep` | `<n>` | also check the top n in full — profile, photos, everything they wrote, and the public ban lists, which are sent their ids — one person a second. **TG specializes the SDK help with the bounded Telegram audit; MAX retains the generic SDK wording. Align the shared help with provider capabilities separately; SDK adoption alone does not remove the difference.** |  | `chats members audit` |
| `--defaults` |  | change what every profile gets, rather than this profile |  | `config set`, `config unset` |
| `--deny-chats` | `<ids>` | replace denied chat ids, comma-separated; empty clears; deny wins |  | `replies audience` |
| `--deny-people` | `<ids>` | replace denied sender ids, comma-separated; empty clears; deny wins |  | `replies audience` |
| `--description` | `<text>` | the new about text — of a chat or of your account |  | `account update`, `chats update` |
| `--dims` | `<n>` | remote: the vector size — needed with --base-url; shortens an OpenAI model's |  | `conversations embed`, `conversations embed clear`, `conversations embed status`, `conversations related`, `conversations status`, `search conversations` |
| `--discover` |  | find partial lexical matches and eligible replies in the local archive; results are evidence, not confirmed answers |  | `search messages` |
| `--do` | `<actions>` | actions: reply, task, or both, comma-separated |  | `replies edit` |
| `--download` |  | first save, from the messenger, the files no download saved yet |  | `attachments extract` |
| `--dry-run` |  | judge and plan; do nothing. **A command-specific dry run keeps its richer plan; otherwise the shared shell previews arguments and permissions without running the action. Targets remain unresolved unless that command provides a preview.** |  | every command, `bot chats moderate`, `chats moderate` (planned), `config migrate`, `stats messages counters refresh`, `store repair`, `tags auto` |
| `--emoji` | `<emoji>` | the folder's icon |  | `chats folders create` (planned), `chats folders update` (planned) |
| `--encrypt` |  | compress and encrypt with a password, typed at a hidden prompt or piped on stdin; never kept |  | `store backup`, `store export` |
| `--estimate` |  | only say what the fetch would cost, from this machine's copy; nothing is sent. **max's own copy is worded differently until T6 moves the command onto the shared one (e13)** |  | `store fetch` |
| `--events` |  | also print edits, deletions and reactions; every line then names its event. **watch updates use this flag independently of the group event --type filter** |  | `bot watch`, `watch` |
| `--exact` |  | bare words and quotes match their exact form only, as exact:word does; text: still matches every form |  | `search all`, `search mail`, `search messages`, `search notes`, `searches create`, `stats contacts responses`, `stats contacts top`, `stats messages counters refresh`, `stats messages counters show`, `stats messages discussion`, `stats messages show`, `stats messages top`, `stats messages unanswered` |
| `--exclude-chat` | `<chat>` | never show this chat in the folder; repeat it for more |  | `chats folders create` (planned), `chats folders update` (planned) |
| `--expire-time` | `<time>` | it stops working then: 2026-09-25T09:00 (local time), or 30m, 2h, 7d from now |  | `chats link create` (planned), `chats link update` (tg-only) |
| `--extract` |  | extract text from files mapped by this download |  | `messages download` |
| `--failed` |  | every chat whose newest job failed or died |  | `store jobs retry` |
| `--fields` | `<paths>` | only these comma-separated fields of machine result items; preserves list metadata |  | every command |
| `--file` | `<file>` | attach a file; images go as a photo, videos as a video. Repeat it for more |  | `bot messages send`, `contacts notes add`, `contacts notes edit`, `messages send` |
| `--filename` | `<name>` | the name others see for the --file, instead of its name on disk |  | `messages send` (planned) |
| `--filter` | `query` | Strict Lucene filter: any message in the conversation must match; the meaning query stays unchanged. **search notes uses it for a query every note must also match, the meaning half unchanged** |  | `search conversations`, `search notes` |
| `--find-by-phone` | `<who>` | who finds the account by its number: everyone, contacts or nobody |  | `account privacy set` (planned) |
| `--fingerprint` | `<hash>` | refuse if the inspected coverage plan changed |  | `store gaps repair` |
| `--first-name` | `<name>` | your first name |  | `account update` |
| `--folder` | `<id>` | only this notes folder, by its id; repeat it for more |  | `search notes` |
| `--for` | `<agents>` | which agents a skill is installed for: claude, agents or all | `all` | `skill install` (planned) |
| `--for-everyone` |  | delete for everyone in the chat, not only for you — they cannot get it back |  | `messages delete` |
| `--format` | `<format>` | jsonl, one message per line, or a markdown transcript. **the shared `store export` takes `jsonl` or `markdown`, max's own takes `jsonl` or `md` (e4)** |  | `store export` |
| `--from` | `<who\|link>` | sender to match in `bot search messages`; starting message link in tg bot store fetch |  | `bot search messages`, `bot store fetch` (tg-only) |
| `--from-dir` | `<dir>` | read nonrecursive files from this directory for one explicit chat |  | `attachments extract` |
| `--hidden` | `<on\|off>` | on hides a forum's General topic from the topic list, off shows it |  | `topics edit` (tg-only) |
| `--hide-online` | `<on\|off>` | hide online status and last seen |  | `account privacy set` (planned) |
| `--history` |  | the people added also see the messages from before they came |  | `chats members add` (max-only) |
| `--html` |  | the text is HTML: <b>, <i>, <a href>, <code> |  | `bot messages edit`, `bot messages send`, `messages edit` (planned), `messages send` (planned) |
| `--http` |  | serve MCP over HTTP on 127.0.0.1 behind the owner's tunnel, with a one-owner login. **MAX spells out that profile permissions decide; Telegram wording catches up at its next shared SDK adoption** |  | `mcp` |
| `--http-confirmation` | `<mode>` | no longer used: MCP writes show no form; the profile's permissions decide. **retired: accepted with a warning so an old setup still starts** |  | `mcp` |
| `--idle` | `<duration>` | stop after this long with nobody using it — 15m, 1h |  | `serve` (max-only), `server restart` (max-only), `server start` (max-only) |
| `--if-sha256` | `<hash>` | require the whole retained file to match this previous SHA256 |  | `attachments show` |
| `--include` | `<kinds>` | a folder takes every chat of these kinds: contacts, non-contacts, groups, channels, bots |  | `chats folders create` (planned), `chats folders update` (planned) |
| `--join-approval` | `<on\|off>` | people ask to join, and an admin lets them in |  | `chats update` (tg-only) |
| `--json` |  | machine-readable output: one JSON value on stdout, nothing else |  | every command |
| `--jsonl` |  | machine-readable output: one JSON object per line, for streaming and jq |  | every command |
| `--kind` | `<kind>` | only chats of this kind: dialog, group, channel or saved |  | `chats list`, `inbox`, `review`, `store export` |
| `--kinds` | `<kinds>` | chat kinds: dialog, group; comma-separated, empty for any |  | `replies edit` |
| `--language` | `<lucene\|legacy>` | the query language: strict Lucene or legacy discovery | `lucene` | `search messages`, `searches create` |
| `--last` | `<n>` | stop once the newest n messages are held; not with --since. **max's own copy is worded differently until T6 moves the command onto the shared one (e13)** |  | `bot store fetch`, `store fetch` |
| `--last-name` | `<name>` | your last name |  | `account update` |
| `--left` |  | only the chats this account has left |  | `store clear` |
| `--limit` | `<n>` | how many: rows to show, or messages one run fetches. **max's own copy is worded differently until T6 moves the command onto the shared one (e13)** |  | `attachments extract`, `attachments list`, `bot chats members list` (max-only), `bot contacts show`, `bot messages between`, `bot messages list`, `bot search messages`, `bot store fetch`, `calls list` (planned), `chats link list` (planned), `chats list`, `chats media` (planned), `chats members list` (planned), `chats requests list`, `contacts context`, `contacts list`, `conversations list`, `conversations related`, `inbox`, `messages comments` (tg-only), `messages evidence`, `messages list`, `metadata refresh`, `polls voters` (tg-only), `runs list`, `search all`, `search conversations`, `search mail`, `search messages`, `search notes`, `searches create`, `searches history`, `sends list`, `stats chats newcomers`, `stats chats retention`, `stats contacts evidence`, `stats contacts responses`, `stats contacts top`, `stats messages counters refresh`, `stats messages counters show`, `stats messages discussion`, `stats messages evidence`, `stats messages show`, `stats messages top`, `stats messages unanswered`, `store fetch`, `store gaps repair`, `tags auto`, `tasks list` |
| `--lines` | `<n>` | how many lines | `50` | `server logs` |
| `--link` | `<link>` | an invite link: only the requests made through it. **chats requests list filters by it; accept and decline take it with --all — one link, worded for each command (Help text rule 4)** |  | `chats requests accept`, `chats requests decline`, `chats requests list` |
| `--local` |  | use the model on this machine, never the messenger |  | `messages transcribe` (tg-only) |
| `--mark-read` |  | also mark the chat read up to the newest message shown; the other person sees it |  | `inbox`, `messages list`, `review` |
| `--marker` | `<value>` | Marker |  | `bot chats members list` (max-only) |
| `--max-actions` | `<n>` | at most this many actions in one run | `10` | `bot chats moderate`, `chats moderate` (planned) |
| `--max-age` | `<duration>` | the observation-age threshold for a fresh counter snapshot |  | `stats messages counters show` |
| `--max-chats` | `<n>` | at most this many chats in one run. **local graph work defaults to 20; opt-in --sync-first network refresh defaults to 5, so help distinguishes the two uses** | `20` | `conversations build`, `conversations embed`, `search conversations`, `search messages`, `stats contacts top`, `stats messages show`, `stats messages top` |
| `--max-chunks` | `<n>` | at most this many chunks embedded in one run | `2000` | `conversations embed`, `search conversations` |
| `--max-gaps` | `<n>` | maximum interior coverage gaps repaired in this run |  | `store gaps repair` |
| `--max-input-bytes` | `<bytes>` | at most this many bytes of buffered stdin | `16777216` | every command |
| `--max-messages` | `<n>` | fetch at most this many messages total (default: 500) |  | `search conversations`, `search messages`, `stats contacts top`, `stats messages counters refresh`, `stats messages show`, `stats messages top` |
| `--max-output-bytes` | `<bytes>` | at most this many serialized bytes of machine data; 0 disables the bound | `4194304` | every command |
| `--max-replies` | `<n>` | maximum observed discussion replies |  | `stats messages discussion` |
| `--max-tokens` | `<n>` | remote embeddings: bound input tokens; analysis: reserve input and output tokens across this run |  | `conversations build`, `conversations embed` |
| `--max-uses` | `<n>` | at most this many people join by it, 1 to 99999 |  | `chats link create` (planned), `chats link update` (tg-only) |
| `--md` |  | read this messenger's Markdown; see its formatting guide for supported syntax |  | `bot messages edit`, `bot messages send`, `messages edit`, `messages send` |
| `--measure` | `<name>` | the metric used to order a ranking; not with --score or --weights |  | `stats contacts top`, `stats messages top` |
| `--members-see-link` | `<on\|off>` | members may see the invite link |  | `chats update` (max-only) |
| `--mentions-me` |  | require a mention of you or a reply to you |  | `replies edit` |
| `--message` | `<message>` | the message to tag or untag: its id in --chat, or a msg: locator alone |  | `tags add`, `tags remove` |
| `--message-kind` | `<all\|posts\|comments>` | the proven kind of messages selected before ranking | `all` | `stats contacts top`, `stats messages top` |
| `--method` | `<method>` | how to log in when there is no session |  | `setup` (planned) |
| `--min-messages` | `<n>` | minimum selected messages for a ranked author | `1; 5 for engaging unless explicitly set` | `stats contacts top` |
| `--min-score` | `<n>` | only rows scoring at least this |  | `chats members audit` |
| `--min-views` | `<n>` | minimum known cumulative views |  | `stats messages discussion` |
| `--model` | `<id>` | which downloaded speech model hears them; `models audio list` shows them. **max's own copy is worded differently until T6 moves the command onto the shared one (e13); replies edit uses this option for legacy template mode: fill-only or may-reword; use ai blocks instead** |  | `conversations build`, `conversations embed`, `conversations embed clear`, `conversations embed status`, `conversations links clear`, `conversations related`, `conversations status`, `inbox`, `messages list`, `messages transcribe`, `replies edit`, `review` (planned), `search conversations` |
| `--multiple` |  | people may pick several answers |  | `polls create` |
| `--needs-text` |  | only files saved here whose text nobody has yet: what an agent reads and writes back |  | `attachments list` |
| `--new` |  | what arrived since the last check, each message once — for scheduled runs |  | `inbox`, `review` |
| `--newest` |  | newest first instead of best first |  | `bot search messages`, `search mail`, `search messages`, `searches create` |
| `--no-approval` |  | anyone with it joins at once |  | `chats link update` (tg-only) |
| `--no-as-reply` |  | send without linking to the matched message |  | `replies edit` |
| `--no-ban` |  | remove without banning; by default a removed person cannot come back by the link |  | `bot chats moderate` |
| `--no-catch-up` |  | skip local preparation after this fetch |  | `store fetch`, `store gaps repair` |
| `--no-contacts-only` |  | do not require a contact |  | `replies edit` |
| `--no-hours` |  | clear the working window |  | `replies edit` |
| `--no-input` |  | never prompt or open an interactive login; piped input remains available |  | every command |
| `--no-mark-read` |  | do not mark read, whatever the catchUpMarksRead setting says |  | `inbox`, `review` |
| `--no-mentions-me` |  | do not require a mention of you or a reply to you |  | `replies edit` |
| `--no-preview` |  | no preview card for a link in the text |  | `messages send` |
| `--no-question` |  | do not require a question |  | `replies edit` |
| `--no-record` |  | do not keep it, whatever the configuration says |  | every command |
| `--no-registries` |  | do not ask the public ban lists; nothing about them leaves this machine. **TG clarifies that profile and photo reads still use Telegram when public registries are disabled; MAX retains the generic SDK wording. Public registry queries apply to Telegram only.** |  | `contacts check` |
| `--no-serve` |  | do not start it; log in on this command's own connection unless one is running |  | every command (planned) |
| `--not-chats` | `<ids>` | leave these chat ids out, comma-separated; empty clears |  | `replies edit` |
| `--not-people` | `<ids>` | leave these sender ids out, comma-separated; empty clears |  | `replies edit` |
| `--notification` | `<text>` | a note only the person who pressed sees |  | `bot callbacks answer` |
| `--notify` |  | tell the chat's members about the pin |  | `bot messages pin`, `messages pin` |
| `--ocr` |  | explicitly call models.ocr for bulk image and scanned-PDF text extraction; agents normally transcribe files themselves |  | `attachments extract` |
| `--offline` |  | answer from what was recorded and never connect; fails if nothing was |  | every command |
| `--offset` | `<n>` | skip this many, for the next page |  | `search notes` |
| `--offset-bytes` | `<n>` | start byte offset in a retained attachment | `0` | `attachments show` |
| `--older-than` | `<duration>` | minimum age of a question without an observed qualifying answer |  | `stats messages unanswered` |
| `--online` |  | also log in once, read one chat and start the MCP server; sends nothing. **max's own copy is worded differently until T6 moves the command onto the shared one (e13)** |  | `doctor` |
| `--only` | `<resources>` | only these resources, separated by commas: messages, mail, notes |  | `search all` |
| `--only-admins-add` | `<on\|off>` | only admins may add members |  | `chats update` |
| `--only-admins-call` | `<on\|off>` | only admins may start a call |  | `chats update` (max-only) |
| `--only-missing` |  | only chats with no metadata yet; without --chat, every stored group/channel |  | `metadata refresh` (planned) |
| `--only-owner-edits-info` | `<on\|off>` | only the owner may change the name and photo |  | `chats update` (max-only) |
| `--order` | `<recent\|name>` | newest conversation first, or alphabetical |  | `contacts list` |
| `--others` |  | every session but this one. **max's own copy is worded differently until T6 moves the command onto the shared one (e13)** |  | `account sessions end` |
| `--output` |  | where to write: a directory for `messages download`, a file for `store export`. **MAX `messages download --output <dir>` remains a compatibility alias for `--output-dir`; other commands use --output for a file — e10** | `.` | `doctor report create`, `messages download` (max-only), `stats charts`, `store decrypt`, `store export` |
| `--output-dir` | `<dir>` | the folder to write into, created if missing. **`attachments extract` takes it only with --download, and has no default there, so extraction never fills the working folder unasked** | `.` | `attachments extract`, `messages download` |
| `--outside` | `<hours>` | answer outside this 24-hour window, such as 09:00-19:00 |  | `replies edit` |
| `--page` | `<n>` | which page, starting at 1 |  | `attachments list`, `attachments show` (planned), `chats list`, `chats members list` (planned), `contacts list` |
| `--page-size` | `<n>` | how many items one request to the messenger asks for; the messenger's own if not given. **the default is each messenger's own page: 30 on MAX, 100 on Telegram** |  | `bot store fetch`, `store fetch`, `store gaps repair` |
| `--pause` | `<duration>` | the least wait between pages, 5s or 500ms; each is up to twice that. **max's own copy is worded differently until T6 moves the command onto the shared one (e13)** | `5s` | `bot store fetch`, `messages download`, `store fetch`, `store gaps repair` |
| `--payload` | `<text>` | the start parameter the bot reads; a link's own ?start= when not given |  | `chats start` (planned) |
| `--people` | `<ids>` | only these sender ids, comma-separated; empty for any |  | `replies edit` |
| `--per-chat` | `<limit>` | at most this many per chat, such as 1/12h |  | `replies edit` |
| `--per-person` | `<limit>` | at most this many per person, such as 1/1d |  | `replies edit` |
| `--permission` | `<key=level>` | override a permission for this MCP server only; repeat for more keys |  | `mcp`, `mcp config`, `mcp doctor`, `mcp setup` |
| `--personal` |  | the personal account's section of the profile's settings |  | `config set` (planned), `config unset` (planned) |
| `--phone-number` | `<who>` | who sees the number: everyone, contacts or nobody |  | `account privacy set` (planned) |
| `--photo` | `<file>` | an image file — a profile photo in `account update`, a group's photo in `chats update`, a photo to send in `messages send` |  | `account update`, `bot messages send`, `chats update` (planned), `messages send` |
| `--pin` | `<chat>` | pin this chat at the top of the folder; repeat it for more |  | `chats folders create` (planned), `chats folders update` (planned) |
| `--pinned` | `<on\|off>` | on pins a forum topic at the top of the list, off unpins it |  | `topics edit` (tg-only) |
| `--port` | `<port>` | the local port for --http |  | `mcp` |
| `--provider` | `<provider>` | embedding provider: local or openai; analysis: agent, openai or anthropic; consents revoke: exact provider identity from the list |  | `conversations build`, `conversations consents revoke`, `conversations embed`, `conversations embed clear`, `conversations embed status`, `conversations related`, `conversations status`, `search conversations` |
| `--public-url` | `<url>` | the tunnel's https address the browser apps use |  | `mcp` |
| `--qr-file` | `<png>` | write the QR code to this PNG instead of drawing it, for an agent to pass on |  | `session start` (tg-only), `setup` (planned) |
| `--question` |  | match only questions |  | `replies edit` |
| `--quiet` |  | diagnostics off. **max's own copy is worded differently until T6 moves the command onto the shared one (e13)** |  | every command |
| `--quiz` |  | a quiz: one answer is right, and a vote is final |  | `polls create` (tg-only) |
| `--reason` | `<text>` | why a task was closed, kept with it — no-reply-needed, for example |  | `tasks close` |
| `--record` |  | keep this run under `runs` — ids and timings, never message content. **max's own copy is worded differently until T6 moves the command onto the shared one (e13)** |  | every command |
| `--refresh` |  | read the private chat with them from MAX first — one request. **one idea, two sources: bring what the answer is read from up to date first. `bot contacts show` reads the private chat again from the messenger; `conversations search` builds and embeds, on this machine, the chats that changed (NEED-551 A, awaiting the owner's wording)** |  | `bot contacts show`, `contacts context`, `search conversations` |
| `--refresh-metadata` |  | read current descriptions from the messenger before classifying |  | `tags auto` |
| `--regex` |  | the words are one regular expression, case-insensitive, tested against every stored text |  | `search messages`, `searches create` |
| `--remove` | `<chat>` | take a chat out of a folder; repeat it for more |  | `chats folders update` |
| `--repair-time` | `<duration>` | time budget for interior archive gap repair |  | `store gaps repair` |
| `--replace` |  | overwrite a saved search of the same name |  | `searches create` |
| `--reply` | `<mode>` | answer all or only listed senders and chats: all, listed |  | `replies audience` |
| `--reply-to` | `<message>` | answer this message id in the same chat |  | `bot messages send`, `messages send` |
| `--retract` |  | take your vote back, where the poll allows it |  | `polls vote` |
| `--revision` | `<number>` | the revision you read before editing |  | `contacts notes edit` |
| `--revoke` |  | forget every login given to a browser app over --http |  | `mcp` |
| `--revoked` |  | the links you stopped, instead |  | `chats link list` (planned) |
| `--revote` |  | people may change their vote |  | `polls create` |
| `--run` | `<id>` | the run the report is about; the newest failed one if not given |  | `doctor report create` |
| `--saved` | `<name\|id>` | run a saved search, or an earlier run by its id; options typed with it replace its own, more words are AND-ed |  | `search messages`, `stats chats newcomers`, `stats contacts responses`, `stats contacts top`, `stats messages discussion`, `stats messages show`, `stats messages top`, `stats messages unanswered` |
| `--score` | `<helpful\|active\|engaging>` | the named ranking score preset; not with an explicit --measure |  | `stats contacts top`, `stats messages top` |
| `--search` | `<text>` | only chats whose name contains this; at least 3 characters |  | `chats list`, `chats requests list`, `contacts list` |
| `--search-notes` | `<text>` | only people whose private notes contain this text |  | `contacts list` |
| `--secret-stdin` |  | a secret MAX sends back in X-Max-Bot-Api-Secret — asked for, or read from a pipe |  | `bot webhooks set` |
| `--selection` | `<json>` | the versioned resolved ranking selection returned by drilldown; authorisation is checked again |  | `searches create`, `stats contacts evidence`, `stats messages counters refresh`, `stats messages counters show`, `stats messages evidence` |
| `--send-as` | `<id>` | send as one of the identities `chats send-as` lists for the chat; required where the chat posts as someone else by default, refused where the messenger has none |  | `messages forward`, `messages send`, `polls create` |
| `--send-id` | `<id>` | identify a send or creation attempt; message/poll retries reuse it, while an unknown topic creation must never be repeated |  | `messages forward`, `messages send`, `polls create`, `topics create` (tg-only) |
| `--serve` |  | start `serve` in the background if it is not running (the default) |  | every command (planned) |
| `--server-time` | `<duration>` | stop waiting for the server after this long (default: 5s) |  | `search messages` |
| `--set` | `<id>` | the stickers in this set |  | `stickers list` (planned) |
| `--show-phone` |  | print the whole phone number |  | `account show`, `contacts profile` |
| `--silent` |  | deliver without a notification |  | `bot messages send`, `messages forward`, `messages send`, `polls create` |
| `--since` | `<id-or-time>` | from this message id, an ISO 8601 time, or 2h / 1d ago; each command says its default. **becomes `--since-time` everywhere — NEED-485** |  | `inbox` (planned), `review` (planned) |
| `--since-time` | `<time>` | from this ISO 8601 time, or 2h / 1d ago; each command says its default |  | `bot chats moderate`, `bot store fetch`, `chats events` (planned), `chats members history` (planned), `chats moderate` (planned), `contacts context`, `conversations list`, `inbox` (planned), `replies test`, `review` (planned), `search conversations`, `stats charts`, `stats chats newcomers`, `stats chats retention`, `stats chats show`, `store export`, `store fetch` |
| `--size` | `<n>` | messages to answer per batch, 10–200; 50 by default |  | `conversations batches next`, `conversations batches status`, `conversations build` |
| `--skip` | `<which>` | a folder leaves out chats that are muted, read or archived |  | `chats folders create` (planned), `chats folders update` (planned) |
| `--sms` |  | phone login: ask Telegram to send the code by SMS, not to the app; Telegram may still refuse |  | `session start` (tg-only) |
| `--solution` | `<text>` | with --quiz: what people see once they answered |  | `polls create` (tg-only) |
| `--source` | `<messenger>` | every account of this messenger held in the store; personal, bots or all — the same as in: in the query |  | `search conversations`, `search messages`, `searches create`, `stats contacts responses`, `stats contacts top`, `stats messages counters refresh`, `stats messages counters show`, `stats messages discussion`, `stats messages show`, `stats messages top`, `stats messages unanswered`, `tags list`, `tags remove` |
| `--spoiler` |  | hide the --photo or video behind a spoiler until tapped |  | `messages send` (tg-only) |
| `--start` | `<param>` | the start parameter the app reads |  | `chats app` (planned) |
| `--state` | `<state>` | only those in this state: tasks open, done or dismissed; jobs running, done, failed, cancelled or died |  | `store jobs list` (planned), `tasks list` |
| `--sticker` | `<id>` | send this sticker, alone; stickers list finds its id |  | `messages send` (planned) |
| `--store-token` | `<profile>` | keep a returned authentication token only in this bot profile's OS keyring; never print it |  | `bot api` |
| `--sync-first` |  | first fetch new messages within the chat, time and message bounds |  | `search conversations`, `search messages`, `stats contacts top`, `stats messages show`, `stats messages top` |
| `--sync-time` | `<duration>` | stop fetching after this long (default: 30s) |  | `search conversations`, `search messages`, `stats contacts top`, `stats messages counters refresh`, `stats messages show`, `stats messages top` |
| `--tag` | `<tag>` | only this tag |  | `search notes`, `tags list` |
| `--template` | `<text>` | the reply template |  | `replies edit` |
| `--text` | `<text>` | the message's new text; - reads stdin |  | `bot callbacks answer` |
| `--text-file` | `<path>` | read the text from this file; - or none reads stdin |  | `attachments text set` |
| `--thread` |  | the stored reply chain and replies instead of time neighbours; falls back when no graph exists |  | `messages context`, `search messages` |
| `--thread-bytes` | `<n>` | at most this many bytes of whole messages and links in each context (default: 65536) |  | `messages context`, `search messages` |
| `--thread-hops` | `<n>` | at most this many links from the hit (default: 8) |  | `messages context`, `search messages` |
| `--thread-messages` | `<n>` | at most this many messages in each thread context (default: 50) |  | `messages context`, `search messages` |
| `--thread-within` | `<duration>` | messages within this long either side of the hit (default: 1d) |  | `messages context`, `search messages` |
| `--threads` | `<n>` | threads in all | `min(8, cores)` | `conversations embed` |
| `--timeout` | `<duration>` | give up on the whole command after this — 30s, 2m, 500ms |  | every command |
| `--timezone` | `<zone>` | the IANA timezone for calendar date boundaries. **replies edit uses this option for the IANA timezone for the working window** | `system IANA timezone` | `replies edit`, `search all`, `search conversations`, `search mail`, `search messages`, `search notes`, `searches create`, `stats charts`, `stats chats newcomers`, `stats chats retention`, `stats chats show`, `stats contacts responses`, `stats contacts top`, `stats messages counters refresh`, `stats messages counters show`, `stats messages discussion`, `stats messages show`, `stats messages top`, `stats messages unanswered` |
| `--title` | `<title>` | the new name — of a chat, a folder or a forum topic |  | `bot chats admins add`, `chats folders update`, `chats update`, `topics edit` (tg-only) |
| `--to` | `<chat>` | the chat to forward it to: an id, or part of a chat name. **the sentence says how to name a chat the messenger's way, so it differs on purpose (Help text rule 4)** |  | `messages forward`, `store export` |
| `--topic` | `<id>` | address this forum topic: send or forward to it, read only it, or mark only it read. **Telegram group forums only; MAX explicitly refuses this option before sending** |  | `chats mark-read`, `messages forward` (tg-only), `messages list` (planned), `messages send`, `polls create` |
| `--trace` |  | one line per request on stderr: ids and timings, never message content. **max logs one line per request, tg the connection's own lines: the same option, a different mechanism (Help text rule 4)** |  | every command |
| `--track` |  | also do it daily while serve runs |  | `chats members fetch` (planned) |
| `--transcribe` |  | hear voice messages not heard yet, on this machine; slow, the model must be downloaded. **max's own copy is worded differently until T6 moves the command onto the shared one (e13)** |  | `inbox`, `messages list`, `review` |
| `--type` | `<names>` | only these types. **each command names its own types — chats events the messenger's event types, comma-separated, as it names them; tags list chat, contact or message; tasks list question, request, mention or promise, and tasks add gives the new task one of them — search messages text, voice or file, and search notes internal or file — so it differs on purpose (Help text rule 4)** |  | `chats events` (planned), `chats media` (planned), `search messages`, `search notes`, `stats tasks show`, `tags list`, `tasks add`, `tasks list` |
| `--types` | `<value>` | Comma separated list of update types your bot want to receive |  | `bot watch`, `bot webhooks set` |
| `--unanswered` | `[duration]` | only questions to you or a group's admins that nobody answered, asked at least this long ago — 4h, 1d. **max's own `review` still takes bare hours until T6 moves it (e2)** | `24h` | `review` |
| `--unread` |  | only chats with unread messages |  | `chats list` |
| `--until` | `<message>` | only up to this message id, inclusive; the newest by default |  | `chats mark-read`, `chats mute` (planned) |
| `--until-time` | `<time>` | through this ISO 8601 time, or 2h / 1d ago |  | `stats chats newcomers`, `stats chats retention` |
| `--upgrade` |  | explicitly upgrade a basic group to a supergroup before enabling topics; its chat id changes |  | `topics enable` (tg-only) |
| `--verbose` |  | more detail in what is shown: -v ids, -vv everything known | `0` | every command |
| `--version` |  | print the version number |  | every command |
| `--voice` | `<file>` | send an Ogg Opus file as a voice message, alone, with no text |  | `bot messages send`, `messages send` |
| `--weights` | `<json>` | the complete ranking component weights; replaces preset weights when --score is given |  | `stats contacts top`, `stats messages top` |
| `--with-notes` |  | include your private notes, subject to contacts.notes.list permission |  | `contacts show` |
| `--within` | `<duration>` | the observation window after a known join; each report names what it measures |  | `stats chats newcomers`, `stats chats retention` |
| `--words` | `<words>` | match any of these whole words, comma-separated; empty clears |  | `replies edit` |
| `--workers` | `<n>` | sessions in parallel, each with its own copy of the model |  | `conversations embed` |
| `--yes` |  | go ahead without the question an ask level puts before a write |  | every command, `account sessions end` (planned), `mcp` (planned), `mcp config` (planned) |

<!-- end of the option catalogue -->

## Output

1. **Every list answers one envelope** in `--json`: `{ items, page, limit, hasMore }` —
   `renderPage` in [`src/cli/paging.ts`](../../src/cli/paging.ts) prints it. `--jsonl` streams the
   items one per line. A list never answers a bare array.
   - A list with no pages (`store status`, `server logs`) answers `page: 1`, `limit` the count and
     `hasMore: false` — `listed` in the same file.
   - A list paged by a message rather than a page number (`messages list`, `chats events`) answers
     `page: 1`; `hasMore` says whether there is more on the far side of the last item.
   - Fields about the whole list go beside the four, never instead of them (`models audio list`'s
     `directory`).
   - `inbox` and `review` are not lists: they answer one view grouped by chat, `{ chats: [{ …,
     messages }] }`, in both tools.
2. **A write answers what it did**: `{ operationId, … }`, the ids it touched after it. The same
   id is in the send journal.
3. **A one-thing view answers the object itself** (`account show`, `store info`).
4. **An error is one JSON object on stderr** in the machine modes —
   `{ "error": { "code", "message" } }` — stdout stays empty, and the exit code says which kind of
   failure it was. Commander's own parse errors (a missing argument, a missing required option)
   still print a text line and exit 1; they move to `validation_error` and 2. The codes are
   cli-core's and the same in both tools:

   | Code | Meaning |
   |---|---|
   | 0 | ok |
   | 1 | generic failure |
   | 2 | validation error — the command line is wrong |
   | 3 | configuration error |
   | 4 | authentication error |
   | 5 | permission error |
   | 6 | not found |
   | 7 | confirmation required |
   | 8 | rate limited |
   | 9 | timeout |
   | 10 | network error |
   | 11 | provider error — the messenger refused |
   | 12 | provider unavailable |
   | 13 | invalid response |
   | 14 | outcome unknown — a write may or may not have happened |
   | 130 | cancelled |

5. **A shared command answers the same shape in both tools.** What only one messenger knows goes
   under `providerMetadata`, never as a top-level field one tool has and the other lacks.
6. **`server status` answers one shape in both tools** (NEED-494 B). Not running is a result,
   `running: false`, exit 0.

   | Field | Meaning |
   |---|---|
   | `profile` | the profile asked about |
   | `running` | a server answers for it |
   | `pid` | its process |
   | `startedAt` | when it started |
   | `connected` | logged in, with updates arriving |
   | `connectedAt` | since when, where the tool knows it |
   | `by` | who started it: `unit` (systemd or launchd), `server` (`server start`), `hand` (`serve` typed in a terminal), `command` (max: a command that needed it) |
   | `version`, `cliVersion` | what the server runs, and what this tool is — they differ after an update, and a note on stderr says `server restart` |
   | `log` | where its log is |
   | `unit` | `{ name, path, installed, loaded, active, detail }` |
   | `stale` | `{ pid, startedAt }` — a lock or socket file was left by a server that is gone |

   Starting and stopping in the background is `server start` and `server stop` only; `serve` is
   the foreground command a unit or a person runs (rules 4 and 9).

## Permissions

What a profile may do is one setting, `permissions`: a JSON object whose keys are command paths and
whose values are levels. It holds for a command the owner types and for an agent over MCP alike.

```json
{ "permissions": { "messages": "allow", "messages.delete": "ask", "contacts": "readonly" } }
```

1. **Four levels.**
   - `deny` — nothing, not even reading: the command answers `permission_error` (5) before it
     connects, and an agent is not offered its tool.
   - `readonly` — reads work, writes answer `permission_error`. On a key that only writes
     (`messages.delete`) it is `deny`.
   - `ask` — in a terminal, a y/N question that shows what will change, default no. A flag skips
     it: `--allow-dangerous` for a deletion, `--yes` for every other write. With no terminal and
     no flag the command answers `confirmation_required` (7). Over MCP,
     `ask` permits the requested write without a server form; separate moderation rule consent
     remains authoritative.
   - `allow` — goes ahead and never asks.
2. **A key is a command path**: `messages`, `messages.delete`, `chats.members.remove`,
   `account.sessions.end`. **The most specific key the owner set wins**; there is no wildcard, and a
   key starts with a resource, so a misspelled one is refused rather than ignored. Every command
   maps to exactly one key, checked by a test over `commands --json`:
   - a command that shows messages from outside `messages` counts as `messages` — `inbox`,
     `review`, `watch`, `serve`, `store fetch|export|search`, the MCP resources and prompts;
   - housekeeping is never gated — `config`, `session`, `doctor`, `commands`, `complete`,
     `upgrade`, `skill`, `models`, `server`, `runs`, `sends`, `recipients`, `mcp`, and `store`'s
     own maintenance.
3. **The defaults allow almost everything**, so the tool works without questions. Only what cannot
   be undone asks:

   ```json
   { "messages.delete": "ask", "account.sessions.end": "ask" }
   ```

   A default is never tightened without the owner's word. **A built-in default only ever tightens**:
   against a broader key of the owner's, the stricter of the two holds — `messages: readonly` still
   stops a deletion, and `messages: allow` keeps its question until `messages.delete` is named.
4. **Limits no level lifts**: an agent never deletes for everyone and never ends other sessions.
5. **A group's moderation rules use the same four levels** for each kind of action (delete,
   remove, accept, decline), `readonly` meaning "report it, do nothing". A rule's level can only be
   as loose as the profile's level for `chats.moderate`.
6. **The settings it replaces** — `readOnly`, `allow`, max's `mcpTools`, and the moderation words
   `forbid`, `flag`, `confirm` — are translated once by `config migrate`, then refused with a
   message naming the new key. The MCP flags it replaces are accepted with a warning naming the
   setting for one release, so a configured agent still starts, then go.

7. **A bot's keys are the personal ones under `bot`**: `bot.messages.send`,
   `bot.chats.members.remove`, `bot.webhooks`. A profile can allow its bot what it does not allow
   its personal account, and the other way round; `bot` alone covers every bot command. The default
   is the personal one's: `bot.messages.delete: ask`. Housekeeping under `bot` is never gated —
   `bot auth`, `bot list`, `bot recipients`, `bot sends`, `bot mcp`. The bot's old `readOnly` and
   `allow` words are translated by `config migrate` with the personal ones.

What it does not decide stays separate: the recipient list (which chats), `sendsPerHour` (how
many), `--allow-any-file` (which files).

## Retention and counter observation contract

The owner approved the retention and counter observation contract
on 2026-10-08. Retention is a chat report; counters is a distinct subresource of messages.
Counter refresh is an explicit bounded remote read and local write; ordinary statistics remain
stored reads. Snapshot times and unknown denominators are exposed, never inferred from ingestion.

## Administrator statistics contract

The owner approved the four stored-data report views and option meanings in the
admin statistics contract on 2026-10-08.
They are implemented by the shared stats service. Reports use explicit reply evidence and preserve
unknown history and join times. They share the existing stats namespace and MCP frontend.

## Planned ranking contract

The owner-approved ranking views and their options are recorded in the
ranking command contract. Rankings operate on
stored messages under `stats messages top` and their human authors under `stats contacts top`;
ordinary search does not gain ranking modes. The owner also approved `stats messages evidence`
and `stats contacts evidence` for bounded component drilldown on 2026-10-07. The manifest
labels all feature paths and options as planned until implementation.

## MCP

`stats charts --output` selects SVG or PNG by the file extension; images never go to stdout.
The stored-only `stats_charts` tool accepts optional `format: json|png` (default `json`).
PNG adds `image/png` content and JSON text `{ chart, image: { format, width, height } }`;
it writes no file and uses the same `messages` read permission.

1. **Three tools, not one per command** (NEED-766): `<tool>_tools_search` finds commands by words
   and gives each one's arguments; `<tool>_read` runs a command that only reads and `<tool>_write`
   one that changes something, as `{ "command": "messages list", "arguments": { … } }`. A command
   is its CLI path. The bot server's three are `<tool>_bot_tools_search`, `<tool>_bot_read` and
   `<tool>_bot_write`, and its commands are the path under `bot`. `status` answers what the server is.
   `conversations refresh` runs what `search conversations --refresh` runs before it searches
   (NEED-551 A). The list never changes during a connection.
2. **Arguments are the command's options in snake_case**, with the option's name: `--send-id` is
   `send_id`, `--since-time` is `since_time`, `--before-n` is `before_n`.
3. **Every command says whether it writes**; `read` refuses a writing one and `write` a reading one.
4. **A command is found and run by its [permission](#permissions)**, never by a flag of its own:
   `deny` hides it, `readonly` hides the writing ones, `ask` and `allow` act — no form, since nobody
   is at a terminal to answer (NEED-772, NEED-773). `--confirm-send`, `--allow-dangerous`,
   `--http-confirmation`, `--allow-send`, `--allow-mark-read` and `--allow-delete` decide nothing any
   more: they are accepted with a warning, so an agent set up with them still starts.
5. **Unknown arguments are refused before execution.** A retired schedule field must never turn
   a scheduled write into an immediate one. Consumers retaining their own session use the public
   personal MCP catalogue and registration seam, filtering only unsupported capabilities.
6. **A tool and its command run the same service method**, so they answer the same result and the
   same error for the same input.

## Help text

`<cli> commands search messages --json` describes one command; `<cli> commands messages --json`
includes the group's descendants. Give one command path per call; inspect different groups in
separate calls. Scoped discovery keeps `globalOptions` and `exitCodes`, adds
the canonical `scope` path, and lists options from non-root ancestors in `inheritedOptions`
as `{ path, options }` entries. Aliases resolve to canonical command names. Unknown or hidden
paths return `validation_error` (exit 2), with the valid commands at that level. The full tree
remains available through `<cli> commands --json`, with no scoped fields.

1. **A description says what the command does, as the user sees it**, in one line, lower case, no
   full stop, no internal term — no wire field, no port, no adapter.
2. **A shared command has the same sentence in both tools.** It is one command; the shared factory
   writes the description, and a CLI changes it only to name its messenger.
3. **An option's description says what it changes and its unit**: `--pause <duration>` "wait this
   long between pages".
4. **A shared option has one sentence in both tools**, checked by the parity workflow
   (`cli-messaging-parity wording <max.json> <tg.json>`; each file is known by its `cli`, so it takes
   any number, in any order). A difference is allowed only where the sentence names something the messenger's own way — how to name a chat, which rights or events it
   has — and the option's catalogue `note` says so; a note also marks a difference still open, and
   names who closes it.

## Layers and sharing

1. **Shared by default.** Code goes here unless it names a messenger. A feature one messenger has
   and the other could have (topics, polls) is still a port group and a shared command; it is
   CLI-local only when the other messenger cannot have it — MAX's socket server, Telegram's app
   registration.
2. **Layers:** command or MCP tool → service → port group → adapter. A command never calls an
   adapter method directly for a use case a service owns ([ARCHITECTURE](ARCHITECTURE.md#services)).
   A new adapter method goes into a named group in `port.ts`, never the core.
3. **No messenger type above the adapter.** Here, `biome.json` refuses the import; in a CLI, the
   adapter translates into the domain model and nothing above it imports the messenger library.
4. **A CLI replaces a use case, not a command** — through `Messenger.services`, so its command and
   its MCP tool both get the replacement.

## Documents

1. **Each user page of max has a tg page on the same question**, at the same depth: installing,
   using, configuring, security, troubleshooting, diagnostics, groups. max's pages are Russian,
   tg's English.
   Both follow the docs site's page set (WireCatLabs/cli-docs `docs/STRUCTURE.md`): `index.md` is the
   site's short start page, `archive.md` the local store, `roadmap.md` what is coming. Pages one tool
   has alone, and why:
   - max `bot.md` — tg has no bot side yet; its page comes with it (P8).
   max's reverse-engineered protocol is `docs/dev/protocol.md`, a developer page, not a user one.
2. **The README is the full introduction, and max's is the model.** Users read it first, so it is
   not cut down to a landing page. Both READMEs have these sections in this order: the bot, the
   personal account, how to use it, groups you run, how it works, what it can do, why it is good,
   custom work, how it differs, contents, install, log in, use, for scripts and agents, security,
   documentation, development, roadmap, licence, contributing.
3. **A change to a command changes its page in both tools** in the same docs pull request.
4. **A page names only options that exist or are planned.** Each CLI's CI runs
   `<cli> commands --json | cli-messaging-parity <cli> --pages README.md docs/*.md`: an option a user
   page puts on a command must be on that command, or be in this manifest for it and not only for the
   other tool. A change that drops an option fails until its pages stop naming it.

## The parity manifest

`parity.json`, shipped in this package, lists every command path and option of every tool. Its
`clis` names them (`["max", "tg"]`). Each CLI's CI checks its own `commands --json` against its
column of the manifest in the version of this package it installed (`pnpm parity:check`).

Each row says which CLIs have it:

```json
"messages list": { "in": "all" },
"polls":         { "in": ["max"], "reason": "Telegram polls are …" },
"store clear":   { "in": ["tg"], "planned": { "max": "T6" } }
```

| Field | Meaning | What `parity:check` checks for a CLI |
|---|---|---|
| `in` | `"all"`, or the CLIs from `clis` that have it | listed: present in this tool |
| `planned` | a CLI outside `in` → who closes the gap (a workstream) | planned: nothing — present or absent both pass |
| `reason` | why the CLIs neither in `in` nor planned lack it; required when there are any | neither: absent in this tool |

An option is the same object, or the bare string `"all"`. A row only one CLI has, with a `reason`,
covers every path below it. A row with `"subtree": true` and a plan does the same, for a whole
command tree a tool has yet to build: `bot` is one row.

**A new CLI joins with one command:** `pnpm parity:seed --cli <name>` adds it to `clis` and plans
every row and option for it, by `"?"`. Its parity check passes from its first pull request, and the
gaps stay listed. Its author then narrows the rows:
moves the CLI into `in` where it has the command, names who closes each plan, and gives a reason where
it never will. `pnpm parity:seed <commands.json...>`, one file per CLI, adds the rows the CLIs have
and the manifest lacks; a row already there is never changed.

**How a new command or option reaches CI without a release of this package per row.** The docs
pull request that introduces it adds its row as planned, here, before any code. Planned passes
whether the command exists or not, so the code pull request in any CLI lands on the manifest
already released. The flip to `in` goes into the next release of this package with whatever else
it carries; a row is never the only reason for a release.

**A row puts a CLI in `in` only when that tool has it on its own `main`.** A shared command that one
CLI does not use yet — max keeps its own `messages edit` until it moves onto the shared one — stays
planned for it, by the workstream that moves it. So does an option a CLI still has and is about to
drop. Flipped early, the row fails that CLI's `parity:check` on its next upgrade of this package and
blocks the upgrade.

**This repository checks every tool's `main` against its own manifest** (`.github/workflows/parity.yml`):
on a pull request that touches the manifest or the check, on every push to `main`, and daily. It
builds tg-cli and max-cli from their `main` and runs the same check, so a row flipped early fails
here, before the release that would carry it — not weeks later, when a CLI upgrades. The published
CLIs are not the reference: a release always trails `main`, so they lag every row that gains a CLI.
A new CLI is added to the workflow's matrix and its wording job when its repository exists.

**The milestone audit is one command:** `pnpm parity:audit --fresh` clones and builds every tool's
`main` and prints, besides the manifest's state, what CI does not fail on: the shared version each
tool pins, the MCP tools each offers, the user pages and their headings, the README sections, and the
release and QA scripts and skills. Each MCP server starts in an empty temporary home, so nothing
reaches Telegram or MAX. `--max <dir> --tg <dir>`, one option per CLI in `clis`, uses checkouts already
built.

## Search preparation and archive gaps

Approved2026-10-07. These additive shared surfaces are implemented in the search follow-up plan.

- `attachments extract --from-dir <dir>` reads a nonrecursive directory for one explicitly named
  `--chat`; it cannot be combined with `--download` or `--output-dir`. MCP `attachments_extract`
  uses `from_dir`, `download`, `output_dir` and `limit`, matching CLI semantics. A bounded
  scan returns `cursor`; pass it as MCP `cursor` or CLI `--cursor` to continue.
- `messages download --extract` extracts only the files this download mapped to stored attachments.
- Per-profile `searchCatchUp` defaults to false. `store fetch --catch-up` or `--no-catch-up` overrides
  it; `--catch-up-chunks`, `--catch-up-messages` and `--catch-up-time` bound local preparation.
  Defaults are500chunks,10,000messages and30seconds for the fetched chat. It never downloads a model
  or activates a remote embedding/analysis provider.
- `store gaps plan <chat>` inspects recorded coverage locally. `store gaps repair <chat>` explicitly
  fetches interior gaps; `--max-gaps`, `--limit`, `--repair-time`, provider `--page-size` and `--pause`
  bound the operation. `--background` uses existing jobs. MCP names are `store_gaps_plan` and
  `store_gaps_repair`; options use underscores. Defaults are5gaps,500messages and30seconds.
- Local extraction/preparation require their write permissions. Gap repair requires permission for
  its explicit fetch. A dry plan is read-only; gaps never authorize deletion or weaker rate limits.

## Attachment OCR

Approved2026-10-07. Contract: agent self-OCR
and `attachments text set` are the default. `attachments extract --ocr`
explicitly selects gateway API OCR for bulk extraction using models.ocr;
`--concurrency` retains its remote-request meaning, default4, range1–8 here, and
requires --ocr. Existing local extraction without --ocr never invokes a model.
MCP uses the same service and explicit selection. Local paths do not transfer
files to remote agents; binary/artifact transport remains separate.

## Local attachment document readers

Reader contract: UTF-8/BOM and bounded
high-confidence legacy decoding; ODT/ODS/XLSX/PPTX/EPUB digital text, using the existing
extract/text/index commands. No remote model call for locally readable files, including
an explicit --ocr run. Generic archives, legacy Office and RTF remain external conversion.
Agent text and previous good text survive automated failures; no partial structured text
is indexed as a complete result. Existing PDF/Word optional packages remain optional.
