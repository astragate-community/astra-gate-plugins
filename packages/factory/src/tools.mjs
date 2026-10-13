// Factory: wrapping a tool whose schema opens with a composition keyword, on the way out (tool-replies.mjs
// unwraps the arguments again on the way back).
import { bodyText } from "./body.mjs"

// Factory rejects composition keywords at the tool schema's root. Keep the
// original schema under one argument, and hide that wire-only envelope from
// the caller in both replies and the next turn's history.
export const argument = "arguments"
const compositions = ["anyOf", "oneOf", "allOf"]
const schemaMaps = ["properties", "patternProperties", "$defs", "definitions", "dependentSchemas"]
const schemaLists = ["anyOf", "oneOf", "allOf", "prefixItems"]
const schemaValues = ["additionalProperties", "unevaluatedProperties", "propertyNames", "contains", "items", "additionalItems", "unevaluatedItems", "not", "if", "then", "else", "contentSchema"]
export const isObject = (v) => v != null && typeof v === "object" && !Array.isArray(v)

export function parseToolJSON(text) {
  return JSON.parse(text, (_key, value, context) => {
    if (typeof value !== "number" || Number.isSafeInteger(value)) return value
    if (context?.source && typeof JSON.rawJSON === "function") return JSON.rawJSON(context.source)
    // Never round a tool's large integer into a different argument on an old
    // runtime that cannot retain JSON number tokens.
    if (!Number.isFinite(value) || Number.isInteger(value)) throw new Error("Factory: this runtime cannot preserve the tool's JSON number")
    return value
  })
}

function rebaseSchema(schema, rebase = true, legacy = false) {
  if (!isObject(schema)) return
  const id = schema.$id ?? (legacy ? schema.id : undefined)
  if (typeof id === "string" && id.split("#")[0]) rebase = false
  if (rebase) {
    // Draft 2019-09's recursive anchor must remain a resource root. Refuse
    // this unsupported relocation instead of changing its resolution scope.
    if (schema.$recursiveAnchor === true || Object.hasOwn(schema, "$recursiveRef")) throw new Error("Factory: a recursive tool schema needs $id before it can be wrapped")
    for (const key of ["$ref", "$dynamicRef"]) {
      const ref = schema[key]
      if (typeof ref !== "string" || !ref.startsWith("#")) continue
      const pointer = decodeURIComponent(ref.slice(1))
      if (pointer === "" || pointer.startsWith("/")) schema[key] = "#/properties/" + argument + ref.slice(1)
    }
  }
  // Visit schema positions only: const/default/examples may contain ordinary
  // data named $ref, properties or anyOf and must not be rewritten.
  for (const key of schemaMaps) {
    if (isObject(schema[key])) for (const child of Object.values(schema[key])) rebaseSchema(child, rebase, legacy)
  }
  for (const key of schemaLists) {
    if (Array.isArray(schema[key])) for (const child of schema[key]) rebaseSchema(child, rebase, legacy)
  }
  for (const key of schemaValues) {
    if (Array.isArray(schema[key])) for (const child of schema[key]) rebaseSchema(child, rebase, legacy)
    else rebaseSchema(schema[key], rebase, legacy)
  }
  if (isObject(schema.dependencies)) for (const child of Object.values(schema.dependencies)) rebaseSchema(child, rebase, legacy)
}

/** Wraps the tools of an Anthropic request body: { body, names } with the names of the tools that were wrapped. */
export function wrapAnthropicTools(body) {
  const names = new Set()
  const text = bodyText(body) ?? ""
  let request
  try { request = parseToolJSON(text) } catch (e) {
    if (!(e instanceof SyntaxError)) throw e
    return { body, names }
  }
  if (!Array.isArray(request?.tools) || !Array.isArray(request.messages)) return { body, names }
  for (const tool of request.tools) {
    const schema = tool?.input_schema
    if (typeof tool?.name !== "string" || !isObject(schema) || !compositions.some((key) => Object.hasOwn(schema, key))) continue
    rebaseSchema(schema, true, /draft-0[34]/.test(schema.$schema ?? ""))
    tool.input_schema = { type: "object", properties: { [argument]: schema }, required: [argument], additionalProperties: false }
    if (schema.$schema) tool.input_schema.$schema = schema.$schema
    if (Array.isArray(tool.input_examples)) tool.input_examples = tool.input_examples.map((input) => ({ [argument]: input }))
    names.add(tool.name)
  }
  if (!names.size) return { body, names }
  for (const message of request.messages) {
    if (message?.role !== "assistant" || !Array.isArray(message.content)) continue
    for (const block of message.content) {
      if (block?.type === "tool_use" && names.has(block.name) && Object.hasOwn(block, "input")) block.input = { [argument]: block.input }
    }
  }
  return { body: JSON.stringify(request), names }
}
