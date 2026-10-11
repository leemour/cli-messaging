import { existsSync } from "node:fs"
import { DEFAULT_STEMMERS, parseStemmers, type Stemmers } from "../search/stem.js"
import { openCache } from "../store/open.js"
import { storePath } from "../store/path.js"
import { openStore, savedStemmers, stemmersOrigin } from "../store/store.js"
import type { AppIdentity } from "./app.js"

const SCRIPTS: Record<string, keyof Stemmers> = {
  "searchStemmers.cyrillic": "cyrillic",
  "searchStemmers.latin": "latin",
}

/** Settings of the store file, not of a profile: the store is one file for every profile, tg and MAX. */
export const STORE_SETTINGS = Object.keys(SCRIPTS)

export const isStoreSetting = (setting: string): boolean => setting in SCRIPTS

export const changeStoreSetting = async (
  app: AppIdentity,
  env: NodeJS.ProcessEnv,
  setting: string,
  value: string | undefined,
) => {
  const script = SCRIPTS[setting] as keyof Stemmers
  const store = await openStore({ env })
  try {
    const current = (await store.stemmers()) ?? DEFAULT_STEMMERS
    const next = parseStemmers({ ...current, [script]: value ?? DEFAULT_STEMMERS[script] })
    await store.saveStemmers(next)
    return {
      result: { store: storePath(env), scope: "store", setting, value: next[script] },
      note: `store-wide — every profile, tg and MAX; stemmed search waits for \`${app.command} store reindex\``,
    }
  } finally {
    await store.close()
  }
}

/** For `config show`: reads the file as it is — never creates, migrates or unseals it to say the defaults apply. */
export const storeSettings = async (env: NodeJS.ProcessEnv) => {
  const path = storePath(env)
  let saved: Stemmers | null | undefined
  let byDefault = false
  let unreadable = false
  if (existsSync(path)) {
    try {
      const database = await openCache(path)
      try {
        const table = database.prepare("SELECT 1 FROM sqlite_master WHERE name = 'store_settings'").get()
        saved = table ? savedStemmers(database) : undefined
        byDefault = table ? stemmersOrigin(database)?.origin === "default" : false
      } finally {
        database.close()
      }
    } catch {
      unreadable = true
    }
  }
  return STORE_SETTINGS.map((setting) => {
    const script = SCRIPTS[setting] as keyof Stemmers
    if (unreadable) return { setting, value: null, from: "store unreadable", scope: "store" }
    if (saved === null) return { setting, value: null, from: "store, unknown to this build", scope: "store" }
    return {
      setting,
      value: (saved ?? DEFAULT_STEMMERS)[script],
      from: saved && !byDefault ? "store" : "default",
      scope: "store",
    }
  })
}
