import { CliError } from "@wirecat/cli-core"
import { annotate } from "@wirecat/cli-core/commands"
import { Command } from "commander"
import { sendTime } from "../../domain/send-time.js"
import { typedSendAs } from "../../sends/send-as.js"
import { readAttachments } from "../../sends/upload.js"
import { type Messenger, messengerContext } from "./context.js"
import { readAll } from "./stdin.js"
import { threadIdOf } from "./thread.js"

/**
 * **Asked before it goes, told after, on every outcome** — the guard's journal is the only record
 * of what this profile tried to send, and it never holds the text.
 */
export const HTML_HELP = "the text is HTML: <b>, <i>, <a href>, <code>"

export const sendCommand = (messenger: Messenger): Command => {
  const send = annotate(new Command("send"), { mutates: true })
    .description("send a text message; without [text], the text is read from stdin")
    .argument("<chat>", messenger.chatArgument)
    .argument("[text]", "the message")
    .option("--topic <id>", "send to this forum topic; unsupported by messengers without topics")
    .option("--reply-to <message>", "answer this message, by its id in the same chat")
    .option("--comment-to <post>", "comment on this post of the channel; it goes to the post's discussion group")
    .option(
      "--send-as <id>",
      "post as one of the identities `chats send-as` lists; required where the chat posts as someone else by default",
    )
    .option("--send-id <id>", "repeat a send whose outcome was unknown, without risking a second copy")
    .option("--silent", "deliver without a notification")
    .option("--no-preview", "no preview card for a link in the text")
    .option("--md", "read this messenger's Markdown; see its formatting guide for supported syntax")
    .option("--file <file>", "attach a file; the text becomes its caption")
    .option("--photo <file>", "attach a .jpg, .png or .webp as a photo; the text becomes its caption")
    .option("--as-file", "send the --file as a file to download, a video included")
    .option("--voice <file>", "send an Ogg Opus file as a voice message, alone, with no text")
    .option("--allow-any-file", "send a file even from credential folders or this CLI's own folders")
    .option(
      "--at-time <time>",
      "let the messenger send it later, even with this machine off: 2026-09-25T09:00 (local time), or 30m, 2h, 1d from now",
    )
    .action(async function (this: Command, chat: string, text: string | undefined) {
      await sendText(this, messenger, chat, text)
    })
  // Offered only where the messenger lists them, so a CLI never shows a flag it would refuse.
  if (messenger.mediaOptions?.includes("spoiler"))
    send.option("--spoiler", "hide the --photo or video behind a spoiler until tapped")
  if (messenger.mediaOptions?.includes("captionAbove"))
    send.option("--caption-above", "show the text above the --photo or --file, not below it")
  if (messenger.mediaOptions?.includes("fileName"))
    send.option("--filename <name>", "the name others see for the --file, instead of its name on disk")
  if (messenger.html) send.option("--html", HTML_HELP)
  if (messenger.stickers === true)
    send.option("--sticker <id>", "send this sticker, alone; `stickers list` finds its id")
  return send
}

const sendText = async (command: Command, messenger: Messenger, chat: string, text: string | undefined) => {
  const context = messengerContext(command, messenger)
  const {
    topic,
    replyTo: typedReplyTo,
    commentTo: typedCommentTo,
    sendAs: givenSendAs,
    sendId,
    silent,
    preview,
    md: markdown,
    html,
    atTime: at,
    file,
    photo,
    voice,
    asFile,
    filename,
    allowAnyFile,
    spoiler,
    captionAbove,
    sticker,
  } = command.opts<{
    topic?: string
    replyTo?: string
    commentTo?: string
    sendAs?: string
    sendId?: string
    silent?: boolean
    preview?: boolean
    md?: boolean
    html?: boolean
    atTime?: string
    file?: string
    photo?: string
    voice?: string
    asFile?: boolean
    filename?: string
    allowAnyFile?: boolean
    spoiler?: boolean
    captionAbove?: boolean
    sticker?: string
  }>()
  const threadId = threadIdOf(topic)
  const scheduledFor = at === undefined ? undefined : sendTime(at)
  const replyTo = typedReplyTo?.trim()
  if (replyTo === "") throw new CliError("validation_error", "--reply-to needs the id of the message to answer")
  const sendAs = typedSendAs(givenSendAs)
  const commentTo = typedCommentTo?.trim()
  if (commentTo === "") throw new CliError("validation_error", "--comment-to needs the post's message id")
  const read = { app: messenger.app, env: context.env, anyFile: allowAnyFile === true }
  const attachments = await readAttachments(
    {
      ...(photo === undefined ? {} : { photo }),
      ...(file === undefined ? {} : { file }),
      ...(voice === undefined ? {} : { voice }),
      ...(text === undefined ? {} : { text }),
      asFile: asFile === true,
      ...(filename === undefined ? {} : { filename }),
    },
    read,
  )
  const body = text ?? (attachments.length > 0 || sticker !== undefined ? "" : await readAll(context.stdin))
  if (body.trim() === "" && attachments.length === 0 && sticker === undefined) {
    throw new CliError("validation_error", "nothing to send — give the text or pipe it in")
  }
  const sent = await context.withServices((services) =>
    services.messages.send({
      chat,
      text: body,
      ...(sendId === undefined ? {} : { sendId }),
      ...(replyTo === undefined ? {} : { replyTo }),
      ...(commentTo === undefined ? {} : { commentTo }),
      ...(threadId === undefined ? {} : { threadId }),
      ...(sendAs === undefined ? {} : { sendAs }),
      ...(silent === true ? { silent } : {}),
      ...(preview === false ? { noPreview: true } : {}),
      ...(markdown === true ? { markdown } : {}),
      ...(html === true ? { html } : {}),
      ...(scheduledFor === undefined ? {} : { at: scheduledFor }),
      ...(attachments.length > 0 ? { attachments } : {}),
      ...(spoiler === true ? { spoiler } : {}),
      ...(captionAbove === true ? { captionAbove } : {}),
      ...(sticker === undefined ? {} : { sticker }),
    }),
  )
  if (scheduledFor !== undefined) {
    context.renderer.note(`scheduled for ${scheduledFor} — it gets a new id when it is sent`)
    context.renderer.result({ sendId: sent.sendId, operationId: sent.operationId, message: sent.message, scheduledFor })
  } else context.renderer.result({ sendId: sent.sendId, operationId: sent.operationId, message: sent.message })
}
