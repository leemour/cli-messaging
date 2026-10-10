import { projectFields as coreProjectFields } from "@wirecat/cli-core"

export { fieldsOf } from "@wirecat/cli-core"

export const projectFields = (value: unknown, fields: readonly string[]): unknown =>
  coreProjectFields(value, fields.length === 0 ? ["operationId", "sendId"] : fields)
