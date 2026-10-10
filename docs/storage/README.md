# Storage and search

The message store (SQLite through Drizzle, an async API) and local search over it. How the store is
built today is in [ARCHITECTURE, "The store"](../dev/ARCHITECTURE.md#the-store).

| File | Answers |
|---|---|
| [`requirements.md`](requirements.md) | what the owner asked for, verbatim |
| [`decisions.md`](decisions.md) | the storage rulings in force |
| [`schema.md`](schema.md) | every table and column of the store, and what each one means |
| [`messaging.md`](messaging.md) | the messaging store APIs: scopes, nested chats, threads, retention evidence |
| [`search-indexes.md`](search-indexes.md) | how search works: the word indexes, search by meaning — chunks, vectors, the scan, the merge with words |
| [`../../bench/search/`](../../bench/search/) | the benchmark fixture and its results |

Search AI configuration and opt-in analysis: [`../search/ai-providers.md`](../search/ai-providers.md).

`schema.md` is generated: change `scripts/schema/spec.mjs`, run `pnpm schema:render`, then edit `schema.ts` and the
hand-written SQL to match. `pnpm schema:check` (in CI) fails until the spec, `schema.ts` and the page agree.
