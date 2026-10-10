import { CliError } from "@wirecat/cli-core"
import {
  Context,
  type Emitter,
  Liquid,
  type Parser,
  Tag,
  type TagToken,
  type Template,
  type TopLevelToken,
} from "liquidjs"
import type { ReplyRule } from "./rules.js"

export const TEMPLATE_LIMITS = {
  parse: 32_768,
  renders: 2_000,
  memory: 65_536,
  milliseconds: 100,
  output: 4_096,
  aiOutput: 1_024,
  calls: 4,
}

export interface TemplateBlock {
  instruction: string
  fallback: string | null
}
export interface TemplateResult {
  text: string | null
  warnings: string[]
  blocks: TemplateBlock[]
  reason?: string
}
export interface TemplateInput {
  senderName: string | null
  chat: { kind: string; title?: string | null }
  now: number
  timezone?: string
  data: string
  allowAI?: boolean
  preview?: boolean
  complete?: (instruction: string, data: string) => Promise<{ text: string }>
  limits?: Partial<typeof TEMPLATE_LIMITS>
}

export const renderReplyTemplate = async (reply: ReplyRule["reply"], input: TemplateInput): Promise<TemplateResult> => {
  const limits = { ...TEMPLATE_LIMITS, ...input.limits }
  const blocks: TemplateBlock[] = []
  const warnings: string[] = []
  let source = reply.template
  const legacy = /(?<!\{)\{(firstName|name)\}(?!\})/g
  if (legacy.test(source)) {
    warnings.push("legacy reply placeholders: use {{ sender.firstName }} and {{ sender.name }}")
    source = source.replace(legacy, (_, name: string) => `{{ sender.${name} }}`)
  }
  if (reply.model === "may-reword") {
    warnings.push("legacy may-reword: use an ai block with an explicit fallback")
    if (!/\{%[-]?\s*ai\b/.test(source)) source = `{% ai %}${source}{% else %}${source}{% endai %}`
  }
  let missing: string | undefined
  let calls = 0
  let paused = 0
  let parsingAI = false
  try {
    const zone = input.timezone ?? "UTC"
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat("en-CA", {
        timeZone: zone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        timeZoneName: "longOffset",
        hourCycle: "h23",
      })
        .formatToParts(input.now)
        .map(({ type, value }) => [type, value]),
    )
    const localTime = `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}${parts.timeZoneName?.replace("GMT", "") || "+00:00"}`
    const engine = new Liquid({
      ownPropertyOnly: true,
      strictVariables: true,
      strictFilters: true,
      lenientIf: false,
      parseLimit: limits.parse,
      renderLimit: limits.milliseconds,
      memoryLimit: limits.memory,
      preserveTimezones: true,
    })
    for (const name of ["include", "render", "layout"]) {
      engine.registerTag(
        name,
        class extends Tag {
          constructor(token: TagToken, tokens: TopLevelToken[], liquid: Liquid) {
            super(token, tokens, liquid)
            throw new Error("reply templates cannot read files")
          }
          render() {
            return ""
          }
        },
      )
    }
    engine.registerTag(
      "ai",
      class extends Tag {
        body: Template[] = []
        fallback: Template[] | null = null
        constructor(token: TagToken, tokens: TopLevelToken[], liquid: Liquid, parser: Parser) {
          super(token, tokens, liquid)
          if (parsingAI || token.args.trim()) throw new Error("nested ai blocks and ai arguments are not supported")
          parsingAI = true
          try {
            let active = this.body
            while (tokens.length) {
              const next = tokens.shift() as TopLevelToken
              if ("name" in next && next.name === "endai") return
              if ("name" in next && next.name === "else") {
                if (this.fallback !== null) throw new Error("duplicate ai fallback")
                this.fallback = []
                active = this.fallback
              } else active.push(parser.parseToken(next, tokens))
            }
            throw new Error("ai block is not closed")
          } finally {
            parsingAI = false
          }
        }
        async render(context: Context, emitter: Emitter) {
          const instruction = String(await engine.render(this.body, context))
          const fallback = this.fallback === null ? null : String(await engine.render(this.fallback, context))
          blocks.push({ instruction, fallback })
          let text: string | undefined
          let reason = input.preview
            ? "AI preview only; add --ai to call the configured model"
            : "no reply model configured"
          if (input.allowAI && input.complete) {
            const started = performance.now()
            try {
              if (++calls > limits.calls) throw new Error("model call limit")
              const answer = await input.complete(instruction, input.data)
              const data = input.data.trim()
              if (
                !answer.text.trim() ||
                answer.text.length > limits.aiOutput ||
                (data && answer.text.toLowerCase().includes(data.toLowerCase()))
              )
                throw new Error("invalid model output")
              text = answer.text
            } catch (error) {
              reason =
                error instanceof CliError && error.code === "permission_error"
                  ? "reply model consent missing or revoked — check replies consents show; use replies consents grant or replies consents allow"
                  : error instanceof CliError && error.code === "configuration_error"
                    ? "reply model not configured — set models.replies.provider and models.replies.model"
                    : "reply model unavailable, call limit reached or output refused"
            } finally {
              paused += performance.now() - started
            }
          }
          if (text === undefined) {
            if (fallback === null) {
              missing = reason
              text = ""
            } else text = fallback
          }
          emitter.write(text)
        }
      },
    )
    const templates = engine.parse(source)
    const name = input.senderName?.trim() ?? ""
    const context = new Context(
      {
        sender: { firstName: name.split(/\s+/)[0] ?? "", name },
        chat: { title: input.chat.title ?? "", kind: input.chat.kind },
        now: localTime,
      },
      engine.options,
      { templateLimit: limits.renders },
      { liquid: engine },
    )
    const check = context.renderLimit.check.bind(context.renderLimit)
    let renders = 0
    // LiquidJS 10.30 types templateLimit but does not enforce it; share this bound across nested renders.
    context.renderLimit.check = (at: number) => {
      if (++renders > limits.renders) throw new Error("template render count limit")
      check(at - paused)
    }
    const text = String(await engine.render(templates, context))
    if (missing) return { text: null, warnings, blocks, reason: missing }
    if (!text.trim() || text.length > limits.output)
      return { text: null, warnings, blocks, reason: "reply template output is empty or too long" }
    return { text, warnings, blocks }
  } catch {
    return { text: null, warnings, blocks, reason: "reply template is invalid or exceeds its rendering limits" }
  }
}
