// Which tool name a reply's call is allowed to carry: one the agent declared, or the one declared name it is a
// case / separator variant of.
import { GuardError } from "./guard-core.mjs"

// OpenCode's own models call OpenCode's tool names (bash, todowrite,
// webfetch) whatever the agent declared. A call is given the agent's tool
// whose name differs only in case, or else only in case and separators
// (todowrite → todo_write, webfetch → web_fetch), when exactly one does; a
// name two of the agent's tools fold to is never guessed between.
const separators = /[\s_.-]/g
function foldsTo(declared, key) {
  const folded = new Map()
  for (const name of declared) {
    const k = key(name)
    folded.set(k, folded.has(k) ? null : name)
  }
  return folded
}

/** A function that maps a called name to the declared one, or throws a GuardError for an undeclared tool. */
export function nameGuard(policy) {
  const declared = new Set(policy.declared)
  const lower = (name) => name.toLowerCase()
  const bare = (name) => name.toLowerCase().replace(separators, "")
  const byCase = foldsTo(declared, lower)
  const byShape = foldsTo(declared, bare)
  return (name) => {
    if (typeof name !== "string" || !name) throw new GuardError("Missing upstream tool name")
    if (declared.has(name)) return name
    const match = byCase.get(lower(name)) ?? (byCase.has(lower(name)) ? null : byShape.get(bare(name)))
    if (match) return match
    throw new GuardError(`Upstream called a tool not declared by the client: ${JSON.stringify(name.slice(0, 128))}`)
  }
}
