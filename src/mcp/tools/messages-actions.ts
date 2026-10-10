import * as v from "valibot"
import type { Messenger } from "../../cli/messenger/context.js"
import type { MessengerAdapter } from "../../cli/messenger/port.js"
import type { SendGuard } from "../../sends/guard.js"
import { onlineDeps, servicesFor } from "../../services/index.js"
import { type AnyTool, chatOf, message, tool, WRITE } from "../tool.js"
import { HTML_TOOL_HELP } from "./messages-send.js"

/** What changes a message others already have, offered with `--allow-send`, each behind its own `allow` permission. */
export const messageActionTools = (messenger: Messenger): Record<string, AnyTool> => {
  const chat = chatOf(messenger)
  const messages = (adapter: MessengerAdapter, guard: SendGuard) =>
    servicesFor({ ...onlineDeps(messenger, adapter, guard) }).messages
  const forwardInput = {
    chat: v.pipe(v.string(), v.minLength(1), v.description("the chat the message is in")),
    message,
    to: v.pipe(v.string(), v.minLength(1), v.description(`where it goes: ${messenger.chatArgument}`)),
    silent: v.optional(v.pipe(v.boolean(), v.description("deliver without a notification"))),
    send_as: v.optional(
      v.pipe(
        v.string(),
        v.minLength(1),
        v.description("an id from chats_send_as to post as; required where the chat posts as someone else by default"),
      ),
    ),
    send_id: v.optional(v.pipe(v.string(), v.minLength(1), v.description("from an earlier outcome_unknown"))),
    topic: v.optional(
      v.pipe(v.string(), v.minLength(1), v.description("a forum topic id of the to chat, from topics_list")),
    ),
  }
  if (!messenger.forwardTopic) delete (forwardInput as Partial<typeof forwardInput>).topic
  return {
    messages_edit: tool({
      title: "Edit a message",
      description:
        "Replace the text of one of the owner's own messages. Only when the owner asked for this exact change. " +
        "The other side may have read the old text already. Repeating the same edit changes nothing.",
      input: v.object({
        chat,
        message,
        text: v.pipe(v.string(), v.minLength(1)),
        md: v.optional(
          v.pipe(v.boolean(), v.description("read **bold**, _italic_, ~~struck~~ and `code`; \\ keeps a mark literal")),
        ),
        html: v.optional(v.pipe(v.boolean(), v.description(HTML_TOOL_HELP))),
      }),
      annotations: WRITE,
      permission: "edit",
      online: (adapter, args, { guard }) =>
        messages(adapter, guard).edit({
          chat: args.chat,
          message: args.message,
          text: args.text,
          markdown: args.md === true,
          ...(args.html === true ? { html: true } : {}),
        }),
    }),
    messages_forward: tool({
      title: "Forward a message",
      description:
        "Forward one message to another chat, where new people will read it. Only when the owner asked for this " +
        "message to go to this chat. On outcome_unknown, retry with the send_id it returns, never a new one: " +
        "a repeat without it is a second copy.",
      input: v.object(forwardInput),
      annotations: WRITE,
      permission: "forward",
      online: (adapter, args, { guard }) =>
        messages(adapter, guard).forward({
          chat: args.chat,
          message: args.message,
          to: args.to,
          silent: args.silent === true,
          ...(args.send_id === undefined ? {} : { sendId: args.send_id }),
          ...(args.send_as === undefined ? {} : { sendAs: args.send_as }),
          ...(args.topic === undefined ? {} : { threadId: args.topic }),
        }),
    }),
    messages_pin: tool({
      title: "Pin a message",
      description:
        "Pin one message in a chat, quietly unless notify is true. Only when the owner asked for this pin. " +
        "In a one-to-one chat the pin is on the owner's side only.",
      input: v.object({
        chat,
        message,
        notify: v.optional(v.pipe(v.boolean(), v.description("tell the chat's members"))),
      }),
      annotations: WRITE,
      permission: "pin",
      online: (adapter, args, { guard }) =>
        messages(adapter, guard).pin({ chat: args.chat, message: args.message, notify: args.notify === true }),
    }),
    messages_unpin: tool({
      title: "Unpin a message",
      description: "Unpin one message in a chat. Only when the owner asked for it.",
      input: v.object({ chat, message }),
      annotations: WRITE,
      permission: "pin",
      online: (adapter, args, { guard }) => messages(adapter, guard).unpin({ chat: args.chat, message: args.message }),
    }),
  }
}
