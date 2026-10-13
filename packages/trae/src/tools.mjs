// Trae: the request's tools — told to the model (natively and in a system prompt) and matched with the calls it makes.
import { CLOSE, OPEN } from "./constants.mjs"
import { looseJSON } from "./json-repair.mjs"

// a tool as the request names it: OpenAI's {type, function}, or the function alone
export const toolDef = (t) => t.function ?? t

export function toolPrompt(tools, choice, parallel) {
  const defs = tools.map((t) => {
    const f = toolDef(t)
    return { name: f.name, description: f.description ?? "", parameters: f.parameters ?? {} }
  })
  const lines = [
    "You can call the client's tools, listed below as JSON. They run on the user's machine, not on yours: use no built-in or server tool to reach the user's files.",
    `To call a tool, write one block per call and nothing after it: ${OPEN}{"name":"tool_name","arguments":{...}}${CLOSE}. Use an exact tool name and fill arguments from its schema. Then stop and wait: the result comes back in the next message.`,
    "A call is not done until its result comes back; don't say it is, and don't repeat a call whose result you have.",
  ]
  if (parallel === false) lines.push("Call at most one tool at a time.")
  if (choice === "required") lines.push("Call a tool before answering.")
  else if (choice && typeof choice === "object" && (choice.function?.name || choice.name)) lines.push(`Call the tool ${choice.function?.name || choice.name} before answering.`)
  lines.push("Tools:", JSON.stringify(defs))
  return lines.join("\n")
}

// nativeTools are the tools as Trae names them: parameters a JSON string
export const nativeTools = (tools) =>
  tools.map((t) => {
    const f = toolDef(t)
    return { type: "function", function: { name: f.name, description: f.description ?? "", parameters: typeof f.parameters === "string" ? f.parameters : JSON.stringify(f.parameters ?? {}) } }
  })

// toolNamed is the request's own name for a tool a model named otherwise
// (Read for read, list-files for list_files); name itself when the request
// has none like it. A tool it has none of goes on as named: the agent tells
// the model there's no such tool, which it can act on, where a call
// dropped here would end the turn with nothing.
export function toolNamed(name, tools) {
  const names = tools.map((t) => toolDef(t)?.name).filter(Boolean)
  if (!names.length || names.includes(name)) return name
  const norm = (n) => String(n).toLowerCase().replace(/[^a-z0-9]/g, "")
  return names.find((n) => norm(n) === norm(name)) ?? name
}

// unwrapped is a call's arguments with the layer a model put around them
// taken off: asked for {"name":…,"arguments":{…}}, some write the
// arguments as {"arguments":{…}} again, natively or in the block, and the
// agent got {"arguments":{"content":…,"path":…}} for its write (bee2an on
// X). A lone arguments, input, parameters or args key holding an object is
// that layer when the tool has no parameter of that name.
const WRAPS = ["arguments", "input", "parameters", "args"]
export function unwrapped(args, name, tools) {
  const t = tools.map(toolDef).find((f) => f?.name === name)
  if (!t) return args
  const props = t.parameters?.properties ?? {}
  let v = looseJSON(args)
  let changed = false
  for (let k = 0; k < 3 && v && typeof v === "object" && !Array.isArray(v); k++) {
    const keys = Object.keys(v)
    if (keys.length !== 1 || !WRAPS.includes(keys[0]) || keys[0] in props) break
    let inner = v[keys[0]]
    if (typeof inner === "string") inner = looseJSON(inner)
    if (!inner || typeof inner !== "object" || Array.isArray(inner)) break
    v = inner
    changed = true
  }
  return changed ? JSON.stringify(v) : args
}
