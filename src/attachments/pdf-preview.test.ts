import { PNG } from "pngjs"
import { describe, expect, it, vi } from "vitest"
import { pdf } from "../testing/files.js"
import { importEngine, type LoadEngine } from "./extract.js"
import { pdfPreview } from "./pdf-preview.js"

const png = () => PNG.sync.write(new PNG({ width: 2, height: 2 }))
const fake = (options: { pages?: number; width?: number; render?: () => Promise<ArrayBuffer> } = {}) => {
  const destroy = vi.fn(async () => {})
  const cleanup = vi.fn()
  const image = png()
  const render = vi.fn(
    options.render ??
      (async () => image.buffer.slice(image.byteOffset, image.byteOffset + image.length) as ArrayBuffer),
  )
  const engine = {
    createIsomorphicCanvasFactory: async (load: () => Promise<unknown>) => {
      await load()
      return {}
    },
    getDocumentProxy: async () => ({
      numPages: options.pages ?? 4,
      loadingTask: { destroy },
      getPage: async () => ({ getViewport: () => ({ width: options.width ?? 600, height: 800 }), cleanup }),
    }),
    renderPageAsImage: render,
  }
  const load: LoadEngine = async (name) => (name === "unpdf" ? engine : {})
  return { load, engine, image, destroy, cleanup, render }
}

describe("PDF page previews for remote agents", () => {
  it("renders a requested page with the actual optional engines, without OCR or text indexing", async () => {
    const result = await pdfPreview(pdf("Synthetic worksheet"), 1, undefined, importEngine)
    expect(result).toMatchObject({ page: 1, pageCount: 1 })
    expect(result.bytes.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  })
  it("returns an independently readable page and releases document/page state", async () => {
    const fixture = fake()
    const result = await pdfPreview(pdf(), 3, undefined, fixture.load)
    expect(result).toEqual({ bytes: fixture.image, page: 3, pageCount: 4 })
    expect(fixture.render).toHaveBeenCalledWith(expect.anything(), 3, expect.objectContaining({ scale: 4 }))
    expect(fixture.destroy).toHaveBeenCalledTimes(1)
    expect(fixture.cleanup).toHaveBeenCalledTimes(1)
  })
  it("previews a requested page in a long document", async () => {
    const fixture = fake({ pages: 100 })
    expect(await pdfPreview(pdf(), 99, undefined, fixture.load)).toMatchObject({ page: 99, pageCount: 100 })
  })
  it("accepts a larger image and applies custom dimension/byte budgets", async () => {
    const wide = PNG.sync.write(new PNG({ width: 3000, height: 2 }))
    const fixture = fake({
      render: async () => wide.buffer.slice(wide.byteOffset, wide.byteOffset + wide.length) as ArrayBuffer,
    })
    expect((await pdfPreview(pdf(), 1, undefined, fixture.load)).bytes).toEqual(wide)
    await expect(
      pdfPreview(pdf(), 1, undefined, fixture.load, { MESSAGING_PDF_PREVIEW_MAX_PIXELS: "2000" }),
    ).rejects.toThrow("dimensions")
    const scaled = fake()
    await pdfPreview(pdf(), 1, undefined, scaled.load, { MESSAGING_PDF_PREVIEW_MAX_PIXELS: "600" })
    expect(scaled.render).toHaveBeenCalledWith(expect.anything(), 1, expect.objectContaining({ scale: 0.75 }))
    const image = PNG.sync.write(new PNG({ width: 700, height: 700 }), { deflateLevel: 0 })
    expect(image.length).toBeGreaterThan(1024 * 1024)
    const encoded = fake({
      render: async () => image.buffer.slice(image.byteOffset, image.byteOffset + image.length) as ArrayBuffer,
    })
    expect((await pdfPreview(pdf(), 1, undefined, encoded.load)).bytes.equals(image)).toBe(true)
    await expect(pdfPreview(pdf(), 1, undefined, encoded.load, { MESSAGING_PDF_PREVIEW_MAX_MIB: "1" })).rejects.toThrow(
      "exceeds 1 MiB",
    )
  })
  it("rejects invalid pages, page counts and dimensions before rendering", async () => {
    for (const page of [0, -1, 1.5, Infinity])
      await expect(pdfPreview(pdf(), page)).rejects.toMatchObject({ code: "validation_error" })
    for (const pages of [0, 1.5]) {
      const fixture = fake({ pages })
      await expect(pdfPreview(pdf(), 1, undefined, fixture.load)).rejects.toMatchObject({ code: "validation_error" })
      expect(fixture.destroy).toHaveBeenCalledTimes(1)
      expect(fixture.render).not.toHaveBeenCalled()
    }
    const fixture = fake({ width: Infinity })
    await expect(pdfPreview(pdf(), 1, undefined, fixture.load)).rejects.toThrow("cannot be rendered")
    expect(fixture.cleanup).toHaveBeenCalledTimes(1)
    expect(fixture.destroy).toHaveBeenCalledTimes(1)
    const outside = fake()
    await expect(pdfPreview(pdf(), 5, undefined, outside.load)).rejects.toThrow("past the end")
  })
  it("reports missing/older engines and sanitizes malformed files", async () => {
    for (const missing of ["unpdf", "@napi-rs/canvas"] as const) {
      const fixture = fake()
      const load: LoadEngine = async (name) => {
        if (name === missing) throw new Error("private path")
        return fixture.load(name)
      }
      await expect(pdfPreview(pdf(), 1, undefined, load)).rejects.toThrow(`optional package ${missing}`)
    }
    await expect(pdfPreview(pdf(), 1, undefined, async () => ({}))).rejects.toThrow("rendering support")
    await expect(pdfPreview(new Uint8Array([1, 2]), 1, undefined, importEngine)).rejects.toThrow("cannot be rendered")
    const fixture = fake({
      render: async () => {
        throw new Error("private content")
      },
    })
    await expect(pdfPreview(pdf(), 1, undefined, fixture.load)).rejects.toThrow("cannot be rendered")
    expect(fixture.destroy).toHaveBeenCalledTimes(1)
  })
  it("bounds rendered output and cancels a render without returning a late image", async () => {
    for (const image of [Buffer.alloc(8 * 1024 * 1024 + 1), Buffer.from("GIF89a\x02\x00\x02\x00", "binary")]) {
      const fixture = fake({
        render: async () => image.buffer.slice(image.byteOffset, image.byteOffset + image.length) as ArrayBuffer,
      })
      await expect(pdfPreview(pdf(), 1, undefined, fixture.load)).rejects.toMatchObject({ code: "validation_error" })
      expect(fixture.destroy).toHaveBeenCalledTimes(1)
    }
    const controller = new AbortController()
    const fixture = fake({
      render: async () => {
        controller.abort()
        return new ArrayBuffer(0)
      },
    })
    await expect(pdfPreview(pdf(), 1, controller.signal, fixture.load)).rejects.toMatchObject({ code: "cancelled" })
    expect(fixture.destroy).toHaveBeenCalledTimes(1)
    await expect(pdfPreview(pdf(), 1, AbortSignal.abort(), fixture.load)).rejects.toMatchObject({ code: "cancelled" })
  })
})
