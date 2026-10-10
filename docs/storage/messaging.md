# Messaging store APIs

`openStore` creates the schema described in [schema.md](schema.md). Message and chat IDs in its API are
provider IDs. Canonical person IDs and private note IDs are integer store keys serialized as strings.

An `AccountKey` can supply `scope: "personal" | "work"` when writing. An omitted scope preserves the account's
stored scope. A chat can supply its own `scope` and a provider `parentChatId`; an unclassified chat inherits the
account's scope. `Message.threadId` holds the provider thread identifier, and `threadRootId` can name the root
message explicitly. The store connects the integer root when both messages are present, including a root that
arrives after its replies.

Contact aliases are scoped to an account and identity. Private contact notes belong to the identity and are shared
across accounts that know it. Editing requires the current revision and retains the previous body.

## Bot update log

`store.botUpdates` is built on first access. Its synchronous methods are:

- `save(account, { externalId, kind, payload, receivedAt? })`: records the JSON payload; returns `false` on a duplicate
  account/update ID, preserving the original payload and timestamps.
- `handled(account, externalId)` and `failed(account, externalId, error)`: record the processing outcome.
- `replayed(account, externalId)`: records a replay without replacing the delivery or its handling outcome.
- `recent(account, limit?)`: newest deliveries first; default 100, maximum 1000.

The store records updates; the provider decides how to replay them.

## Person timeline

`store.involvements.rebuild(personId?)` replaces derived rows for one integer person ID, or for everyone when no ID
is supplied. Rebuild after a sync or after linking identities. It runs atomically, so a failed rebuild retains the
previous timeline. `forPerson(personId, { scope?, since?, until?, limit? })` reads the derived index,
newest first, in one query; `since` and `until` are inclusive milliseconds, and a message or chat row carries its
provider, account, chat and message ids. `contacts timeline` rebuilds one person's rows, then reads them.
The default limit is 100 and the maximum is 1000.

Sources include message senders and mentions, current chat members, meeting participants, mail senders and
recipients, task authors and assignees, and confirmed links naming a person or one of their identities. A subject
may appear more than once when the person has distinct roles. Deleted source messages, emails, meetings and tasks
are excluded on rebuild. A chat with no scope inherits its account's scope; tasks inherit their project's scope.

## Conversation vectors

Building a conversation also writes its chunks' scope, account, project and occurrence time. A confirmed `member-of`
link from a chat to a project supplies the project. `nearestConversations` accepts optional `scope`, `projectId`,
`personId`, `since` and `before` filters. Project and person IDs are string forms of integer store keys; times are
ISO strings. `since` is inclusive and `before` exclusive. SQL narrows the candidate chunks before their vectors
are scored; the person filter selects conversations with a sender linked to that person.

## Retention evidence

Every roster read with an observation time is kept in `member_observations`, and who it saw in
`member_observation_members`. Retention reads a checkpoint from the first read inside its tolerance: present when the
read saw the member, absent when a complete read did not, unknown otherwise. These are observations, not evidence of
continuous membership.
