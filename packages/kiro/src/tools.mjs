// Kiro: tool ids and names as Kiro takes them.
import { createHash } from "node:crypto"

const TOOL_ID = /^[a-zA-Z0-9_.:-]{1,64}$/

// toolID is a tool call's id as Kiro takes one: another vendor's becomes
// one of Kiro's own, the same each time.
export const toolID = (id) => (TOOL_ID.test(id ?? "") ? id : "t_" + createHash("sha256").update(String(id ?? "")).digest("base64url").slice(0, 32))

// Kiro answers a tool named past 64 characters, or outside these, "Invalid
// tool use format." and won't raise the limit (kirodotdev/Kiro#7684), while
// MCP tools in Claude Code are named mcp__plugin_<plugin>_<server>__<tool>
// (yetone/magpie#1393).
const TOOL_NAME = /^[a-zA-Z0-9_-]{1,64}$/

// toolName is a tool's name as Kiro takes one: another is its head with a
// hash of the whole name, the same each time, so the conversation's later
// turns name it the same way. toolNames maps each such name back.
export const toolName = (name) => {
  const n = String(name ?? "")
  if (TOOL_NAME.test(n)) return n
  const hash = createHash("sha256").update(n).digest("hex").slice(0, 12)
  return n.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64 - 1 - hash.length) + "_" + hash
}

// toolNames is the name the caller knows for each tool a request names
// that Kiro is sent under another name.
export function toolNames(req) {
  const names = new Map()
  const add = (n) => {
    if (typeof n !== "string" || !n) return
    const k = toolName(n)
    if (k !== n) names.set(k, n)
  }
  for (const t of req.tools ?? []) add(t?.name)
  for (const m of req.messages ?? []) if (Array.isArray(m.content)) for (const p of m.content) if (p?.type === "tool_use") add(p.name)
  return names
}
