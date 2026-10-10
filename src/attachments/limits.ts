import { CliError } from "@wirecat/cli-core"

export const MAX_FILE_BYTES = 50 * 1024 * 1024
export const MAX_TEXT_CHARS = 2_000_000
export const ATTACHMENT_LIMIT_ENV = [
  "MESSAGING_BATCH_MAX_ERROR_PERCENT",
  "MESSAGING_ATTACHMENT_MAX_MIB",
  "MESSAGING_PDF_PREVIEW_MAX_PIXELS",
  "MESSAGING_PDF_PREVIEW_MAX_MIB",
] as const

const positive = (env: NodeJS.ProcessEnv, name: string, fallback: number, factor = 1): number => {
  const raw = env[name]
  if (raw === undefined) return fallback
  const value = Number(raw)
  if (!/^[0-9]+$/.test(raw) || value < 1 || !Number.isSafeInteger(value * factor))
    throw new CliError("validation_error", `${name} must be a positive whole number within the safe numeric range`)
  return value * factor
}

export const attachmentMaxBytes = (env: NodeJS.ProcessEnv = process.env): number =>
  positive(env, "MESSAGING_ATTACHMENT_MAX_MIB", MAX_FILE_BYTES, 1024 * 1024)

export const pdfPreviewLimits = (env: NodeJS.ProcessEnv = process.env) => {
  const pixels = positive(env, "MESSAGING_PDF_PREVIEW_MAX_PIXELS", 4000)
  if (!Number.isSafeInteger(pixels * pixels))
    throw new CliError("validation_error", "MESSAGING_PDF_PREVIEW_MAX_PIXELS squared must fit the safe numeric range")
  return { pixels, bytes: positive(env, "MESSAGING_PDF_PREVIEW_MAX_MIB", 8 * 1024 * 1024, 1024 * 1024) }
}
