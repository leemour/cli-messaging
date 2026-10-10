import { CliError } from "@wirecat/cli-core"
import { annotate } from "@wirecat/cli-core/commands"
import { Command } from "commander"
import { validateFormattedText } from "../../domain/formatting.js"
import type { Message } from "../../domain/models.js"
import { renderMessages } from "../../render/messages.js"
import { guardedWrite } from "../../sends/guarded.js"
import { newOperationId } from "../../sends/send-id.js"
import { readAttachments } from "../../sends/upload.js"
import { environmentOf } from "../context.js"
import { readAll } from "../messenger/stdin.js"
import { listed, positiveCount } from "../paging.js"
import { type BotContext, botContext } from "./context.js"
import type { BotAdapter, BotMessenger } from "./port.js"

/** The adapter's `method`, or a refusal naming what this messenger's bot cannot do. */
export const botCan = <K extends keyof BotAdapter>(
  adapter: BotAdapter,
  method: K,
  bot: BotMessenger,
  what: string,
): NonNullable<BotAdapter[K]> => {
  const found = adapter[method]
  if (typeof found !== "function") {
    throw new CliError("validation_error", `a ${bot.name ?? "messenger"} bot cannot ${what}`)
  }
  return found.bind(adapter) as NonNullable<BotAdapter[K]>
}

/** The bot's own id — the key its local copy is kept under — remembered after the first time it is asked. */
export const botIdOf = async (context: BotContext, adapter: BotAdapter): Promise<string> => {
  const known = context.registry.botId()
  if (known) return known
  const { id } = await adapter.me()
  context.registry.rememberBot(id)
  return id
}

const show = (context: BotContext, bot: BotMessenger, messages: Message[], one = false) => {
  if (context.format === "pretty") {
    context.streams.data(
      renderMessages(messages, {
        color: context.color,
        verbosity: context.settings.detail,
        senderColors: context.settings.senderColors,
        profile: context.profile,
        provider: bot.provider,
        locale: bot.app.locale,
      }),
    )
  } else if (context.format === "jsonl") context.renderer.stream(messages)
  else context.renderer.result(one ? messages[0] : listed(messages))
}

/** Says what fills the copy, rather than printing an empty list. */
const nothingKept = (context: BotContext) =>
  new CliError(
    "not_found",
    `this bot has kept nothing on this machine yet — run \`${context.words} messages list <chat>\` once without --offline`,
  )

const marks = (md: boolean | undefined, html: boolean | undefined) => {
  if (md && html) throw new CliError("validation_error", "--md and --html mark up the text two ways; use one")
}

/** Wrote somewhere real — a numeric chat — so the bot has seen that chat. */
const seen = (context: BotContext, message: Message) => {
  if (/^-?\d+$/.test(message.chatId)) context.registry.observe([{ id: message.chatId }])
}

const sendCommand = (bot: BotMessenger): Command =>
  annotate(new Command("send"), { mutates: true })
    .description("send a message as the bot; without [text], the text is read from stdin")
    .argument("<chat>", "a chat id, user:<id> for a person, or the title of a chat this bot has seen")
    .argument("[text]", "the message")
    .option("--reply-to <message>", "answer this message, by its id in the same chat")
    .option("--silent", "deliver without a notification")
    .option("--md", "read this messenger's Markdown; see its formatting guide for supported syntax")
    .option("--html", "the text is HTML: <b>, <i>, <a href>, <code>")
    .option("--file <file>", "attach a file; the text becomes its caption")
    .option("--photo <file>", "attach a .jpg, .png or .webp as a photo; the text becomes its caption")
    .option("--as-file", "send the --file as a file to download, a video included")
    .option("--voice <file>", "send an Ogg Opus file as a voice message, alone, with no text")
    .option("--allow-any-file", "send a file even from credential folders or this CLI's own folders")
    .action(async function (this: Command, chat: string, text: string | undefined) {
      const context = botContext(this, bot)
      const options = this.opts<{
        replyTo?: string
        silent?: boolean
        md?: boolean
        html?: boolean
        file?: string
        photo?: string
        asFile?: boolean
        voice?: string
        allowAnyFile?: boolean
      }>()
      marks(options.md, options.html)
      const ref = context.chatRef(chat)
      const attachments = await readAttachments(
        {
          ...(options.photo === undefined ? {} : { photo: options.photo }),
          ...(options.file === undefined ? {} : { file: options.file }),
          ...(options.voice === undefined ? {} : { voice: options.voice }),
          ...(text === undefined ? {} : { text }),
          asFile: options.asFile === true,
        },
        { app: bot.app, env: context.env, anyFile: options.allowAnyFile === true },
      )
      const body = text ?? (attachments.length > 0 ? "" : await readAll(environmentOf(this).stdin ?? process.stdin))
      if (body.trim() === "" && attachments.length === 0) {
        throw new CliError("validation_error", "nothing to send — give the text or pipe it in")
      }
      const replyTo = options.replyTo?.trim()
      await context.run(async (events) => {
        const adapter = await context.authenticated({ events })
        const send = botCan(adapter, "send", bot, "send messages")
        const { text: plain, spans } = options.md
          ? validateFormattedText(await botCan(adapter, "formatMarkdown", bot, "format Markdown")(body))
          : { text: body, spans: [] }
        if (plain.trim() === "" && !attachments.length)
          throw new CliError("validation_error", "nothing to send after formatting")
        const operationId = newOperationId()
        const message = await guardedWrite(
          context.guard(),
          {
            operationId,
            chatId: ref,
            kind: "message",
            key: "bot.messages.send",
            length: plain.length,
            ...(replyTo ? { replyTo } : {}),
          },
          () =>
            send(ref, plain, {
              ...(replyTo ? { replyTo } : {}),
              ...(options.silent ? { silent: true } : {}),
              ...(spans.length > 0 ? { formatting: spans } : {}),
              ...(options.html ? { html: true } : {}),
              ...(attachments.length > 0 ? { attachments } : {}),
            }),
          (sent) => ({ messageId: sent.id }),
        )
        seen(context, message)
        if (message.senderId) context.registry.rememberBot(message.senderId)
        const botId = message.senderId ?? (await botIdOf(context, adapter))
        await context.copy.keep(botId, [message], "send", context.renderer.warn, adapter.senders?.())
        context.renderer.result({ operationId, message })
      })
    })

const listCommand = (bot: BotMessenger): Command =>
  new Command("list")
    .description(
      `the latest messages in a chat; where ${bot.name ?? "the messenger"} gives a bot no history, and with --offline, ` +
        "the ones this bot has seen on this machine",
    )
    .argument("<chat>", "a chat id, user:<id> for a person, or the title of a chat this bot has seen")
    .option("--limit <n>", "how many, the newest", positiveCount("--limit"))
    .action(async function (this: Command, chat: string) {
      const context = botContext(this, bot)
      const ref = context.chatRef(chat)
      const limit = this.opts<{ limit?: number }>().limit ?? context.settings.limit
      await context.run(async (events) => {
        const fromCopy = async (botId: string) => {
          const page = await context.copy.read((store) => store.messages(context.copy.accountOf(botId), ref, { limit }))
          return page.items
        }
        if (context.settings.offline) {
          const botId = context.registry.botId()
          if (!botId) throw nothingKept(context)
          show(context, bot, await fromCopy(botId))
          return
        }
        const adapter = await context.authenticated({ events })
        const botId = await botIdOf(context, adapter)
        if (!adapter.history) {
          context.renderer.note(`${bot.name ?? "the messenger"} gives a bot no history: these are the messages it kept`)
          show(context, bot, await fromCopy(botId))
          return
        }
        const messages = await adapter.history(ref, { limit })
        await context.copy.keep(botId, messages, "history", context.renderer.warn, adapter.senders?.())
        if (/^-?\d+$/.test(ref)) context.registry.observe([{ id: ref }])
        show(context, bot, messages)
      })
    })

const showCommand = (bot: BotMessenger): Command =>
  new Command("show")
    .description("one message by its id in a chat")
    .argument("<chat>", "a chat id, user:<id> for a person, or the title of a chat this bot has seen")
    .argument("<message>", "message id")
    .action(async function (this: Command, chat: string, messageId: string) {
      const context = botContext(this, bot)
      const ref = context.chatRef(chat)
      await context.run(async (events) => {
        const fromCopy = async (botId: string) => {
          const kept = await context.copy.read((store) =>
            store.message(context.copy.accountOf(botId), messageId, { chatId: ref }),
          )
          if (!kept) throw new CliError("not_found", `message ${messageId} is not in this bot's local copy`)
          return kept
        }
        if (context.settings.offline) {
          const botId = context.registry.botId()
          if (!botId) throw nothingKept(context)
          show(context, bot, [await fromCopy(botId)], true)
          return
        }
        const adapter = await context.authenticated({ events })
        const botId = await botIdOf(context, adapter)
        if (!adapter.message) {
          show(context, bot, [await fromCopy(botId)], true)
          return
        }
        const found = await adapter.message(ref, messageId)
        await context.copy.keep(botId, [found], "history", context.renderer.warn, adapter.senders?.())
        show(context, bot, [found], true)
      })
    })

const editCommand = (bot: BotMessenger): Command =>
  annotate(new Command("edit"), { mutates: true })
    .description("replace the text of a message the bot sent")
    .argument("<chat>", "a chat id, user:<id> for a person, or the title of a chat this bot has seen")
    .argument("<message>", "message id")
    .argument("<text>", "the new text")
    .option("--md", "read this messenger's Markdown; see its formatting guide for supported syntax")
    .option("--html", "the text is HTML: <b>, <i>, <a href>, <code>")
    .action(async function (this: Command, chat: string, messageId: string, text: string) {
      const context = botContext(this, bot)
      const options = this.opts<{ md?: boolean; html?: boolean }>()
      marks(options.md, options.html)
      const ref = context.chatRef(chat)
      await context.run(async (events) => {
        const adapter = await context.authenticated({ events })
        const edit = botCan(adapter, "edit", bot, "edit messages")
        const { text: plain, spans } = options.md
          ? validateFormattedText(await botCan(adapter, "formatMarkdown", bot, "format Markdown")(text))
          : { text, spans: [] }
        if (plain.trim() === "") throw new CliError("validation_error", "no new text after formatting")
        const operationId = newOperationId()
        const message = await guardedWrite(
          context.guard(),
          { operationId, chatId: ref, kind: "edit", key: "bot.messages.edit", messageId, length: plain.length },
          () =>
            edit(ref, messageId, plain, {
              ...(spans.length > 0 ? { formatting: spans } : {}),
              ...(options.html ? { html: true } : {}),
            }),
        )
        await context.copy.keep(
          await botIdOf(context, adapter),
          [message],
          "send",
          context.renderer.warn,
          adapter.senders?.(),
        )
        context.renderer.result({ operationId, message })
      })
    })

const deleteCommand = (bot: BotMessenger): Command =>
  annotate(new Command("delete"), { mutates: true })
    .description("delete messages in a chat the bot can delete in; it cannot be undone")
    .argument("<chat>", "a chat id, user:<id> for a person, or the title of a chat this bot has seen")
    .argument("<messages...>", "message ids")
    .option("--allow-dangerous", "delete without asking")
    .action(async function (this: Command, chat: string, messageIds: string[]) {
      const context = botContext(this, bot)
      const ref = context.chatRef(chat)
      await context.run(async (events) => {
        const adapter = await context.authenticated({ events })
        const remove = botCan(adapter, "delete", bot, "delete messages")
        const operationId = newOperationId()
        await guardedWrite(
          context.guard(),
          { operationId, chatId: ref, kind: "delete", key: "bot.messages.delete", count: messageIds.length },
          () => remove(ref, messageIds),
        )
        await context.copy.forget(await botIdOf(context, adapter), ref, messageIds, context.renderer.warn)
        context.renderer.result({ operationId, deleted: messageIds })
      })
    })

const pinCommand = (bot: BotMessenger, pin: boolean): Command => {
  const command = annotate(new Command(pin ? "pin" : "unpin"), { mutates: true })
    .description(pin ? "pin a message in a chat; quietly unless --notify" : "unpin a message in a chat")
    .argument("<chat>", "a chat id, user:<id> for a person, or the title of a chat this bot has seen")
    .argument("<message>", "message id")
  if (pin) command.option("--notify", "tell the chat's members")
  return command.action(async function (this: Command, chat: string, messageId: string) {
    const context = botContext(this, bot)
    const ref = context.chatRef(chat)
    const notify = this.opts<{ notify?: boolean }>().notify === true
    await context.run(async (events) => {
      const adapter = await context.authenticated({ events })
      const operationId = newOperationId()
      const key = pin ? "bot.messages.pin" : "bot.messages.unpin"
      await guardedWrite(context.guard(), { operationId, chatId: ref, kind: "pin", key, messageId }, () =>
        pin
          ? botCan(adapter, "pin", bot, "pin messages")(ref, messageId, { notify })
          : botCan(adapter, "unpin", bot, "unpin messages")(ref, messageId),
      )
      context.renderer.result({ operationId, chatId: ref, messageId, pinned: pin })
    })
  })
}

/** `bot messages`: the bot's own messages, under the names the personal account uses. */
export const botMessagesCommand = (bot: BotMessenger): Command =>
  new Command("messages")
    .description("the messages in the chats this bot is in")
    .addCommand(sendCommand(bot))
    .addCommand(listCommand(bot))
    .addCommand(showCommand(bot))
    .addCommand(editCommand(bot))
    .addCommand(deleteCommand(bot))
    .addCommand(pinCommand(bot, true))
    .addCommand(pinCommand(bot, false))
