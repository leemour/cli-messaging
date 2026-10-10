import { fieldsOf as coreFieldsOf, projectFields as coreProjectFields } from "@wirecat/cli-core"
import { describe, expect, it } from "vitest"
import { fieldsOf, projectFields } from "./result-fields.js"

describe("machine result projection", () => {
  it("preserves list metadata while projecting requested item data", () => {
    const value = {
      items: [{ id: "7", text: "synthetic", sender: { id: "8", name: "Synthetic" } }],
      page: 2,
      limit: 10,
      hasMore: true,
      coverage: { state: "partial" },
      total: 40,
      by: "sender",
      nextBeforeId: "synthetic-next",
    }
    expect(projectFields(value, fieldsOf("id,sender.id"))).toEqual({
      items: [{ id: "7", sender: { id: "8" } }],
      page: 2,
      limit: 10,
      hasMore: true,
      coverage: { state: "partial" },
      total: 40,
      by: "sender",
      nextBeforeId: "synthetic-next",
    })
    expect(value.items[0]?.sender.name).toBe("Synthetic")
  })
  it("never removes correlation or invents missing values", () => {
    expect(
      projectFields({ id: "7", operationId: "synthetic-operation", missing: null }, ["id", "missing", "unknown"]),
    ).toEqual({ id: "7", operationId: "synthetic-operation", missing: null })
    expect(projectFields([{ id: "7", text: "synthetic" }], ["id"])).toEqual([{ id: "7" }])
    expect(projectFields(null, ["id"])).toBeNull()
  })
  it("rejects unsafe paths, empty names and excessive field lists", () => {
    for (const path of [
      "",
      "id,",
      "__proto__.x",
      "sender.constructor",
      "a[0]",
      Array.from({ length: 129 }, () => "id").join(","),
    ])
      expect(() => fieldsOf(path)).toThrow("--fields")
    expect(fieldsOf("id, id")).toEqual(["id"])
  })
  it("does not mutate an immutable parent when paths overlap", () => {
    const sender = Object.freeze({ id: "8", name: "Synthetic" })
    expect(projectFields({ sender }, ["sender", "sender.id"])).toEqual({ sender })
    expect(projectFields({ sender: null }, ["sender.id"])).toEqual({})
  })
})

it("accepts items.id consistently for paged rows, arrays and JSONL items", () => {
  expect(projectFields({ items: [{ id: "synthetic", text: "synthetic" }], hasMore: true }, ["items.id"])).toEqual({
    items: [{ id: "synthetic" }],
    hasMore: true,
  })
  expect(projectFields([{ id: "synthetic" }], ["items.id"])).toEqual([{ id: "synthetic" }])
  expect(projectFields({ id: "synthetic", text: "synthetic" }, ["items.id"])).toEqual({ id: "synthetic" })
})

it("reuses core projection while preserving metadata-only empty selections", () => {
  expect(fieldsOf).toBe(coreFieldsOf)
  const value = {
    items: [
      { id: "example", operationId: "example-operation", sendId: "example-send" },
      { id: "second-example" },
      null,
    ],
    page: 2,
    limit: 3,
    hasMore: false,
    coverage: { state: "partial" },
    operationId: "example-page-operation",
  }
  expect(projectFields(value, [])).toEqual({
    ...value,
    items: [{ operationId: "example-operation", sendId: "example-send" }, {}, null],
  })
  expect(projectFields({ id: "example", sendId: "example-send" }, [])).toEqual({ sendId: "example-send" })
  expect(projectFields([{ id: "example" }, null, 3], [])).toEqual([{}, null, 3])
  expect(projectFields({ items: null, id: "example" }, [])).toEqual({})
  expect(projectFields(value, fieldsOf("items.id"))).toEqual(coreProjectFields(value, fieldsOf("items.id")))
})

it("rejects unsafe direct paths and excessive selections before projection", () => {
  for (const paths of [
    ["__proto__.example"],
    ["sender.constructor"],
    ["a.prototype.example"],
    ["a".repeat(257)],
    Array.from({ length: 129 }, () => "id"),
  ])
    expect(() => projectFields({}, paths)).toThrow("--fields")
})
