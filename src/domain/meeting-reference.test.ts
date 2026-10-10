import { describe, expect, it } from "vitest"
import { canonicalMeetingReference, formatMeetingReference, parseMeetingReference } from "./meeting-reference.js"

describe("durable local meeting references", () => {
  it("canonicalizes safe IDs without losing the first cue position", () => {
    expect(canonicalMeetingReference(" meeting:0001/02/03/00 ")).toBe("meeting:1/2/3/0")
    expect(parseMeetingReference("meeting:1/2")).toEqual({ type: "meeting", accountId: 1, meetingId: 2 })
    expect(canonicalMeetingReference("meeting:9007199254740991/2/3")).toBe("meeting:9007199254740991/2/3")
  })
  it("rejects malformed, foreign and unsafe identity shapes", () => {
    for (const value of [
      "meeting:0/2",
      "meeting:1/-2",
      "meeting:1/2/3/-1",
      "meeting:1/2/3/4/5",
      "meeting:1/",
      "meeting:1/9007199254740992",
      "meeting:1/2/3/1e1",
      "meeting:%31/2",
      "msg:1/2",
      "meeting:1/2//0",
      "meeting:1/2/0",
    ])
      expect(() => parseMeetingReference(value)).toThrow(expect.objectContaining({ code: "validation_error" }))
  })
  it("validates structured references before formatting", () => {
    for (const reference of [
      { type: "meeting" as const, accountId: 1, meetingId: 2, cuePosition: 0 },
      { type: "meeting" as const, accountId: 0, meetingId: 2 },
      { type: "meeting" as const, accountId: 1, meetingId: 2, transcriptId: 3, cuePosition: -1 },
    ])
      expect(() => formatMeetingReference(reference)).toThrow(expect.objectContaining({ code: "validation_error" }))
  })
})
