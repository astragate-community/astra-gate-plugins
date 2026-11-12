// Factory: wrapping a tool whose schema opens with a composition keyword, on the way out (reply.js unwraps the
// arguments again on the way back).

// Factory rejects composition keywords at the tool schema's root. Keep the original schema under one argument, and hide
// that wire-only envelope from the caller in both replies and the next turn's history.
export const argument = "arguments";
const compositions = ["anyOf", "oneOf", "allOf"];
const schemaMaps = ["properties", "patternProperties", "$defs", "definitions", "dependentSchemas"];
const schemaLists = ["anyOf", "oneOf", "allOf", "prefixItems"];
const schemaValues = ["additionalProperties", "unevaluatedProperties", "propertyNames", "contains", "items", "additionalItems", "unevaluatedItems", "not", "if", "then", "else", "contentSchema"];
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
export const isObject = (v) => v != null && typeof v === "object" && !Array.isArray(v);

function rebaseSchema(schema, rebase = true, legacy = false) {
  if (!isObject(schema)) return;
  const id = schema.$id ?? (legacy ? schema.id : undefined);
  if (typeof id === "string" && id.split("#")[0]) rebase = false;
  if (rebase) {
    // Draft 2019-09's recursive anchor must remain a resource root. Refuse this unsupported relocation instead of
    // changing its resolution scope.
    if (schema.$recursiveAnchor === true || has(schema, "$recursiveRef")) throw new Error("Factory: a recursive tool schema needs $id before it can be wrapped");
    for (const key of ["$ref", "$dynamicRef"]) {
      const ref = schema[key];
      if (typeof ref !== "string" || !ref.startsWith("#")) continue;
      const pointer = decodeURIComponent(ref.slice(1));
      if (pointer === "" || pointer.startsWith("/")) schema[key] = "#/properties/" + argument + ref.slice(1);
    }
  }
  // Visit schema positions only: const/default/examples may contain ordinary data named $ref, properties or anyOf and
  // must not be rewritten.
  for (const key of schemaMaps) {
    if (isObject(schema[key])) for (const child of Object.values(schema[key])) rebaseSchema(child, rebase, legacy);
  }
  for (const key of schemaLists) {
    if (Array.isArray(schema[key])) for (const child of schema[key]) rebaseSchema(child, rebase, legacy);
  }
  for (const key of schemaValues) {
    if (Array.isArray(schema[key])) for (const child of schema[key]) rebaseSchema(child, rebase, legacy);
    else rebaseSchema(schema[key], rebase, legacy);
  }
  if (isObject(schema.dependencies)) for (const child of Object.values(schema.dependencies)) rebaseSchema(child, rebase, legacy);
}

/**
 * Wraps the tools of an Anthropic request body whose schema opens with anyOf / oneOf / allOf: { body, names }, a changed
 * copy and the names of the tools that were wrapped (the body itself, and no names, when none was).
 */
export function wrapAnthropicTools(body) {
  const names = new Set();
  if (!isObject(body) || !Array.isArray(body.tools) || !Array.isArray(body.messages)) return { body, names };
  const request = JSON.parse(JSON.stringify(body));
  for (const tool of request.tools) {
    const schema = tool?.input_schema;
    if (typeof tool?.name !== "string" || !isObject(schema) || !compositions.some((key) => has(schema, key))) continue;
    rebaseSchema(schema, true, /draft-0[34]/.test(schema.$schema ?? ""));
    tool.input_schema = { type: "object", properties: { [argument]: schema }, required: [argument], additionalProperties: false };
    if (schema.$schema) tool.input_schema.$schema = schema.$schema;
    if (Array.isArray(tool.input_examples)) tool.input_examples = tool.input_examples.map((input) => ({ [argument]: input }));
    names.add(tool.name);
  }
  if (!names.size) return { body, names };
  for (const message of request.messages) {
    if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (block?.type === "tool_use" && names.has(block.name) && has(block, "input")) block.input = { [argument]: block.input };
    }
  }
  return { body: request, names };
}
