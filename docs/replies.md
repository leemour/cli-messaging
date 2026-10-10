# Editing reply rules

Reply rules belong to one profile in its config directory, `<profile>.replies.json`.
`serve` applies enabled rules, within `replies.send`, the file's audience and rate limits. A new file
answers everyone a rule matches; nothing is sent until `replies.send` is `allow`. The editing commands
never connect or send.

Create a disabled rule with every key written out, edit its template, then enable it:

```sh
max replies add after-hours
max replies edit after-hours --template 'Thanks, {firstName}, I will answer later.'
max replies edit after-hours --outside 09:00-19:00 --days mon-fri --timezone Europe/Madrid
max replies on after-hours
max replies off after-hours
```

The same commands work with `tg`. Rule ids contain lowercase letters, digits and hyphens.
`add` refuses duplicate ids. Enabled rules with a `reply` action need a nonempty template;
disabled and task-only rules can keep it empty. Enabling does not grant permission to send.

`edit` changes only flags you give it. Lists are comma-separated, replace the whole list,
and an empty string clears them. Chat and person ids remain strings.

| Fields | Options |
|---|---|
| Actions | `--do reply,task` |
| Chats | `--kinds dialog,group`, `--chats`, `--not-chats` |
| Conditions | `--words`, `--question` / `--no-question`, `--mentions-me` / `--no-mentions-me` |
| Senders | `--people`, `--not-people`, `--contacts-only` / `--no-contacts-only` |
| Reply | `--template`, `--model fill-only`, `--as-reply` / `--no-as-reply` |
| Limits | `--per-chat 1/12h`, `--per-person 1/1d` |
| Hours | `--outside`, `--days`, `--timezone`, `--no-hours` |

First setting hours requires the window, days and timezone together. Later edits may change just
one of them. `--no-hours` clears the window and cannot accompany its fields.

`replies audience` shows the file-level audience. Its flags change only named fields:
`--reply all|listed`, `--allow-people`, `--allow-chats`, `--deny-people`, `--deny-chats`.
The lists use the same replacement and clearing rules. `deny` wins over `allow`.
A file without an audience, or without `reply`, answers everyone a rule matches.
`max replies audience --reply listed --allow-people 1000001` answers only that person;
`max replies audience --deny-people 1000002` answers everyone but them. With `listed` and an empty
allow list nobody is answered; tasks can still open.

A file from before the audience replaced `testers` is read as the audience that answers the same
people: `listed`, allowing the testers of this messenger — or, if it was `listed` already, only the
testers it also allowed. Its allowed chats are dropped, deny lists stay, and an empty `testers`
answers nobody. The next edit writes the converted audience back.
Warnings go to stderr, while `--json` writes only the result to stdout.

Every edit checks both the existing file and the proposed result before an atomic write.
Malformed files are refused without being overwritten. Reply state stays untouched.

## Liquid templates and model blocks

Templates use LiquidJS: `{{ sender.firstName | default: "there" }}`, `{{ sender.name }}`,
`{{ chat.title }}`, `{{ chat.kind }}`, and `{{ now | date: "%H:%M" }}`. Time is in the rule's
working-hours timezone, or UTC without one. Names are values; Liquid syntax in a sender name
is printed literally. The incoming message is never a variable. Unknown variables/filters are
refused; `default` can handle missing values. File include/render/layout tags are forbidden.

Only an AI block can use a model:

```liquid
Thanks, {{ sender.firstName | default: "there" }}.
{% ai %}Write a brief acknowledgement; I will answer tomorrow.{% else %}I will answer tomorrow.{% endai %}
```

The block's rendered body is the instruction, and incoming message text goes separately as untrusted
data. Model output replaces only the block and is never parsed again as Liquid. Text outside the
block remains the owner's text with its normal substitutions. When a provider is missing, a call
fails or consent is absent, the else branch is used. Without one the reply is skipped with a reason.
Nested AI blocks are refused. Per rendering: at most four model calls, 512 output tokens per call,
1024 characters per model block, 4096 final characters, 32768 parsed characters, 65536 allocation
units, 2000 render checks and 100 ms of render time, excluding model waits. Empty, excessive and
full incoming-message echoes are refused. These bounds are tested against LiquidJS 10.30.0;
its typed `templateLimit` is supplemented by a shared render counter.

Configure `models.replies.provider|model|baseUrl`, or fall back to `models.default`, as described
in [provider settings](search/ai-providers.md). Consent is separate from sending permission:

```sh
max replies consents show
max replies consents grant
max replies consents revoke
```

`grant` explicitly allows incoming data to leave this profile for its configured endpoint.
It applies across chats in the profile, except opt-outs: `replies consents deny <chat>` blocks a
native chat id, `allow <chat>` removes that opt-out without granting profile consent. Grant/revoke
keep opt-outs. Changing provider or endpoint needs another grant; revocation or a target change
during a request prevents its output being sent. Pause, rule and audience changes are also checked
after async rendering. Templates still pass through the audience and send-permission gates.

`replies test` shows instructions and fallback without calling a model. `replies test --ai` opts
into sending stored message data to the consented model; it never sends a messenger reply or writes
reply history, and cannot be combined with `--offline`. No model field is needed in new rules.
The command's timeout and stopping serve abort in-flight model requests before shutdown completes.
AI previews also require the profile to permit reading messages.
Old `{firstName}` / `{name}` and `may-reword` files remain readable with warnings; `may-reword`
becomes a whole-template AI block with the original filled text as fallback, so unconfigured files
still produce the same reply.
