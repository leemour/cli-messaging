import { CliError } from "@wirecat/cli-core"
import { describe, expect, it, vi } from "vitest"
import { renderReplyTemplate, type TemplateInput } from "./template.js"

const input: TemplateInput = {
  senderName: "Ana Example",
  chat: { kind: "dialog", title: "Test chat" },
  now: Date.parse("2026-10-06T10:00:00Z"),
  timezone: "Europe/Madrid",
  data: "A synthetic incoming message",
}
const render = (
  template: string,
  extra: Partial<TemplateInput> = {},
  model: "fill-only" | "may-reword" = "fill-only",
) => renderReplyTemplate({ template, model, asReply: true }, { ...input, ...extra })

describe("reply templates", () => {
  it("fills names, chat facts, filters and actual rule-zone time", async () => {
    expect(
      (
        await render(
          '{{ sender.firstName | upcase }}: {{ sender.name }} in {{ chat.title }} ({{ chat.kind }}) at {{ now | date: "%H:%M %z" }}',
        )
      ).text,
    ).toBe("ANA: Ana Example in Test chat (dialog) at 12:00 +0200")
    expect((await render('Hello {{ sender.firstName | default: "there" }}', { senderName: null })).text).toBe(
      "Hello there",
    )
    expect((await render('{% if chat.kind == "dialog" %}direct{% endif %}')).text).toBe("direct")
  })

  it.each([
    "{{ message }}",
    "{{ message.text }}",
    "{{ data }}",
    "{{ sender.constructor }}",
    "{{ sender.__proto__ }}",
    "{{ missing }}",
    "{% if missing %}yes{% endif %}",
    '{{ message | default: "fallback" }}',
    "{{ sender.name | missing_filter }}",
    '{% include "private.txt" %}',
    '{% render "private.txt" %}',
    '{% layout "private.txt" %}',
    '{% liquid\n include "private.txt"\n %}',
  ])("refuses inaccessible variables, prototypes, filters and files: %s", async (template) => {
    const result = await render(template)
    expect(result.text).toBeNull()
    expect(result.reason).toContain("invalid")
    expect(JSON.stringify(result)).not.toContain(input.data)
  })

  it("bounds parsed size, render time, allocations, render count and output", async () => {
    for (const [template, limits] of [
      ["long template", { parse: 2 }],
      ["{% for i in (1..1000000000) %}x{% endfor %}", { memory: 100 }],
      ["{% for i in (1..100) %}x{% endfor %}", { renders: 10 }],
      ["hello", { milliseconds: -1 }],
      ["hello", { output: 3 }],
      ['{{ "hello" | append: "world" }}', { memory: 5 }],
    ] as const)
      expect((await render(template, { limits })).text).toBeNull()
    expect((await render(" ")).text).toBeNull()
  })

  it("replaces only ai blocks, with separately supplied data and literal model output", async () => {
    const complete = vi.fn(async () => ({ text: "{{ message }} is not reparsed" }))
    const result = await render("Before {% ai %}Greet {{ sender.firstName }}{% else %}later{% endai %} after", {
      allowAI: true,
      complete,
    })
    expect(result.text).toBe("Before {{ message }} is not reparsed after")
    expect(complete).toHaveBeenCalledWith("Greet Ana", input.data)
    expect(result.blocks).toEqual([{ instruction: "Greet Ana", fallback: "later" }])
  })

  it("uses fallback on no model, no consent or model failure, while preview never calls", async () => {
    const source = "Start {% ai %}Say hello{% else %}Hi {{ sender.firstName }}{% endai %} end"
    const complete = vi.fn(async () => {
      throw new Error("synthetic private body")
    })
    expect((await render(source)).text).toBe("Start Hi Ana end")
    const preview = await render(source, { preview: true, complete })
    expect(preview.text).toBe("Start Hi Ana end")
    expect(preview.blocks).toEqual([{ instruction: "Say hello", fallback: "Hi Ana" }])
    expect(complete).not.toHaveBeenCalled()
    const failed = await render(source, { allowAI: true, complete })
    expect(failed.text).toBe("Start Hi Ana end")
    expect(JSON.stringify(failed)).not.toContain("synthetic private body")
    expect((await render("{% ai %}Hello{% endai %}")).text).toBeNull()
    for (const [code, hint] of [
      ["permission_error", "replies consents grant"],
      ["configuration_error", "models.replies.provider"],
    ] as const) {
      const missing = await render("{% ai %}Hello{% endai %}", {
        allowAI: true,
        complete: async () => {
          throw new CliError(code, "private synthetic detail")
        },
      })
      expect(missing.reason).toContain(hint)
      expect(JSON.stringify(missing)).not.toContain("private synthetic detail")
    }
  })

  it("refuses echoes, oversized and empty answers and bounds calls within loops", async () => {
    for (const text of [input.data, input.data.toUpperCase(), "x".repeat(1025), " "]) {
      expect(
        (
          await render("{% ai %}Hello{% else %}fallback{% endai %}", {
            allowAI: true,
            complete: async () => ({ text }),
          })
        ).text,
      ).toBe("fallback")
    }
    const complete = vi.fn(async () => ({ text: "Hi" }))
    expect(
      (
        await render("{% for i in (1..5) %}{% ai %}Hello{% else %}bye{% endai %}{% endfor %}", {
          allowAI: true,
          complete,
        })
      ).text,
    ).toBe("HiHiHiHibye")
    expect(complete).toHaveBeenCalledTimes(4)
  })

  it.each([
    "{% ai %}not closed",
    "{% ai %}{% ai %}nested{% endai %}{% endai %}",
    "{% ai %}x{% else %}a{% else %}b{% endai %}",
    "{% ai invalid %}x{% endai %}",
  ])("refuses malformed blocks without calling a model: %s", async (source) => {
    const complete = vi.fn(async () => ({ text: "Hello" }))
    expect((await render(source, { allowAI: true, complete })).text).toBeNull()
    expect(complete).not.toHaveBeenCalled()
  })

  it("keeps legacy placeholder and may-reword files producing the same literal reply with warnings", async () => {
    const filled = await render("Thanks, {firstName} ({name})")
    expect(filled.text).toBe("Thanks, Ana (Ana Example)")
    expect(filled.warnings).toHaveLength(1)
    const old = await render("Thanks, {firstName}", {}, "may-reword")
    expect(old.text).toBe("Thanks, Ana")
    expect(old.warnings).toHaveLength(2)
    expect((await render("{{ firstName }}")).text).toBeNull()
  })

  it("sender data containing Liquid syntax is substituted without being evaluated", async () => {
    const senderName = '{% include "private.txt" %}'
    expect((await render("{{ sender.name }}", { senderName })).text).toBe(senderName)
  })
})
