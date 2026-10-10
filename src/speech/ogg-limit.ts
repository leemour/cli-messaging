import { CliError } from "@wirecat/cli-core"

const invalid = () =>
  new CliError("validation_error", "local transcription needs a complete mono or stereo Ogg Opus recording")

/** Validate supported packet framing before handing bytes to the decoder. */
export const checkOggDuration = (bytes: Uint8Array): void => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let offset = 0
  let serial: number | undefined
  let packet = 0
  let length = 0
  const prefix: number[] = []
  while (offset < bytes.length) {
    if (offset + 27 > bytes.length || view.getUint32(offset, false) !== 0x4f676753 || bytes[offset + 4] !== 0)
      throw invalid()
    const stream = view.getUint32(offset + 14, true)
    if (serial !== undefined && serial !== stream) throw invalid()
    serial = stream
    const segments = bytes[offset + 26] ?? 0
    let data = offset + 27 + segments
    if (data > bytes.length || Boolean((bytes[offset + 5] ?? 0) & 1) !== length > 0) throw invalid()
    for (let index = 0; index < segments; index++) {
      const size = bytes[offset + 27 + index] ?? 0
      if (data + size > bytes.length) throw invalid()
      const take = Math.min(size, 19 - prefix.length)
      for (let i = 0; i < take; i++) prefix.push(bytes[data + i] ?? 0)
      length += size
      data += size
      if (size === 255) continue
      if (packet === 0) {
        if (
          length < 19 ||
          String.fromCharCode(...prefix.slice(0, 8)) !== "OpusHead" ||
          ![1, 2].includes(prefix[9] ?? 0) ||
          prefix[18] !== 0
        )
          throw invalid()
      } else if (packet === 1) {
        if (length < 8 || String.fromCharCode(...prefix.slice(0, 8)) !== "OpusTags") throw invalid()
      } else {
        if (length < 1) throw invalid()
        const toc = prefix[0] ?? 0
        const config = toc >> 3
        const frame =
          config >= 16
            ? 120 << (config & 3)
            : config >= 12
              ? 480 << (config & 1)
              : (config & 3) === 3
                ? 2880
                : 480 << (config & 3)
        const count = (toc & 3) === 0 ? 1 : (toc & 3) === 3 ? (length >= 2 ? (prefix[1] ?? 0) & 63 : 0) : 2
        if (count < 1 || frame * count > 5760) throw invalid()
      }
      packet++
      length = 0
      prefix.length = 0
    }
    offset = data
  }
  if (length !== 0 || packet < 3) throw invalid()
}
