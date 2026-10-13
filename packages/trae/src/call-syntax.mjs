// Trae: the ways a model writes a tool call into its text — a tagged JSON block, GLM's <arg_key> template,
// DeepSeek's <｜DSML｜> and <parameter> forms — and how each is read into {name, arguments}.
import { looseJSON, repairedJSON } from "./json-repair.mjs"
import { toolDef } from "./tools.mjs"

// a value is its text where the tool's schema says string (or it isn't JSON), else its JSON
function typedValue(raw, asText) {
  if (asText) return raw
  try {
    return JSON.parse(raw.trim())
  } catch {
    return raw
  }
}

// the properties the named tool's schema gives its parameters (a tool given flat, without the "function"
// wrapper, has none here, as it never had: that is what the schema's "string" test is read from)
function propsOf(tools, name) {
  return (tools.find((t) => toolDef(t)?.name === name)?.function ?? {}).parameters?.properties ?? {}
}

// callArgs is a tagged block's arguments as JSON: under arguments (an
// object, or a string of one), input or parameters, else the block's other
// keys, as a model that writes them beside the name means them (community plugins issue #799: a
// write that went out as {})
export function callArgs(v) {
  let a = v.arguments ?? v.input ?? v.parameters
  if (a === undefined) {
    const { name, type, id, ...rest } = v
    a = rest
  }
  if (typeof a === "string") return a.trim() ? (looseJSON(a) ? JSON.stringify(looseJSON(a)) : a) : "{}"
  return JSON.stringify(a ?? {})
}

// callJSON is a block's call ({name, …}) as a model may get its JSON
// wrong, null when it isn't one even so
export function callJSON(s) {
  const v = repairedJSON(s)
  return v && typeof v.name === "string" && v.name ? v : null
}

// ---- <parameter name="k">v</parameter> ----

// DeepSeek's half-and-half call: {"name":"x"} (or its brace or > left
// out), then <parameter name="k">v</parameter> or Qwen's <parameter=k>
export const PARAM_HEAD = /^\s*\{\s*"name"\s*:\s*"([^"]+)"\s*\}?\s*>?\s*(?=<parameter\b)/
const PARAM_OPEN = /<parameter(?:\s+name\s*=\s*"([^"]+)"|=([^\s>]+))\s*>/g

// paramArgs reads <parameter name="k">v</parameter> (or <parameter=k>)
// arguments; a value runs to its close, the next parameter or the end. A
// value is its text where the tool's schema says string (or it isn't
// JSON), else its JSON. closed says each one had its close.
export function paramArgs(s, name, tools = []) {
  const props = propsOf(tools, name)
  const opens = [...s.matchAll(PARAM_OPEN)]
  const args = {}
  let closed = opens.length > 0
  opens.forEach((m, k) => {
    const from = m.index + m[0].length
    const to = k + 1 < opens.length ? opens[k + 1].index : s.length
    let v = s.slice(from, to)
    const c = v.indexOf("</parameter>")
    if (c >= 0) v = v.slice(0, c)
    else closed = false
    v = v.replace(/^\r?\n|\r?\n$/g, "")
    const key = m[1] ?? m[2]
    args[key] = typedValue(v, props[key]?.type === "string")
  })
  return { args, closed }
}

// ---- GLM's template ----

// GLM's call template: the tool's name, then each argument as
// <arg_key>k</arg_key><arg_value>v</arg_value>
const GLM_ARG = /<arg_key>\s*([\s\S]*?)\s*<\/arg_key>\s*<arg_value>([\s\S]*?)<\/arg_value>/g

// glmCall is a call GLM wrote in its template ({name, arguments}), null
// when s isn't one. A value is its text where the tool's schema says
// string (or the text isn't JSON), else its JSON, as GLM's template writes
// a value that isn't a string. A name alone is a call only to a tool the
// request has.
export function glmCall(s, tools = []) {
  s = String(s ?? "").replace(/<\/tool_?call>\s*$/, "")
  const k = s.indexOf("<arg_key>")
  const name = (k < 0 ? s : s.slice(0, k)).trim()
  if (!/^[\w.:-]{1,128}$/.test(name)) return null
  if (k < 0 && !tools.some((t) => toolDef(t)?.name === name)) return null
  const props = propsOf(tools, name)
  const args = {}
  for (const m of s.matchAll(GLM_ARG)) args[m[1]] = typedValue(m[2], props[m[1]]?.type === "string")
  if (k >= 0 && !Object.keys(args).length) return null
  return { name, arguments: args }
}

// ---- DeepSeek's DSML ----

// DeepSeek's tags, with its full-width bar or a plain one
const DSML = String.raw`<\s*\/?\s*[|｜][\s|｜]*DSML[\s|｜]*`
export const DSML_AT = new RegExp(DSML)
export const DSML_TAG = new RegExp("^" + DSML + "[^<>]*>")
export const DSML_INVOKE = new RegExp(String.raw`^<\s*[|｜][\s|｜]*DSML[\s|｜]*invoke\s+name\s*=\s*"([^"]+)"\s*>`)
export const DSML_INVOKE_AT = new RegExp(String.raw`<\s*[|｜][\s|｜]*DSML[\s|｜]*invoke\s+name\s*=`)
export const DSML_CLOSE = new RegExp(String.raw`<\s*\/\s*[|｜][\s|｜]*DSML[\s|｜]*invoke\s*>`)
const DSML_PARAM = new RegExp(String.raw`<\s*[|｜][\s|｜]*DSML[\s|｜]*parameter\s+name\s*=\s*"([^"]+)"((?:\s+\w+\s*=\s*"[^"]*")*)\s*>([\s\S]*?)` + DSML + String.raw`parameter\s*>`, "g")
// what is left after a call: blanks, our close, DeepSeek's tags but the
// next call's
export const LEFTOVER = new RegExp(String.raw`^(?:\s+|<\/tool_?calls?>|<tool_?calls>|` + DSML + String.raw`(?![\s|｜]*invoke\b)[^<>]*>)+`)

// dsmlArgs is the arguments of a DSML invoke as JSON: a parameter marked
// string="true" is its text, any other its JSON (its text when not JSON)
export function dsmlArgs(body) {
  const args = {}
  for (const p of body.matchAll(DSML_PARAM)) args[p[1]] = typedValue(p[3], /string\s*=\s*"true"/.test(p[2]))
  return JSON.stringify(args)
}
