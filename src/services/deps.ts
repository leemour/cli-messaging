import { CliError } from "@wirecat/cli-core"
import type { AppIdentity } from "../cli/app.js"
import type { Messenger } from "../cli/messenger/context.js"
import type { MessengerAdapter } from "../cli/messenger/port.js"
import type { WarmEmbedders } from "../embeddings/embed.js"
import type { SendGuard } from "../sends/guard.js"
import type { AccountStore } from "../store/account-store.js"
import type { AccountKey, MessageStore } from "../store/store.js"

/**
 * What a service works with. Each part is opened on first use, so a read from the store never
 * connects and a command that never touches the store never opens it. Whoever built the deps closes
 * what they opened.
 */
export interface ServiceDeps {
  messenger: Messenger
  offline: boolean
  /** `store`: the messenger's history is read from the local store (`Messenger.history`); `server` when unset. */
  reads?: "server" | "store"
  account: () => Promise<AccountKey>
  /** Already saving what its reads answer, and recording each call as a run event. */
  connection: () => Promise<MessengerAdapter>
  /** A retained session serializes the whole fetch, including ingestion. */
  withConnection?: <T>(work: (adapter: MessengerAdapter) => Promise<T>) => Promise<T>
  /**
   * The whole store, every account in it. A service reads through `accountStore(deps)`; a read across
   * accounts on purpose names itself with `crossAccount(deps, reason)`.
   */
  store: () => Promise<MessageStore>
  guard: SendGuard
  /** For the profile's own files — a group's moderation rules. `default` and `process.env` when unset. */
  profile?: string
  env?: NodeJS.ProcessEnv
  /** A long-running process's open models, so a search does not load one each time. */
  embedders?: WarmEmbedders
  /** `false` keeps no search history: recording was turned off by name. Kept when unset. */
  history?: boolean
  searchCatchUp?: boolean
  agentText?: true
}

/** The store with the running account bound: the default for a service's reads and writes. */
export const accountStore = async (deps: Pick<ServiceDeps, "store" | "account">): Promise<AccountStore> =>
  (await deps.store()).forAccount(await deps.account())

/**
 * The whole store, for a read that spans accounts on purpose — `--source all`, `in:all`, `search all`.
 * `reason` says which, so every such read is found by searching for this name.
 */
export const crossAccount = (deps: Pick<ServiceDeps, "store">, _reason: string): Promise<MessageStore> => deps.store()

/** `accountStore`, or nothing when the store will not open or the account is not known yet. */
export const accountStoreIfOpen = async (deps: ServiceDeps): Promise<AccountStore | undefined> => {
  try {
    return await accountStore(deps)
  } catch {
    return undefined
  }
}

/**
 * Online, the store only adds to an answer the messenger already gave, so a store that will not open,
 * or that does not know whose account this is yet, loses nothing.
 */
export const storeIfOpen = async (
  deps: ServiceDeps,
): Promise<{ store: MessageStore; account: AccountKey } | undefined> => {
  try {
    return { store: await deps.store(), account: await deps.account() }
  } catch {
    return undefined
  }
}

/** Whether `chats`, `messages list|context` and `contacts` answer from the store instead of the messenger. */
export const fromStore = (deps: Pick<ServiceDeps, "offline" | "reads">): boolean =>
  deps.offline || deps.reads === "store"

/** What a store-mode read answers for a chat the store holds nothing of. */
export const nothingStored = (messenger: Messenger): string =>
  `nothing stored for this chat yet — keep \`${messenger.app.command} serve\` running`

/** Where a store-mode messenger's history comes from, for what it cannot do. */
export const PUSHED = "this messenger's history is read from the local store"

export const OFFLINE =
  "--offline answers only from what is kept locally: `chats list|show`, `messages list|show|context` and `contacts list|show`"

/** Over a connection that is already open — an MCP session holds one for minutes. */
export const onlineDeps = (
  messenger: Messenger,
  adapter: MessengerAdapter,
  guard: SendGuard,
  where: { profile?: string; env?: NodeJS.ProcessEnv } = {},
): ServiceDeps => ({
  messenger,
  ...where,
  offline: false,
  guard,
  connection: async () => adapter,
  account: async () => {
    const self = adapter.self()
    if (self === null) throw new CliError("authentication_error", "the connection does not know whose account it is")
    return { provider: messenger.provider, account: self }
  },
  store: async () => {
    throw new CliError("validation_error", "this answer comes from the messenger, not from the local store")
  },
})

/** Over the local store alone, for `--offline` and the tools that never ask the messenger. */
export const storedDeps = (
  messenger: Messenger,
  store: MessageStore,
  account: AccountKey,
  guard: SendGuard,
): ServiceDeps => ({
  messenger,
  offline: true,
  reads: messenger.history ?? "server",
  guard,
  account: async () => account,
  store: async () => store,
  connection: async () => {
    throw new CliError("validation_error", OFFLINE)
  },
})

/**
 * The store-backed reads of a messenger whose history is kept there, for an MCP read: not
 * `--offline`, so `inbox` and `review` answer too. Nothing here connects.
 */
export const storeModeDeps = (
  messenger: Messenger,
  store: MessageStore,
  account: AccountKey,
  guard: SendGuard,
): ServiceDeps => ({ ...storedDeps(messenger, store, account, guard), offline: false, reads: "store" })

const NOT_A_MESSENGER = "this program keeps its sources in the store and has no messenger to connect to"

/**
 * For a program that is not a messenger but keeps its own sources in the store — `cli-memo`'s notes and
 * mail: the services that read and build from the store alone (conversations, embeddings, person
 * context). It has no connection and no settings to resolve, and its guard refuses every write.
 */
export const storeOnlyDeps = (
  store: MessageStore,
  account: AccountKey,
  { app, env }: { app: AppIdentity; env?: NodeJS.ProcessEnv },
): ServiceDeps => {
  const refuse = (): never => {
    throw new CliError("validation_error", NOT_A_MESSENGER)
  }
  const messenger: Messenger = {
    app,
    provider: account.provider,
    chatArgument: "a stored chat, by its id or title",
    resolveSettings: refuse,
    connect: async () => refuse(),
  }
  const guard: SendGuard = { check: refuse, record: () => {} }
  return { ...storedDeps(messenger, store, account, guard), ...(env === undefined ? {} : { env }) }
}
