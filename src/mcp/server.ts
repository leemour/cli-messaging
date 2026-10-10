import { McpServer } from "@modelcontextprotocol/server"
import { serveStdio } from "@modelcontextprotocol/server/stdio"
import { CliError } from "@wirecat/cli-core"
import { skillResource } from "@wirecat/cli-core/skill"
import * as v from "valibot"
import { recalledAccount } from "../cli/messenger/accounts.js"
import { connected, type Messenger, type MessengerContext } from "../cli/messenger/context.js"
import { warmEmbedders } from "../embeddings/embed.js"
import { guardFor } from "../sends/guard.js"
import { levelFor, readKeysForCommand } from "../sends/permissions.js"
import { openStore } from "../store/store.js"
import type { HttpOptions } from "./http/serve.js"
import { instructions } from "./instructions.js"
import { personalMcpTools } from "./personal.js"
import { registerPrompts } from "./prompts.js"
import { registerResources } from "./resources.js"
import { MessengerSession, type SessionOptions } from "./session.js"
import { commandOf, registerSurface } from "./surface.js"
import { READ, tool, toolKey } from "./tool.js"

export type ServerOptions = SessionOptions & { spawnJob?: import("../services/backfill-jobs.js").SpawnJob }

type Invocation = Parameters<Messenger["connect"]>[0]

/**
 * A factory of servers over one session. `serveStdio` may build a probe instance and throw it away
 * before settling on the protocol era, so each call is a fresh server — and all of them share the
 * one connection, which is the thing that must not be opened twice.
 */
export const createServer = (
  command: Invocation,
  context: MessengerContext,
  messenger: Messenger,
  sessionOptions: ServerOptions,
) => {
  const { app, provider } = messenger
  const name = messenger.name ?? app.command
  const { settings } = context
  const refreshPermissions = () => {
    const current = messenger.resolveSettings(command.optsWithGlobals(), { env: context.env })
    settings.permissions = current.permissions
    settings.permissionSources = current.permissionSources
  }
  const levelOf = (key: string | null | undefined) => (key ? levelFor(settings.permissions, key).level : "allow")
  // A tool the level would refuse is not offered: an agent is not handed a tool that cannot work.
  const offered = Object.fromEntries(
    Object.entries(personalMcpTools(messenger)).filter(([key, one]) => {
      const level = levelOf(toolKey(key, one))
      const writes = one.permission !== undefined || one.annotations.readOnlyHint !== true
      return (
        level !== "deny" &&
        !(writes && level === "readonly") &&
        readKeysForCommand(key.split("_")).every((data) => levelOf(data) !== "deny")
      )
    }),
  )
  const writes = Object.fromEntries(Object.entries(offered).filter(([, one]) => one.annotations.readOnlyHint !== true))
  // No one is at a terminal to answer the guard's question: over MCP a write at level `ask` goes ahead.
  const guard = messenger.guard
    ? context.guard
    : guardFor(app, settings, context.renderer.warn, context.env, async () => {})
  const session = new MessengerSession(
    async (events) => connected(await messenger.connect(command, context, { events }), messenger, context, events),
    (run, body) => context.run(body, { name: run }),
    sessionOptions,
  )

  const embedders = warmEmbedders()
  const status = tool({
    title: "This server's profile and login",
    description:
      "Which profile this server speaks for, which account it last logged in as here, and which writing commands " +
      "are on. Never connects, so it answers when the login is what is broken.",
    input: v.strictObject({}),
    annotations: { ...READ, idempotentHint: true },
    local: async () => ({
      profile: settings.profile,
      account: recalledAccount(app, provider, settings.profile, context.env)?.account ?? null,
      writes: Object.keys(writes).map(commandOf),
      permissions: settings.permissions,
      ...(messenger.diagnose ? { [messenger.provider]: await messenger.diagnose(command, context) } : {}),
    }),
  })
  const skill = messenger.skill ? skillResource(app, messenger.skill) : undefined

  const build = (): McpServer => {
    const server = new McpServer(
      { name: app.command, version: app.version },
      {
        instructions: instructions({
          command: app.command,
          name,
          profile: settings.profile,
          writes: Object.keys(writes),
          ...(skill ? { skill: skill.instruction } : {}),
        }),
      },
    )
    registerSurface(
      server,
      { ...offered, status },
      {
        command: app.command,
        messenger,
        session,
        withStore: context.withStore,
        log: async (call) => {
          if (!recalledAccount(app, provider, settings.profile, context.env)) return
          const store = await openStore({ env: context.env, command: app.command })
          try {
            await store.agentActions.record({ actor: { bot: `${app.command}-mcp` }, ...call })
          } finally {
            await store.close()
          }
        },
        around: (key, definition, work) => {
          refreshPermissions()
          const level = levelOf(toolKey(key, definition))
          if (level === "deny" || (definition.annotations.readOnlyHint !== true && level === "readonly"))
            throw new CliError("permission_error", "the current profile does not allow this command", {
              permission: toolKey(key, definition),
            })
          return work()
        },
        defaults: {
          spawnJob: sessionOptions.spawnJob,
          limit: settings.limit,
          get syncAllowed() {
            return levelOf("messages.sync-first") === "allow"
          },
          guard,
          settings,
          env: context.env,
          embedders,
          history: settings.keepFailedRuns,
        },
      },
    )
    // The prompts and resources show messages, so a profile that may not read them gets neither.
    if (levelOf("messages") !== "deny") registerPrompts(server, { command: app.command, name })
    if (levelOf("messages") !== "deny")
      registerResources(server, session, {
        command: app.command,
        name,
        limit: settings.limit,
        recorded: () => recalledAccount(app, provider, settings.profile, context.env) !== undefined,
        withStore: context.withStore,
        messenger,
        guard,
        assertRead: (key) => {
          refreshPermissions()
          if (levelOf(key) === "deny")
            throw new CliError("permission_error", "the current profile does not allow this resource", {
              permission: key,
            })
        },
      })
    if (skill) {
      const { uri, name: resource, title, description, mimeType, read } = skill
      server.registerResource(resource, uri, { title, description, mimeType }, read)
    }
    return server
  }
  return { session, embedders, build }
}

/**
 * Serves until the client closes stdin or the process is told to stop, then closes the connection.
 * **Returning is what lets the process exit**: the transport lets go of stdin, and the session is
 * the only other thing that could hold it open.
 */
export const serveOverStdio = async (
  command: Invocation,
  context: MessengerContext,
  messenger: Messenger,
  options: ServerOptions,
): Promise<void> => {
  const { session, embedders, build } = createServer(command, context, messenger, options)
  const handle = serveStdio(build, { onerror: (error) => context.renderer.note(`mcp: ${error.message}`) })

  await new Promise<void>((resolve) => {
    process.stdin.once("end", resolve)
    process.stdin.once("close", resolve)
    process.once("SIGINT", resolve)
    process.once("SIGTERM", resolve)
  })

  try {
    await handle.close()
    await session.close()
  } finally {
    await embedders.close()
  }
}

/** The same server over HTTP, until Ctrl-C (CLI-58). */
export const serveOverHttpUntilStopped = async (
  command: Invocation,
  context: MessengerContext,
  messenger: Messenger,
  options: ServerOptions,
  http: Omit<HttpOptions, "onCode" | "onError" | "appName">,
): Promise<void> => {
  const { session, embedders, build } = createServer(command, context, messenger, options)
  const { serveOverHttp } = await import("./http/serve.js")
  const appName = messenger.app.command
  const listening = await serveOverHttp(build, {
    ...http,
    appName,
    onCode: (code, expires) =>
      context.renderer.note(
        `login code for a new browser app: ${code} (until ${expires.toTimeString().slice(0, 5)}; a new one after each login)`,
      ),
    onError: (error) => context.renderer.note(`mcp: ${error.message}`),
  }).catch(async (error: unknown) => {
    await session.close()
    await embedders.close()
    if ((error as NodeJS.ErrnoException).code === "EADDRINUSE")
      throw new CliError("configuration_error", `port ${http.port} is in use — pass another with --port`)
    throw error
  })
  context.renderer.note(
    `serving on ${listening.url.href} — point your tunnel at it; connectors use ${new URL("/mcp", http.publicUrl).href}`,
  )

  await new Promise<void>((resolve) => {
    process.once("SIGINT", resolve)
    process.once("SIGTERM", resolve)
  })

  try {
    await listening.close()
    await session.close()
  } finally {
    await embedders.close()
  }
}
