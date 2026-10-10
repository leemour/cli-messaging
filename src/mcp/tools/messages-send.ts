import { CliError } from "@wirecat/cli-core"
import * as v from "valibot"
import type { Messenger } from "../../cli/messenger/context.js"
import { sendTime } from "../../domain/send-time.js"
import { readAttachments } from "../../sends/upload.js"
import { onlineDeps, servicesFor } from "../../services/index.js"
import { type AnyTool, chatOf, message, nameOf, tool, WRITE } from "../tool.js"

export const HTML_TOOL_HELP = "the text is HTML: <b>, <i>, <u>, <s>, <a href>, <code>, <pre>; not with md"

/**
 * The same guard as the command: profile permissions, recipients, hourly limits and the journal.
 */
export const messageSendTools = (messenger: Messenger): Record<string, AnyTool> => {
  const chat = chatOf(messenger)
  const name = nameOf(messenger)
  return {
    messages_send: tool({
      title: "Send a message",
      description:
        "Send one message as the owner — text, or a file or photo from the owner's machine with the text as its " +
        "caption. Only when the owner asked for this exact message to this exact chat. Hidden files and folders, " +
        `~/.ssh and ${messenger.app.command}'s own folders are refused, with no way around it here. ` +
        "A name that matches several chats is refused with the candidates — pick an id, never guess. " +
        `On outcome_unknown, retry with the send_id it returns and ${name} drops the duplicate; never with a new one. ` +
        `With \`at\`, ${name} sends it later and the answer carries scheduledFor; never retry a scheduled send — ` +
        "read messages_scheduled instead.",
      input: v.object({
        chat,
        text: v.optional(v.pipe(v.string(), v.description("the message, or the caption of a file or photo"))),
        file: v.optional(
          v.pipe(v.string(), v.minLength(1), v.description("a path on the owner's machine to attach as a file")),
        ),
        photo: v.optional(
          v.pipe(v.string(), v.minLength(1), v.description("a .jpg, .png or .webp to attach as a photo")),
        ),
        as_file: v.optional(
          v.pipe(v.boolean(), v.description("send the file as a file to download, a video included")),
        ),
        filename: v.optional(
          v.pipe(v.string(), v.minLength(1), v.description("the name others see for the file, instead of its own")),
        ),
        spoiler: v.optional(v.pipe(v.boolean(), v.description("hide the photo or video behind a spoiler"))),
        caption_above: v.optional(v.pipe(v.boolean(), v.description("show the text above the photo or file"))),
        voice: v.optional(
          v.pipe(v.string(), v.minLength(1), v.description("an Ogg Opus file to send as a voice message, alone")),
        ),
        reply_to: v.optional(v.pipe(message, v.description("the message this answers, in the same chat"))),
        comment_to: v.optional(
          v.pipe(message, v.description("a post of this channel to comment on; the comment goes to its discussion")),
        ),
        topic: v.optional(
          v.pipe(v.string(), v.minLength(1), v.description("the forum topic id; unsupported without topics")),
        ),
        send_as: v.optional(
          v.pipe(
            v.string(),
            v.minLength(1),
            v.description(
              "an id from chats_send_as to post as; required where the chat posts as someone else by default",
            ),
          ),
        ),
        send_id: v.optional(v.pipe(v.string(), v.minLength(1), v.description("from an earlier outcome_unknown"))),
        silent: v.optional(v.pipe(v.boolean(), v.description("deliver without a notification"))),
        no_preview: v.optional(v.pipe(v.boolean(), v.description("no preview card for a link in the text"))),
        md: v.optional(
          v.pipe(v.boolean(), v.description("read **bold**, _italic_, ~~struck~~ and `code`; \\ keeps a mark literal")),
        ),
        html: v.optional(v.pipe(v.boolean(), v.description(HTML_TOOL_HELP))),
        at_time: v.optional(
          v.pipe(
            v.string(),
            v.description("send it later: 2026-09-25T09:00 (the owner's local time), or 30m, 2h, 1d from now"),
          ),
        ),
      }),
      annotations: WRITE,
      permission: "send",
      online: async (adapter, args, { guard, env }) => {
        const at = args.at_time === undefined ? undefined : sendTime(args.at_time)
        // Never anyFile here: a path an agent was talked into is how a key would leave the machine.
        const read = { app: messenger.app, env }
        if (args.filename !== undefined && !messenger.mediaOptions?.includes("fileName"))
          throw new CliError("validation_error", "this messenger has no --filename")
        const attachments = await readAttachments(
          {
            ...(args.photo === undefined ? {} : { photo: args.photo }),
            ...(args.file === undefined ? {} : { file: args.file }),
            ...(args.voice === undefined ? {} : { voice: args.voice }),
            ...(args.text === undefined ? {} : { text: args.text }),
            asFile: args.as_file === true,
            ...(args.filename === undefined ? {} : { filename: args.filename }),
          },
          read,
        )
        if ((args.text ?? "").trim() === "" && attachments.length === 0) {
          throw new CliError("validation_error", "nothing to send — give text, a file or a photo")
        }
        const sent = await servicesFor({ ...onlineDeps(messenger, adapter, guard) }).messages.send({
          chat: args.chat,
          text: args.text ?? "",
          ...(attachments.length === 0 ? {} : { attachments }),
          ...(args.spoiler === true ? { spoiler: true } : {}),
          ...(args.caption_above === true ? { captionAbove: true } : {}),
          ...(args.send_id === undefined ? {} : { sendId: args.send_id }),
          ...(args.topic === undefined ? {} : { threadId: args.topic }),
          ...(args.send_as === undefined ? {} : { sendAs: args.send_as }),
          ...(args.reply_to === undefined ? {} : { replyTo: args.reply_to }),
          ...(args.comment_to === undefined ? {} : { commentTo: args.comment_to }),
          ...(args.silent === true ? { silent: true } : {}),
          ...(args.no_preview === true ? { noPreview: true } : {}),
          ...(args.md === true ? { markdown: true } : {}),
          ...(args.html === true ? { html: true } : {}),
          ...(at === undefined ? {} : { at }),
        })
        return {
          sendId: sent.sendId,
          operationId: sent.operationId,
          message: sent.message,
          ...(at === undefined ? {} : { scheduledFor: at }),
        }
      },
    }),
  }
}
