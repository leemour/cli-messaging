import ExcelJS from "exceljs"
import { zipSync } from "fflate"
import { describe, expect, it, vi } from "vitest"
import { docx, pdf, zip } from "../testing/files.js"
import { type Engine, engineHint, extractText, importEngine, type LoadEngine } from "./extract.js"

const hint = (name: string, extra: { kind?: string; mime?: string } = {}) => ({
  kind: extra.kind ?? "file",
  name,
  mime: extra.mime ?? null,
  path: `/saved/${name}`,
})
const text = (value: string) => new TextEncoder().encode(value)
const without =
  (missing: Engine): LoadEngine =>
  async (name) => {
    if (name === missing)
      throw Object.assign(new Error(`Cannot find package '${name}'`), { code: "ERR_MODULE_NOT_FOUND" })
    return importEngine(name)
  }

describe("reading the text layer of a file", () => {
  it("refuses DOCX expansion before calling mammoth, including false declared sizes", async () => {
    const extractRawText = vi.fn(async () => ({ value: "unexpected" }))
    const load: LoadEngine = async () => ({ extractRawText })
    const bomb = zipSync({ "word/document.xml": new Uint8Array(1) })
    const bombView = new DataView(bomb.buffer, bomb.byteOffset, bomb.byteLength)
    for (let offset = 0; offset + 46 < bomb.length; offset++) {
      if (bombView.getUint32(offset, true) === 0x02014b50) bombView.setUint32(offset + 24, 51 * 1024 * 1024, true)
    }
    expect(await extractText(bomb, hint("large.docx"), load)).toEqual({ status: "too-large" })
    const forged = zipSync({ "word/document.xml": new Uint8Array(10 * 1024 * 1024 + 1) }, { level: 1 })
    const view = new DataView(forged.buffer, forged.byteOffset, forged.byteLength)
    view.setUint32(22, 1, true)
    for (let offset = 0; offset + 46 < forged.length; offset++) {
      if (view.getUint32(offset, true) === 0x02014b50) view.setUint32(offset + 24, 1, true)
    }
    expect(await extractText(forged, hint("forged.docx"), load)).toEqual({ status: "too-large" })
    expect(extractRawText).not.toHaveBeenCalled()
  })

  it("extracts a long PDF and closes its document without a fixed page/time cutoff", async () => {
    vi.useFakeTimers()
    try {
      const destroy = vi.fn(async () => {})
      const load: LoadEngine = async () => ({
        getDocumentProxy: async () => ({ numPages: 100, loadingTask: { destroy } }),
        extractText: async () => {
          await new Promise((resolve) => setTimeout(resolve, 31_000))
          return { text: ["Synthetic long document"], totalPages: 100 }
        },
      })
      const pending = extractText(pdf(), hint("long.pdf"), load)
      await vi.advanceTimersByTimeAsync(31_000)
      expect(await pending).toMatchObject({ status: "extracted", pages: 100 })
      expect(destroy).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
  })

  it("cancels a pending PDF load and releases a late document", async () => {
    const destroy = vi.fn(async () => {})
    const read = vi.fn()
    const abort = new AbortController()
    let finish = (_value: unknown) => {}
    const loading: LoadEngine = async () => ({
      getDocumentProxy: () =>
        new Promise((resolve) => {
          finish = resolve
        }),
      extractText: read,
    })
    const pending = extractText(pdf(), hint("cancelled.pdf"), loading, abort.signal)
    const rejected = expect(pending).rejects.toMatchObject({ code: "cancelled" })
    await new Promise((resolve) => setTimeout(resolve, 0))
    abort.abort()
    await rejected
    finish({ numPages: 1, loadingTask: { destroy } })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(destroy).toHaveBeenCalledOnce()
    expect(read).not.toHaveBeenCalled()
  })
  it("preserves spreadsheet cell addresses and PDF page spans", async () => {
    const workbook = new ExcelJS.Workbook()
    const sheet = workbook.addWorksheet("Synthetic Budget")
    sheet.getCell("A1").value = "Synthetic invoice"
    sheet.getCell("B2").value = 42
    const bytes = new Uint8Array(await workbook.xlsx.writeBuffer())
    const found = await extractText(bytes, hint("budget.xlsx"), importEngine)
    expect(found).toMatchObject({
      status: "extracted",
      text: expect.stringContaining("A1: Synthetic invoice"),
    })
    const pages = await extractText(pdf("Synthetic invoice"), hint("invoice.pdf"), importEngine)
    expect(pages.status === "extracted" && pages.spans).toEqual([
      { page: 1, start: 0, end: "Synthetic invoice".length },
    ])
  })
  it("**reads plain text in UTF-8, with or without a BOM, Cyrillic and Latin alike**", async () => {
    expect(await extractText(text("счёт invoice 42"), hint("notes.txt"), importEngine)).toEqual({
      status: "extracted",
      text: "счёт invoice 42",
      extractor: "plain",
    })
    const bom = new Uint8Array([0xef, 0xbb, 0xbf, ...text("a,b\nдоговор,1")])
    expect(await extractText(bom, hint("table.csv"), importEngine)).toMatchObject({ text: "a,b\nдоговор,1" })
    expect(
      await extractText(text('{"k":"v"}'), hint("data", { mime: "application/json" }), importEngine),
    ).toMatchObject({
      status: "extracted",
    })
  })

  it("refuses malformed BOM text and binary text, naming only the reason", async () => {
    expect(await extractText(new Uint8Array([0xff, 0xfe, 0x41]), hint("a.txt"), importEngine)).toEqual({
      status: "unreadable",
      extractor: "plain:v2",
      error: "invalid_encoding",
    })
    expect(await extractText(text("a\u0000b"), hint("a.log"), importEngine)).toMatchObject({ error: "binary" })
  })

  it("**reads a Word document through mammoth**, and records its version", async () => {
    const found = await extractText(docx(["Договор поставки", "invoice 7"]), hint("deal.docx"), importEngine)
    expect(found.status).toBe("extracted")
    expect(found).toMatchObject({ extractor: expect.stringMatching(/^docx:mammoth@\d+\.\d+\.\d+$/) })
    expect(found.status === "extracted" && found.text).toContain("Договор поставки")
  })

  it("marks a corrupt Word document unreadable, without the engine's message", async () => {
    const broken = zip({ "word/nothing.xml": "<x/>" })
    expect(await extractText(broken, hint("broken.docx"), importEngine)).toMatchObject({
      status: "unreadable",
      error: "unreadable",
    })
  })

  it("**reads a PDF's text layer through unpdf; a PDF with none is for an agent**", async () => {
    const found = await extractText(pdf("Invoice number 42"), hint("scan.pdf"), importEngine)
    expect(found).toMatchObject({ status: "extracted", extractor: expect.stringMatching(/^pdf:unpdf@/) })
    expect(found.status === "extracted" && found.text).toContain("Invoice number 42")
    expect(await extractText(pdf(), hint("scan.pdf"), importEngine)).toMatchObject({ status: "needs-agent" })
  })

  it("leaves photos to an agent and skips what has no text", async () => {
    expect(await extractText(text("jpeg"), hint("1-1.jpg", { kind: "photo" }), importEngine)).toEqual({
      status: "needs-agent",
    })
    expect(await extractText(text("ogg"), hint("voice.ogg", { kind: "voice" }), importEngine)).toEqual({
      status: "unsupported",
    })
  })

  it("**says which optional package is missing, instead of failing**", async () => {
    expect(await extractText(pdf("x"), hint("a.pdf"), without("unpdf"))).toEqual({
      status: "engine-missing",
      engine: "unpdf",
    })
    expect(await extractText(docx(["x"]), hint("a.docx"), without("mammoth"))).toEqual({
      status: "engine-missing",
      engine: "mammoth",
    })
    expect(engineHint("unpdf", "tg")).toContain("npm install -g unpdf")
  })

  it("lets any other loading failure through", async () => {
    const broken: LoadEngine = async () => {
      throw new Error("disk on fire")
    }
    await expect(extractText(pdf("x"), hint("a.pdf"), broken)).rejects.toThrow("disk on fire")
  })
})

it("honors a configured file budget for local text extraction", async () => {
  const bytes = Buffer.from("a".repeat(1024 * 1024 + 1))
  expect(
    (await extractText(bytes, hint("synthetic.txt"), importEngine, undefined, { MESSAGING_ATTACHMENT_MAX_MIB: "1" }))
      .status,
  ).toBe("too-large")
  expect(
    (await extractText(bytes, hint("synthetic.txt"), importEngine, undefined, { MESSAGING_ATTACHMENT_MAX_MIB: "2" }))
      .status,
  ).toBe("extracted")
})
