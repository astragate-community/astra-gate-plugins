// Antigravity: a JSON schema cut down to what its function declarations take.
//
// Code Assist takes an OpenAPI-style subset of JSON schema — no references, unions or keywords outside it — and turns a
// request away over any keyword it doesn't know, so a tool's schema (Claude Code's and MCP servers' carry $ref, anyOf,
// additionalProperties, format, default, …) is flattened to it before it goes.

// keywords kept as they are
const KEEP = new Set(["description", "nullable", "required", "pattern", "minimum", "maximum", "minLength", "maxLength", "minItems", "maxItems",
  "minProperties", "maxProperties", "propertyOrdering"])
const MAX_DEPTH = 32

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v)

export function plainSchema(schema) {
  if (!isObject(schema)) return { type: "object", properties: {} }
  const defs = { ...(isObject(schema.definitions) ? schema.definitions : {}), ...(isObject(schema.$defs) ? schema.$defs : {}) }
  const out = walk(schema, defs, 0)
  return isObject(out) && Object.keys(out).length ? out : { type: "object", properties: {} }
}

function walk(v, defs, depth) {
  if (Array.isArray(v)) return v.map((e) => walk(e, defs, depth))
  if (!isObject(v)) return v
  if (depth > MAX_DEPTH) return { type: "object" }
  if (typeof v.$ref === "string") {
    const d = defs[v.$ref.slice(v.$ref.lastIndexOf("/") + 1)]
    return d ? walk(d, defs, depth + 1) : { type: "object" }
  }
  if (Array.isArray(v.allOf)) {
    // one schema with the fields of all its members
    const merged = { ...v }
    delete merged.allOf
    for (const e of v.allOf) {
      const m = walk(e, defs, depth + 1)
      if (!isObject(m)) continue
      for (const [k, x] of Object.entries(m)) {
        if (k === "properties") merged.properties = { ...(isObject(merged.properties) ? merged.properties : {}), ...x }
        else if (k === "required") merged.required = [...new Set([...(Array.isArray(merged.required) ? merged.required : []), ...x])]
        else if (!(k in merged)) merged[k] = x
      }
    }
    return walk(merged, defs, depth + 1)
  }
  for (const k of ["anyOf", "oneOf"]) {
    if (!Array.isArray(v[k])) continue
    // the first member that isn't null; null among them makes it nullable
    const alts = v[k].filter(isObject)
    const pick = alts.find((a) => a.type !== "null")
    const out = pick ? walk(pick, defs, depth + 1) : {}
    if (typeof v.description === "string" && out.description === undefined) out.description = v.description
    if (alts.some((a) => a.type === "null")) out.nullable = true
    if (out.type === undefined) out.type = "string"
    return out
  }
  const out = {}
  for (const [k, x] of Object.entries(v)) {
    if (KEEP.has(k)) out[k] = x
    else if (k === "exclusiveMinimum" || k === "exclusiveMaximum") {
      // a bound it takes only as inclusive (draft 6 on: a number)
      const bound = "m" + k.slice("exclusiveM".length)
      if (typeof x === "number" && v[bound] === undefined) out[bound] = x
    } else if (k === "type") {
      if (Array.isArray(x)) {
        for (const t of x) {
          if (t === "null") out.nullable = true
          else if (out.type === undefined) out.type = t
        }
      } else out.type = x
    } else if (k === "properties") {
      out.properties = Object.fromEntries(Object.entries(isObject(x) ? x : {}).map(([n, p]) => [n, walk(p, defs, depth + 1)]))
    } else if (k === "items") {
      // a list's one schema (a tuple's members are the first's)
      out.items = walk(Array.isArray(x) ? (x[0] ?? { type: "string" }) : x, defs, depth + 1)
    } else if (k === "enum") {
      // Google takes string enums only
      if (Array.isArray(x) && x.every((e) => typeof e === "string")) out.enum = x
    }
    // anything else (format, default, title, additionalProperties, $schema, examples…) is left out
  }
  if (typeof v.const === "string") out.enum = [v.const]
  if (out.type === undefined) {
    if (out.properties) out.type = "object"
    else if (out.items) out.type = "array"
  }
  // required names only the properties there are
  if (Array.isArray(out.required)) {
    const names = new Set(Object.keys(out.properties ?? {}))
    const keep = out.required.filter((n) => typeof n === "string" && names.has(n))
    if (keep.length) out.required = keep
    else delete out.required
  }
  return out
}
