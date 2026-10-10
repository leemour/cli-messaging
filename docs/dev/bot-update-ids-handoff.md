# Handoff — tg-cli fills the bot update id (2026-10-12)

## 1. What this is

`bot watch` in cli-messaging records each update in the store's `bot_updates` and skips one it handled
before — but only when the event carries `update: { id, kind }` (`BotEvent` in
[`src/cli/bot/port.ts`](../../src/cli/bot/port.ts)). The adapters live in tg-cli and max-cli, so until one
fills the field, the table stays empty in real use. This job is tg-cli only: run it from a session started
in tg-cli, after the cli-messaging release that carries `BotEvent.update`.

## 2. Orient in one call

```sh
{ T=/home/leemour/Projects/AI/tg-cli
  echo "== toEvent"; grep -n "export const toEvent" -A40 $T/src/bot/map.ts
  echo "== callers"; grep -rn "toEvent(" $T/src | grep -v test
  echo "== messaging version"; grep -n "cli-messaging" $T/package.json
} > ~/.cache/bot-update-ids-orient.txt 2>&1
```

## 3. Do

1. Bump `@wirecat/cli-messaging` to the release that has `BotEvent.update`.
2. In `toEvent` (`src/bot/map.ts`), return every event with
   `update: { id: String(update.update_id), kind }`, where `kind` is the update's own key (`message`,
   `callback_query`, …) — the same key the `other` branch already computes. One Telegram update is one event.
3. Check: a test in `src/bot-messages.test.ts` that the mapped event carries the id and kind.
4. A CHANGELOG line: a redelivered update is now printed and kept once.

## 4. What bites

1. **Max has no update id.** A Max update has a `timestamp` and the page a `marker`, nothing per update. Do
   not build an id from chat, message and timestamp: an edit of the same message collides, and a join has no
   message. max-cli leaves the field empty; its events behave as before.
2. **`--events --jsonl` lines gain `update`.** Callers can see it — mention it in the CHANGELOG.
