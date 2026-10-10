import { createHash } from "node:crypto"
import { mkdir, mkdtemp, rm, symlink, truncate, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it } from "vitest"
import { retainedBytes, transferMime } from "./transfer.js"

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})
const fixture = async () => {
  const root = await mkdtemp(join(tmpdir(), "attachment-transfer-"))
  roots.push(root)
  const path = join(root, "file.pdf")
  const bytes = Buffer.from(`%PDF-1.7\nsynthetic bytes ${"abc".repeat(400000)}`)
  await writeFile(path, bytes)
  return { root, path, bytes }
}
it("assembles several bounded windows with one whole-file hash and exact original bytes", async () => {
  const { path, bytes } = await fixture()
  const hash = createHash("sha256").update(bytes).digest("hex")
  const parts: Buffer[] = []
  let offset = 0
  do {
    const part = await retainedBytes(path, { offsetBytes: offset, chunkBytes: 262144, ifSha256: hash })
    expect(part.sha256).toBe(hash)
    expect(part.readBytes).toBeLessThanOrEqual(262144)
    expect(part.complete).toBe(false)
    parts.push(Buffer.from(part.base64, "base64"))
    if (part.nextOffsetBytes === null) break
    offset = part.nextOffsetBytes
  } while (offset < bytes.length)
  expect(Buffer.concat(parts)).toEqual(bytes)
  expect(transferMime(bytes.subarray(0, 32), null)).toBe("application/pdf")
}, 30000)
it("refuses a changed hash, invalid windows, symlinks, directories, missing and oversized files", async () => {
  const { root, path } = await fixture()
  await expect(retainedBytes(path, { ifSha256: "0".repeat(64) })).rejects.toMatchObject({ code: "validation_error" })
  for (const options of [{ offsetBytes: -1 }, { chunkBytes: 0 }, { chunkBytes: 1048577 }, { offsetBytes: 99999999 }])
    await expect(retainedBytes(path, options)).rejects.toMatchObject({ code: "validation_error" })
  const link = join(root, "link")
  await symlink(path, link)
  await expect(retainedBytes(link, {})).rejects.toMatchObject({ code: "validation_error" })
  await mkdir(join(root, "dir"))
  await expect(retainedBytes(join(root, "dir"), {})).rejects.toMatchObject({ code: "validation_error" })
  await expect(retainedBytes(join(root, "missing"), {})).rejects.toMatchObject({ code: "not_found" })
  await truncate(path, 50 * 1024 * 1024 + 1)
  await expect(retainedBytes(path, {})).rejects.toMatchObject({ code: "validation_error" })
})
it("handles empty files and cancellation without emitting bytes", async () => {
  const { path } = await fixture()
  await writeFile(path, "")
  expect(await retainedBytes(path, {})).toMatchObject({
    complete: true,
    readBytes: 0,
    nextOffsetBytes: null,
    base64: "",
  })
  const controller = new AbortController()
  controller.abort()
  await expect(retainedBytes(path, { signal: controller.signal })).rejects.toMatchObject({ code: "cancelled" })
})

it("captures a full bounded source for PDF rendering while leaving the byte window unchanged", async () => {
  const { path, bytes } = await fixture()
  const answer = await retainedBytes(path, { chunkBytes: 5 }, true)
  expect(answer.capturedFile?.equals(bytes)).toBe(true)
  expect(Buffer.from(answer.base64, "base64")).toEqual(bytes.subarray(0, 5))
  await expect(retainedBytes(path, { ifSha256: "0".repeat(64) }, true)).rejects.toMatchObject({
    code: "validation_error",
  })
})

it("transfers above the old file ceiling when the owner raises it, and honors lower settings", async () => {
  const { path } = await fixture()
  await expect(retainedBytes(path, {}, false, { MESSAGING_ATTACHMENT_MAX_MIB: "1" })).rejects.toThrow("exceeds 1 MiB")
  await truncate(path, 50 * 1024 * 1024 + 1)
  const result = await retainedBytes(path, { chunkBytes: 5 }, false, { MESSAGING_ATTACHMENT_MAX_MIB: "51" })
  expect(result).toMatchObject({ totalBytes: 50 * 1024 * 1024 + 1, readBytes: 5, complete: false })
  await expect(
    retainedBytes(path, { chunkBytes: 1048577 }, false, { MESSAGING_ATTACHMENT_MAX_MIB: "51" }),
  ).rejects.toMatchObject({ code: "validation_error" })
})
