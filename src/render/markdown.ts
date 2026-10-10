import { singleLine, visibleControls } from "@wirecat/cli-core"
import type { Attachment, Message, QuotedMessage } from "../domain/models.js"

/**
 * One chat as a document a person reads: a heading per day, `hh:mm Name`, the text, replies and
 * forwards quoted, attachments as links. Copied from max-cli's `toMarkdown`; a reply the provider
 * sent only the id of (Telegram) is quoted from the export itself when it is there.
 *
 * Control characters are made visible here, not only on a terminal: the document is read with `cat`
 * as often as in an editor, and a byte that rewrites the screen is nobody's text.
 */
export const toMarkdown = (title: string, messages: Message[], timeZone?: string): string => {
  const zone = timeZone ? { timeZone } : {}
  const day = new Intl.DateTimeFormat("sv-SE", { ...zone, year: "numeric", month: "2-digit", day: "2-digit" })
  const clock = new Intl.DateTimeFormat("en-GB", { ...zone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
  const byId = new Map(messages.map((message) => [message.id, message]))

  const lines = [`# ${literal(singleLine(title))}`]
  let today = ""
  for (const message of messages) {
    const when = new Date(message.timestamp)
    const date = day.format(when)
    if (date !== today) {
      lines.push("", `## ${date}`)
      today = date
    }

    const edited = message.editedAt ? " · edited" : ""
    lines.push("", `**${clock.format(when)} ${nameOf(message)}**${edited}`)
    const answered = message.replyTo ?? (message.replyToId === undefined ? undefined : byId.get(message.replyToId))
    if (answered) lines.push(...quote(`**${nameOf(answered)}:** ${literal(visibleControls(answered.text))}`))
    else if (message.replyToId !== undefined) lines.push(`> in reply to message ${singleLine(message.replyToId)}`)
    if (message.forwardedFrom) lines.push(...forwarded(message.forwardedFrom))
    if (message.text) lines.push(visibleControls(message.text))
    lines.push(...message.attachments.map((attachment) => `- ${attachmentLine(attachment)}`))
  }
  return `${lines.join("\n")}\n`
}

const literal = (text: string): string => text

const nameOf = (message: Pick<Message, "senderName" | "senderId" | "outgoing">): string =>
  literal(singleLine(message.senderName ?? (message.outgoing ? "you" : (message.senderId ?? "unknown"))))

const quote = (text: string): string[] => text.split("\n").map((line) => `> ${line}`)

const forwarded = (original: QuotedMessage): string[] => [
  `> forwarded from **${nameOf(original)}**`,
  ...(original.text ? quote(literal(visibleControls(original.text))) : []),
  ...original.attachments.map((attachment) => `> - ${attachmentLine(attachment)}`),
]

const attachmentLine = (attachment: Attachment): string => {
  if (attachment.buttons) {
    const buttons = attachment.buttons.flat().map((button, index) => `${index + 1} ${literal(singleLine(button.text))}`)
    return `buttons: ${buttons.join(" · ")}`
  }
  const label = literal(singleLine(attachment.title ?? attachment.name ?? attachment.kind))
  if (attachment.url) {
    try {
      const url = new URL(attachment.url)
      if (["https:", "http:"].includes(url.protocol))
        return `[${label}](${url.href.replace(/[()<>\\]/g, (char) => `%${char.charCodeAt(0).toString(16)}`)})`
    } catch {}
  }
  return attachment.name
    ? `${literal(attachment.kind)}: ${literal(singleLine(attachment.name))}`
    : literal(attachment.kind)
}
