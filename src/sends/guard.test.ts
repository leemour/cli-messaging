import { existsSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { describe, expect, it, vi } from "vitest"
import { flooded } from "../cli/messenger/flooded.js"
import type { MessengerAdapter } from "../cli/messenger/port.js"
import { FloodMemory } from "./flood.js"
import { sendGuard } from "./guard.js"
import { guardedWrite } from "./guarded.js"
import { SendJournal, sendsPathFor as sendsPath } from "./journal.js"
import { RecipientList, recipientsPathFor as recipientsPath } from "./recipients.js"
import { newSendId } from "./send-id.js"

const app = { command: "app", appName: "app-cli", envPrefix: "APP", description: "", version: "0" }
const env = { APP_STATE_DIR: mkdtempSync(join(tmpdir(), "app-sends-")) }
const sendsPathFor = (profile: string) => sendsPath(app, profile, env)
const recipientsPathFor = (profile: string) => recipientsPath(app, profile, env)

describe("the send guard", () => {
  const guardAt = (profile: string, time: string, sendsPerHour: number) =>
    sendGuard({
      profile,
      readOnly: false,
      readOnlyFrom: "default",
      sendsPerHour,
      journal: new SendJournal(sendsPathFor(profile)),
      recipients: new RecipientList(recipientsPathFor(profile), app.command),
      warn: () => {},
      now: () => new Date(time),
    })

  it("applies provider destructive defaults while honoring explicit leaf permission and broader denial", async () => {
    const make = (permissions: Record<string, "allow" | "readonly">) =>
      sendGuard({
        profile: "api-defaults",
        readOnly: false,
        readOnlyFrom: "default",
        permissions,
        permissionDefaults: { "bot.api.rotate": "ask" },
        sendsPerHour: Infinity,
        journal: new SendJournal(sendsPathFor("api-defaults")),
        recipients: new RecipientList(recipientsPathFor("api-defaults"), app.command),
        warn: () => {},
      })
    const request = { chatId: null, key: "bot.api.rotate" }
    expect(() => make({}).check(request)).toThrow(/asks before/)
    await expect(make({}).ask?.(request)).rejects.toThrow()
    expect(() => make({ "bot.api.rotate": "allow" }).check(request, { reserve: false })).not.toThrow()
    expect(() => make({ bot: "readonly" }).check(request)).toThrow(/does not let/)
  })

  it("forgets sends older than an hour, and names the moment the limit opens again", () => {
    const journal = new SendJournal(sendsPathFor("g-window"))
    for (const at of ["2026-09-24T08:00:00Z", "2026-09-24T09:10:00Z", "2026-09-24T09:20:00Z", "2026-09-24T09:30:00Z"]) {
      journal.append({ at, profile: "g-window", chatId: "111", outcome: "sent" })
    }

    expect(() =>
      guardAt("g-window", "2026-09-24T09:40:00Z", 4).check({ chatId: "111" }, { reserve: false }),
    ).not.toThrow()
    // Lowered below what the hour holds: it opens when enough sends have aged out, not the first.
    expect(() => guardAt("g-window", "2026-09-24T09:40:00Z", 2).check({ chatId: "111" })).toThrow(
      "at 2026-09-24T10:20:00.000Z",
    )
  })
})

describe("two senders at once", () => {
  const guard = (profile: string, sendsPerHour: number, time = "2026-09-24T09:00:00Z") =>
    sendGuard({
      profile,
      readOnly: false,
      readOnlyFrom: "default",
      sendsPerHour,
      journal: new SendJournal(sendsPathFor(profile)),
      recipients: new RecipientList(recipientsPathFor(profile), app.command),
      warn: () => {},
      now: () => new Date(time),
    })

  it("at the limit, only one passes: the first holds its place while its send is on the way", () => {
    const first = guard("g-race", 1)
    const second = guard("g-race", 1)

    expect(() => first.check({ chatId: "111" })).not.toThrow()
    expect(() => second.check({ chatId: "111" })).toThrow("the next send is possible")

    first.record({ chatId: "111", outcome: "sent" })
    expect(new SendJournal(sendsPathFor("g-race")).entries()).toMatchObject([{ chatId: "111", outcome: "sent" }])
  })

  it("journals the command a write names, so a poll is told from a message, and never the people", () => {
    const one = guard("g-key", 5)
    one.check({ chatId: "111", key: "polls.create" })
    one.record({ chatId: "111", outcome: "sent", key: "polls.create", personIds: ["9"] } as never)
    const [entry] = new SendJournal(sendsPathFor("g-key")).entries()
    expect(entry).toMatchObject({ chatId: "111", key: "polls.create" })
    expect(entry).not.toHaveProperty("personIds")
  })

  it("gives the place back when the send failed", () => {
    const first = guard("g-race-failed", 1)
    first.check({ chatId: "111" })
    first.record({ chatId: "111", outcome: "failed" })

    expect(() => guard("g-race-failed", 1).check({ chatId: "111" })).not.toThrow()
  })

  it("waits out a lock another process holds, and clears one a dead process left", () => {
    const lock = `${sendsPathFor("g-lock")}.lock`
    mkdirSync(dirname(lock), { recursive: true })
    writeFileSync(lock, "")
    utimesSync(lock, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000))

    expect(() => guard("g-lock", 1).check({ chatId: "111" })).not.toThrow()
    expect(existsSync(lock)).toBe(false)
  })

  it("counts a scheduled message in the hour it goes out, not the hour it was queued", () => {
    const at = "2026-09-24T09:00:00Z"
    guard("g-later", 1, at).check({ chatId: "111", scheduledFor: "2026-09-24T15:00:00Z" })

    expect(() => guard("g-later", 1, at).check({ chatId: "111" })).not.toThrow()
    expect(() => guard("g-later-2", 1, at).check({ chatId: "111", scheduledFor: "2026-09-24T15:00:00Z" })).not.toThrow()
    expect(() => guard("g-later-2", 1, at).check({ chatId: "111", scheduledFor: "2026-09-24T15:30:00Z" })).toThrow(
      "the next send is possible",
    )
  })

  it("counts each person added to a group, and refuses more at once than the limit", () => {
    expect(() =>
      guard("g-people", 2).check({ chatId: "111", kind: "chat", action: "members.add", personIds: ["1", "2", "3"] }),
    ).toThrow("3 at once is more than the hourly limit")
  })

  it("counts an accepted join request, as a person added, and not a declined one", () => {
    const decline = { chatId: "111", kind: "chat" as const, action: "requests.decline" as const }
    guard("g-requests", 1).check(decline)
    expect(() => guard("g-requests", 1).check(decline)).not.toThrow()

    const accept = { chatId: "111", kind: "chat" as const, action: "requests.accept" as const, people: 1 }
    guard("g-requests", 1).check(accept)
    expect(() => guard("g-requests", 1).check(accept)).toThrow("the next send is possible")
  })

  it("counts joining a chat, so joining many is held to the hourly limit", () => {
    const join = { chatId: null, kind: "chat" as const, action: "join" as const }
    guard("g-join", 1).check(join)
    expect(() => guard("g-join", 1).check(join)).toThrow("the next send is possible")
  })

  it("counts each imported number, and refuses more at once than the limit", () => {
    const importing = { chatId: null, kind: "account" as const, action: "contact-import" as const }
    expect(() => guard("g-import-big", 5).check({ ...importing, count: 6 })).toThrow(
      "6 at once is more than the hourly limit",
    )
    guard("g-import", 5).check({ ...importing, count: 4 })
    expect(() => guard("g-import", 5).check({ ...importing, count: 2 })).toThrow("the next send is possible")
    expect(() => guard("g-import", 5).check({ ...importing, count: 1 })).not.toThrow()
  })

  it("weighs accepting every request by how many were counted", () => {
    expect(() =>
      guard("g-requests-all", 2).check({ chatId: "111", kind: "chat", action: "requests.accept", count: 3 }),
    ).toThrow("3 at once is more than the hourly limit")
  })
})

describe("a reaction", () => {
  const guardFor = (profile: string, options: { readOnly?: boolean; sendsPerHour?: number } = {}) =>
    sendGuard({
      profile,
      readOnly: options.readOnly ?? false,
      readOnlyFrom: "config file",
      sendsPerHour: options.sendsPerHour ?? 1,
      journal: new SendJournal(sendsPathFor(profile)),
      recipients: new RecipientList(recipientsPathFor(profile), app.command),
      warn: () => {},
    })

  it("is refused by a read-only profile and by the recipient list, but not counted by the limit", () => {
    expect(() => guardFor("g-react-ro", { readOnly: true }).check({ chatId: "111", kind: "reaction" })).toThrow(
      "cannot send, react, change chats or change the account",
    )

    new RecipientList(recipientsPathFor("g-react-list"), app.command).add({
      id: "111",
      title: null,
      addedAt: "2026-09-24T00:00:00Z",
    })
    expect(() => guardFor("g-react-list").check({ chatId: "222", kind: "reaction" })).toThrow(
      /not on the recipient list.*`app g-react-list recipients add 222`/s,
    )

    const journal = new SendJournal(sendsPathFor("g-react-limit"))
    journal.append({
      at: new Date().toISOString(),
      profile: "g-react-limit",
      chatId: "111",
      outcome: "sent",
      kind: "reaction",
    })
    expect(() => guardFor("g-react-limit").check({ chatId: "111", kind: "message" })).not.toThrow()
    journal.append({ at: new Date().toISOString(), profile: "g-react-limit", chatId: "111", outcome: "sent" })
    expect(() => guardFor("g-react-limit").check({ chatId: "111", kind: "reaction" })).not.toThrow()
    expect(() => guardFor("g-react-limit").check({ chatId: "111", kind: "message" })).toThrow(
      "the next send is possible",
    )
  })
})

describe("a retry of a send whose outcome was unknown", () => {
  const guard = (profile: string) =>
    sendGuard({
      profile,
      readOnly: false,
      readOnlyFrom: "default",
      sendsPerHour: 1,
      journal: new SendJournal(sendsPathFor(profile)),
      recipients: new RecipientList(recipientsPathFor(profile), app.command),
      warn: () => {},
    })

  it("is not a second send when it repeats the send id in the same chat", () => {
    const first = guard("g-retry")
    first.check({ chatId: "-1001", sendId: "-42" })
    first.record({ chatId: "-1001", outcome: "outcome_unknown", sendId: "-42" })

    expect(() => guard("g-retry").check({ chatId: "-1001", sendId: "-42" })).not.toThrow()
    expect(() => guard("g-retry").check({ chatId: "-1001", sendId: "-43" })).toThrow("the next send is possible")
  })

  it("refuses a retry of an unknown send under another identity", () => {
    const first = guard("g-retry-as")
    first.check({ chatId: "-1001", sendId: "-42", sendAs: "-1002" })
    first.record({ chatId: "-1001", outcome: "outcome_unknown", sendId: "-42", sendAs: "-1002" })

    for (const sendAs of [undefined, "-1003"]) {
      expect(() =>
        guard("g-retry-as").check({ chatId: "-1001", sendId: "-42", ...(sendAs ? { sendAs } : {}) }),
      ).toThrow("under another identity")
    }
    expect(() => guard("g-retry-as").check({ chatId: "-1001", sendId: "-42", sendAs: "-1002" })).not.toThrow()
  })
})

describe("an allow-list refusal", () => {
  const refused = (allowFix?: string) =>
    sendGuard({
      profile: "work",
      command: "max",
      readOnly: false,
      readOnlyFrom: "default",
      allow: ["reaction"],
      allowFrom: "config file: personal.defaults",
      ...(allowFix ? { allowFix } : {}),
      sendsPerHour: 10,
      journal: new SendJournal(sendsPathFor("g-allow")),
      recipients: new RecipientList(recipientsPathFor("g-allow"), app.command),
      warn: () => {},
    })

  it("names the command that allows it, the CLI's own when it gives one", () => {
    expect(() => refused().check({ chatId: "1" })).toThrow("to allow it: max work config set allow reaction,send")
    expect(() => refused("max config set --personal --defaults allow").check({ chatId: "1" })).toThrow(
      "to allow it: max config set --personal --defaults allow reaction,send",
    )
  })
})

describe("a permission-level refusal", () => {
  it("uses the caller's fix with the write request, and keeps the personal hint by default", () => {
    const options = {
      profile: "sales",
      command: "tg",
      readOnly: false,
      readOnlyFrom: "default",
      permissions: { "bot.messages.edit": "readonly" as const },
      sendsPerHour: 10,
      journal: new SendJournal(sendsPathFor("g-level-fix")),
      recipients: new RecipientList(recipientsPathFor("g-level-fix"), app.command),
      warn: () => {},
    }
    const request = { chatId: "1", kind: "edit" as const, key: "bot.messages.edit" }
    expect(() => sendGuard(options).check(request)).toThrow("tg sales config set permissions.bot.messages.edit allow")
    const guard = sendGuard({
      ...options,
      permissionFix: (one, key) =>
        `tg sales config set --bot permissions.${key} ${one.kind === "edit" ? "allow" : "deny"}`,
    })
    expect(() => guard.check(request)).toThrow("tg sales config set --bot permissions.bot.messages.edit allow")
  })
})

describe("the journal written by max-cli before it was shared", () => {
  it("reads its numeric cid as the send id", () => {
    const journal = new SendJournal(sendsPathFor("g-cid"))
    journal.append({ at: "2026-09-24T08:00:00Z", profile: "g-cid", chatId: "1", outcome: "sent", cid: 77 } as never)

    expect(journal.entries()).toEqual([
      { at: "2026-09-24T08:00:00Z", profile: "g-cid", chatId: "1", outcome: "sent", sendId: "77" },
    ])
  })
})

describe("a send id", () => {
  it("is a signed 64-bit integer as a string, new every time", () => {
    const ids = new Set(Array.from({ length: 50 }, newSendId))
    expect(ids.size).toBe(50)
    for (const id of ids) {
      expect(id).toMatch(/^-?\d{1,19}$/)
      expect(BigInt(id) >= -(2n ** 63n) && BigInt(id) < 2n ** 63n).toBe(true)
    }
  })
})

describe("topic creation identities", () => {
  const forProfile = (profile: string) =>
    sendGuard({
      profile,
      command: "app",
      readOnly: false,
      readOnlyFrom: "default",
      sendsPerHour: 100,
      journal: new SendJournal(sendsPathFor(profile)),
      recipients: new RecipientList(recipientsPathFor(profile), app.command),
      warn: () => {},
    })
  it.each(["sent", "outcome_unknown"] as const)(
    "refuses an existing %s creation id without treating it as a message retry",
    (outcome) => {
      const profile = `topic-${outcome}`
      const first = forProfile(profile)
      const request = {
        chatId: "7",
        kind: "chat" as const,
        action: "topic-create" as const,
        sendId: "42",
        operationId: "42",
      }
      first.check(request)
      first.record({ ...request, outcome })
      expect(() => forProfile(profile).check(request)).toThrow("already attempted")
    },
  )
  it("reserves under the same lock and permits a known preflight failure to settle", () => {
    const request = {
      chatId: "7",
      kind: "chat" as const,
      action: "topic-create" as const,
      sendId: "42",
      operationId: "42",
    }
    const first = forProfile("topic-reservation")
    first.check(request)
    expect(() => forProfile("topic-reservation").check(request)).toThrow("already attempted")
    first.record({ ...request, outcome: "failed", errorCode: "permission_error" })
    expect(() => forProfile("topic-reservation").check(request, { reserve: false })).not.toThrow()
  })
})

describe("a profile whose writes are held", () => {
  it("**refuses a message before it goes, journals the refusal, and still lets a reaction through**", async () => {
    const profile = "held"
    const flood = new FloodMemory(join(env.APP_STATE_DIR, "flood", `${profile}.json`))
    flood.block({ state: "limited", hint: "Telegram limited this account's messages as spam" })
    const journal = new SendJournal(sendsPathFor(profile))
    const guard = sendGuard({
      profile,
      command: "app",
      readOnly: false,
      readOnlyFrom: "default",
      sendsPerHour: 30,
      journal,
      recipients: new RecipientList(recipientsPathFor(profile), app.command),
      flood,
      warn: () => {},
    })
    const act = vi.fn(async () => ({}))

    const refused = guardedWrite(guard, { chatId: "1", sendId: "9", operationId: "9" }, act)
    await expect(refused).rejects.toMatchObject({
      code: "permission_error",
      details: { standing: { state: "limited" } },
    })
    await expect(refused).rejects.toThrow(
      /do not retry: the owner checks the account with `app held doctor --online`, and lifts the hold with `app held flood clear` once it is over$/,
    )
    expect(act).not.toHaveBeenCalled()
    expect(journal.entries().map((entry) => entry.outcome)).toEqual(["refused"])

    expect(() => guard.check({ chatId: "1", kind: "reaction" })).not.toThrow()
  })
})

describe("a send the messenger asked to hold off on", () => {
  it("**is journaled failed with rate_limited, its reservation settled** — never an unknown outcome", async () => {
    const profile = "remembered"
    const flood = new FloodMemory(join(env.APP_STATE_DIR, "flood", `${profile}.json`))
    flood.remember({ operation: "send", chatId: "1", waitMs: 60_000 })
    const journal = new SendJournal(sendsPathFor(profile))
    const guard = sendGuard({
      profile,
      readOnly: false,
      readOnlyFrom: "default",
      sendsPerHour: 30,
      journal,
      recipients: new RecipientList(recipientsPathFor(profile), app.command),
      flood,
      warn: () => {},
    })
    const inner = { self: () => "1", send: vi.fn(async () => ({})) } as unknown as MessengerAdapter
    const adapter = flooded(inner, flood, { name: "Chat", warn: () => {} })

    await expect(
      guardedWrite(guard, { chatId: "1", sendId: "9", operationId: "9" }, () =>
        adapter.send("1", "hi", { sendId: "9" }),
      ),
    ).rejects.toMatchObject({ code: "rate_limited", details: { remembered: true } })
    expect(inner.send).not.toHaveBeenCalled()
    // One line: the reservation was folded into its outcome, so it no longer counts toward the hour.
    expect(journal.entries()).toEqual([
      expect.objectContaining({ outcome: "failed", errorCode: "rate_limited", sendId: "9" }),
    ])
  })
})
