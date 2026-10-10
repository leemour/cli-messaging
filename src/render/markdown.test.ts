import { describe, expect, it } from "vitest"
import type { Message } from "../domain/models.js"
import { toMarkdown } from "./markdown.js"

const message = (id: string, minutes: number, changes: Partial<Message> = {}): Message => ({
  id,
  chatId: "7",
  senderId: "9",
  senderName: "Olga",
  timestamp: new Date(Date.UTC(2026, 8, 29, 23, 58) + minutes * 60_000).toISOString(),
  editedAt: null,
  text: `text ${id}`,
  outgoing: false,
  attachments: [],
  replyTo: null,
  forwardedFrom: null,
  reactions: null,
  ...changes,
})

describe("a chat as Markdown", () => {
  it("**a heading per day, a line per message, replies quoted — from the export when only the id came**", () => {
    const markdown = toMarkdown(
      "Book club",
      [
        message("1", 0),
        message("2", 1, { senderName: null, outgoing: true, editedAt: "2026-09-30T00:00:00.000Z" }),
        message("3", 3, { replyToId: "1", text: "yes" }),
        message("4", 4, { replyToId: "99", text: "which?" }),
      ],
      "UTC",
    )

    expect(markdown).toBe(
      [
        "# Book club",
        "",
        "## 2026-09-29",
        "",
        "**23:58 Olga**",
        "text 1",
        "",
        "**23:59 you** · edited",
        "text 2",
        "",
        "## 2026-09-30",
        "",
        "**00:01 Olga**",
        "> **Olga:** text 1",
        "yes",
        "",
        "**00:02 Olga**",
        "> in reply to message 99",
        "which?",
        "",
      ].join("\n"),
    )
  })

  it("quotes a forward, links attachments, and shows control characters instead of obeying them", () => {
    const markdown = toMarkdown(
      "A\nchat",
      [
        message("1", 0, {
          text: "red\u001b[31m",
          forwardedFrom: {
            id: "5",
            senderId: "3",
            senderName: "Ivan",
            timestamp: null,
            text: "news",
            attachments: [{ kind: "photo" }],
            outgoing: false,
          },
          attachments: [
            { kind: "file", name: "a.pdf" },
            { kind: "share", title: "Site", url: "https://example.com" },
          ],
        }),
      ],
      "UTC",
    )

    expect(markdown).not.toContain("\u001b")
    expect(markdown).toContain("# A\\x0achat\n")
    expect(markdown).toContain("> forwarded from **Ivan**\n> news\n> - photo")
    expect(markdown).toContain("- file: a.pdf\n- [Site](https://example.com/)")
  })

  it("preserves message Markdown and ordinary metadata for existing exports", () => {
    const markdown = toMarkdown(
      "# heading",
      [
        message("1", 0, {
          text: "## Section\n**rich text**",
          senderName: "Olga (owner)",
        }),
      ],
      "UTC",
    )
    expect(markdown).toContain("# # heading")
    expect(markdown).toContain("**23:58 Olga (owner)**\n## Section\n**rich text**")
  })

  it("lists a bot's buttons with their numbers", () => {
    const keyboard = {
      kind: "inline_keyboard",
      buttons: [[{ kind: "callback" as const, text: "Yes" }], [{ kind: "callback" as const, text: "No" }]],
    }
    expect(toMarkdown("Bot", [message("1", 0, { attachments: [keyboard] })])).toContain("- buttons: 1 Yes · 2 No")
  })
})
