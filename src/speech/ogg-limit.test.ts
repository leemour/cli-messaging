import { describe, expect, it } from "vitest"
import { checkOggDuration } from "./ogg-limit.js"

const head = Buffer.alloc(19)
head.write("OpusHead")
head[8] = 1
head[9] = 1
const tags = Buffer.from("OpusTags")
const page = (packets: Uint8Array[], serial = 1) => {
  const header = Buffer.alloc(27 + packets.length)
  header.write("OggS")
  header.writeUInt32LE(serial, 14)
  header[26] = packets.length
  packets.forEach((packet, index) => {
    header[27 + index] = packet.length
  })
  return Buffer.concat([header, ...packets])
}
const recording = (audio: Uint8Array[], channels = 1) => {
  const header = Buffer.from(head)
  header[9] = channels
  const pages = [page([header]), page([tags])]
  for (let offset = 0; offset < audio.length; offset += 255) pages.push(page(audio.slice(offset, offset + 255)))
  return Buffer.concat(pages)
}

describe("voice duration before decoding", () => {
  it("allows recordings beyond ten minutes while validating packet framing", () => {
    const packet = new Uint8Array([(19 << 3) | 3, 6])
    const limit = recording(Array.from({ length: 5000 }, () => packet))
    expect(() => checkOggDuration(limit)).not.toThrow()
    const oversized = recording(Array.from({ length: 5001 }, () => packet))
    expect(() => checkOggDuration(oversized)).not.toThrow()
  })

  it("accepts all frame durations and mono or stereo before decoding", () => {
    for (const config of [0, 1, 2, 3, 12, 13, 16, 17, 18, 19])
      for (const code of [0, 1, 2, 3]) {
        const packet = new Uint8Array([(config << 3) | code, 2])
        expect(() => checkOggDuration(recording([packet], 2))).not.toThrow()
      }
  })

  it("refuses malformed containers, chained streams, excessive channels and invalid frame counts", () => {
    const audio = new Uint8Array([19 << 3])
    for (const bytes of [
      new Uint8Array(),
      new Uint8Array([1]),
      recording([audio], 3),
      Buffer.concat([page([head]), page([tags]), page([audio], 2)]),
      recording([new Uint8Array([(19 << 3) | 3, 0])]),
      recording([new Uint8Array([(19 << 3) | 3, 7])]),
      recording([new Uint8Array()]),
      recording([audio]).subarray(0, -1),
      page([head]),
    ])
      expect(() => checkOggDuration(bytes)).toThrow("complete mono or stereo")
  })
})
