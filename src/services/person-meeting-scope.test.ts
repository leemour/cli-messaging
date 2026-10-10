import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { type MessageStore, openStore } from "../store/store.js"
import { type PersonMeetingReadStore, personMeetingContext } from "./person-meeting-context.js"

const opened: MessageStore[] = []
afterEach(async () => {
  for (const store of opened.splice(0)) await store.close()
})
const fixture = async () => {
  const store = await openStore({
    path: join(mkdtempSync(join(tmpdir(), "person-meeting-scope-example-")), "store.db"),
  })
  opened.push(store)
  const own = { provider: "example", account: "alice-profile" }
  const foreign = { provider: "example", account: "bob-profile" }
  const ownId = await store.saveAccount(own, { name: "Alice Example" })
  const foreignId = await store.saveAccount(foreign, { name: "Bob Sample" })
  await store.savePeople(own, [{ id: "alice-example", name: "Alice Example" }])
  // Matching display names deliberately do not authorize the foreign identity.
  await store.savePeople(foreign, [{ id: "foreign-alice-example", name: "Alice Example" }])
  const ownPerson = await store.personOf({ provider: "example", id: "alice-example" })
  const foreignPerson = await store.personOf({ provider: "example", id: "foreign-alice-example" })
  return {
    store,
    ownId,
    foreignId,
    ownPerson: ownPerson as NonNullable<typeof ownPerson>,
    foreignPerson: foreignPerson as NonNullable<typeof foreignPerson>,
  }
}

describe("person meeting account authorization", () => {
  it("denies a foreign-only person before global metadata lookup despite a matching name", async () => {
    const { store, ownId, foreignPerson } = await fixture()
    const personByUid = vi.fn((uid) => store.personByUid(uid))
    const port: PersonMeetingReadStore = {
      personByUid,
      personSeenInAccounts: (uid, accounts) => store.personSeenInAccounts(uid, accounts),
      meetings: store.meetings,
      involvements: store.involvements,
    }
    await expect(
      personMeetingContext(port, `person:${foreignPerson.uid}`, { accountIds: [ownId] }),
    ).rejects.toMatchObject({ code: "not_found" })
    expect(personByUid).not.toHaveBeenCalled()
  })

  it("returns an authorized person and preserves unknown meeting coverage", async () => {
    const { store, ownId, ownPerson } = await fixture()
    expect(await personMeetingContext(store, `person:${ownPerson.uid}`, { accountIds: [ownId] })).toMatchObject({
      person: { uid: ownPerson.uid, name: "Alice Example" },
      items: [],
      coverage: { complete: false },
    })
  })

  it("keeps one account snapshot across awaited authorization and later membership filtering", async () => {
    const { store, ownId, foreignId, ownPerson } = await fixture()
    const accounts = [ownId]
    const personSeenInAccounts = vi.fn(async (uid: string, selected: readonly number[]) => {
      accounts[0] = foreignId
      return store.personSeenInAccounts(uid, selected)
    })
    const forPerson = vi.fn(() => [
      {
        personId: Number(ownPerson.uid),
        identityId: null,
        subjectType: "meeting",
        subjectId: 999,
        role: "participant",
        occurredAt: 1,
        scope: "work",
        accountId: foreignId,
        projectId: null,
        provider: "example",
        account: "bob-profile",
        chat: null,
        message: null,
      },
    ])
    const meeting = vi.fn((id: number) => store.meetings.meeting(id))
    const port: PersonMeetingReadStore = {
      personByUid: (uid) => store.personByUid(uid),
      personSeenInAccounts,
      meetings: { ...store.meetings, meeting },
      involvements: { ...store.involvements, forPerson },
    }
    await personMeetingContext(port, `person:${ownPerson.uid}`, { accountIds: accounts })
    expect(personSeenInAccounts).toHaveBeenCalledWith(ownPerson.uid, [ownId])
    expect(accounts).toEqual([foreignId])
    expect(meeting).not.toHaveBeenCalled()
  })

  it("fails closed on missing scope capability and stops after authorization cancellation", async () => {
    const { store, ownId, ownPerson } = await fixture()
    const personByUid = vi.fn((uid) => store.personByUid(uid))
    const unavailable = {
      personByUid,
      meetings: store.meetings,
      involvements: store.involvements,
    } as unknown as PersonMeetingReadStore
    await expect(
      personMeetingContext(unavailable, `person:${ownPerson.uid}`, { accountIds: [ownId] }),
    ).rejects.toMatchObject({ code: "configuration_error" })
    const controller = new AbortController()
    const port: PersonMeetingReadStore = {
      ...unavailable,
      personSeenInAccounts: async () => {
        controller.abort()
        return true
      },
    }
    await expect(
      personMeetingContext(port, `person:${ownPerson.uid}`, { accountIds: [ownId], signal: controller.signal }),
    ).rejects.toMatchObject({ code: "cancelled" })
    expect(personByUid).not.toHaveBeenCalled()
  })

  it("rejects a mismatched metadata identity after valid presence authorization", async () => {
    const { store, ownId, ownPerson, foreignPerson } = await fixture()
    const port: PersonMeetingReadStore = {
      personByUid: async () => foreignPerson,
      personSeenInAccounts: (uid, accounts) => store.personSeenInAccounts(uid, accounts),
      meetings: store.meetings,
      involvements: store.involvements,
    }
    await expect(personMeetingContext(port, `person:${ownPerson.uid}`, { accountIds: [ownId] })).rejects.toMatchObject({
      code: "invalid_response",
    })
  })
})
