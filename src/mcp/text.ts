import { visibleControls } from "@wirecat/cli-core"

export const agentJson = (value: unknown): string =>
  JSON.stringify(value, (_key, item: unknown) => {
    if (typeof item === "string") return visibleControls(item)
    if (item !== null && typeof item === "object" && !Array.isArray(item))
      return Object.fromEntries(Object.entries(item).map(([key, value]) => [visibleControls(key), value]))
    return item
  })

export const agentArguments = (args: Record<string, unknown>): Record<string, unknown> => args
