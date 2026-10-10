import type { MessageStore } from "../store/store.js"

type Action = Parameters<MessageStore["agentActions"]["record"]>[0]

/** One store for the audit rows, opened on the first call and kept until the server stops, not one per call. */
export const agentLog = (open: () => Promise<MessageStore>) => {
  let held: Promise<MessageStore> | undefined
  return {
    record: async (action: Action): Promise<void> => {
      held ??= open().catch((error: unknown) => {
        held = undefined
        throw error
      })
      await (await held).agentActions.record(action)
    },
    close: async (): Promise<void> => {
      const store = await held?.catch(() => undefined)
      held = undefined
      await store?.close()
    },
  }
}
