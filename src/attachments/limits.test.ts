import { describe, expect, it } from "vitest"
import { attachmentMaxBytes, pdfPreviewLimits } from "./limits.js"

describe("owner-configured attachment budgets", () => {
  it("keeps the file default and raises preview defaults independently of byte chunks", () => {
    expect(attachmentMaxBytes({})).toBe(50 * 1024 * 1024)
    expect(pdfPreviewLimits({})).toEqual({ pixels: 4000, bytes: 8 * 1024 * 1024 })
    expect(attachmentMaxBytes({ MESSAGING_ATTACHMENT_MAX_MIB: "250" })).toBe(250 * 1024 * 1024)
    expect(pdfPreviewLimits({ MESSAGING_PDF_PREVIEW_MAX_PIXELS: "8000", MESSAGING_PDF_PREVIEW_MAX_MIB: "16" })).toEqual(
      { pixels: 8000, bytes: 16 * 1024 * 1024 },
    )
  })
  it.each(["", "0", "-1", "1.5", "Infinity", "NaN", "1e3", "1 MiB", "9007199254740991"])(
    "reports invalid file/preview settings instead of silently falling back: %s",
    (value) => {
      expect(() => attachmentMaxBytes({ MESSAGING_ATTACHMENT_MAX_MIB: value })).toThrow("MESSAGING_ATTACHMENT_MAX_MIB")
      expect(() => pdfPreviewLimits({ MESSAGING_PDF_PREVIEW_MAX_MIB: value })).toThrow("MESSAGING_PDF_PREVIEW_MAX_MIB")
      expect(() => pdfPreviewLimits({ MESSAGING_PDF_PREVIEW_MAX_PIXELS: value })).toThrow(
        "MESSAGING_PDF_PREVIEW_MAX_PIXELS",
      )
    },
  )
})
