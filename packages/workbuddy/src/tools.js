// WorkBuddy: fitting the chat's tools to what WorkBuddy takes (names, schemas).

// ---- tools WorkBuddy takes ----------------------------------------------------

// WorkBuddy AI answers 400 code 11133 "Invalid request parameters" (the
// model provider rejected them) to a chat whose tools it can't pass on to
// the model (wyh on magpie's Discord: ZCode and DeepSeek Harness on
// deepseek-v4.1-flash). Tried on the owner's account, 2026-10-08: DeepSeek
// turns away each of the shapes below, and Kimi, GPT, Gemini and GLM some
// of them; MiniMax none. fitTools gives each a shape every model takes.
// A tool's name may hold letters, digits, _ and -; another character
// (". : / space", CJK) is refused.
const NAME_OK = /^[A-Za-z0-9_-]+$/

// safeName is name with each character WorkBuddy refuses as _, kept apart
// from the names in taken.
function safeName(name, taken) {
  const base = String(name).replace(/[^A-Za-z0-9_-]/g, "_") || "tool"
  let n = base
  for (let i = 2; taken.has(n); i++) n = `${base}_${i}`
  taken.add(n)
  return n
}

// NUL_ESCAPE finds a regex's \0 (the NUL character), stepping over each \\
// (a backslash) so that a \\0 is left; \01 is an octal escape, also left.
const NUL_ESCAPE = /\\\\|\\0(?![0-9])/g

// fitSchema mends a schema in place, at every depth: a pattern's \0, which
// DeepSeek's validator says is "not a 'regex'", is \u0000, which matches
// the same (magpie's gateway does this for DeepSeek's own API,
// deepseekToolPatterns); a tuple's items (a list) become one schema any of
// them fits. It reports whether it changed anything.
function fitSchema(s, depth = 0) {
  if (!s || typeof s !== "object" || depth > 64) return false
  let changed = false
  if (Array.isArray(s)) {
    for (const v of s) if (fitSchema(v, depth + 1)) changed = true
    return changed
  }
  if (typeof s.pattern === "string" && s.pattern.includes("\\0")) {
    const p = s.pattern.replace(NUL_ESCAPE, (m) => (m === "\\\\" ? m : "\\u0000"))
    if (p !== s.pattern) {
      s.pattern = p
      changed = true
    }
  }
  if (Array.isArray(s.items)) {
    const list = s.items.filter((v) => v && typeof v === "object")
    s.items = list.length === 0 ? {} : list.length === 1 ? list[0] : { anyOf: list }
    delete s.additionalItems
    changed = true
  }
  for (const v of Object.values(s)) if (fitSchema(v, depth + 1)) changed = true
  return changed
}

// localRef is the schema a local $ref in root names ("#/$defs/x",
// "#/definitions/x"), or s itself.
function localRef(root, s) {
  const ref = s?.$ref
  if (typeof ref !== "string" || !ref.startsWith("#/")) return s
  let at = root
  for (const k of ref.slice(2).split("/")) at = at?.[k.replaceAll("~1", "/").replaceAll("~0", "~")]
  return at && typeof at === "object" ? at : s
}

// objectRoot makes a tool's parameters an object at the root, as magpie's
// gateway does for xAI (provider.ObjectRoot): allOf's branches are merged
// whole; of anyOf's and oneOf's object branches the properties are merged
// and a field each requires stays required. A root with no type, or an
// empty one, is an object. It reports whether it changed anything.
function objectRoot(ps, root = ps, depth = 0) {
  const unions = ["allOf", "anyOf", "oneOf"].filter((k) => Array.isArray(ps[k]))
  if (ps.type === "object" && !unions.length) return false
  const props = ps.properties && typeof ps.properties === "object" ? ps.properties : {}
  const required = Array.isArray(ps.required) ? [...ps.required] : []
  for (const b0 of ps.allOf ?? []) {
    let b = localRef(root, b0)
    if (!b || typeof b !== "object") continue
    if (depth < 8 && ["allOf", "anyOf", "oneOf"].some((k) => Array.isArray(b[k]))) objectRoot((b = structuredClone(b)), root, depth + 1)
    for (const [k, v] of Object.entries(b.properties ?? {})) if (!(k in props)) props[k] = v
    if (Array.isArray(b.required)) required.push(...b.required)
  }
  const branches = []
  for (const key of ["anyOf", "oneOf"]) {
    for (const b0 of ps[key] ?? []) {
      let b = localRef(root, b0)
      if (!b || typeof b !== "object") continue
      if (depth < 8 && ["allOf", "anyOf", "oneOf"].some((k) => Array.isArray(b[k]))) objectRoot((b = structuredClone(b)), root, depth + 1)
      if (b.type !== "object" && !b.properties) continue
      branches.push(b)
    }
  }
  const from = new Map()
  for (const b of branches) {
    for (const [k, v] of Object.entries(b.properties ?? {})) {
      if (k in props) continue
      const seen = from.get(k) ?? []
      if (!seen.some((x) => JSON.stringify(x) === JSON.stringify(v))) seen.push(v)
      from.set(k, seen)
    }
  }
  for (const [k, list] of from) props[k] = list.length === 1 ? list[0] : { anyOf: list }
  if (branches.length) {
    for (const k of Object.keys(branches[0].properties ?? {})) {
      if (branches.every((b) => Array.isArray(b.required) && b.required.includes(k))) required.push(k)
    }
  }
  for (const k of unions) delete ps[k]
  ps.type = "object"
  ps.properties = props
  const req = [...new Set(required)].filter((k) => typeof k === "string" && k in props)
  if (req.length) ps.required = req
  else delete ps.required
  return true
}

// fitTools mends b's function tools in place: their parameters (fitSchema,
// objectRoot) and names. It reports whether it changed anything, and the
// names it gave, each to the name the client knows (ours), so that the
// model's calls are named back. A call in the chat's history is named as
// its tool now is.
function fitTools(b) {
  const names = new Map()
  if (!Array.isArray(b?.tools) || !b.tools.length) return { changed: false, names }
  let changed = false
  const taken = new Set()
  for (const t of b.tools) {
    const n = t?.function?.name
    if (typeof n === "string" && NAME_OK.test(n)) taken.add(n)
  }
  const theirs = new Map()
  for (const t of b.tools) {
    const fn = t?.type === "function" || t?.function ? t.function : null
    if (!fn || typeof fn !== "object") continue
    if (typeof fn.name === "string" && !NAME_OK.test(fn.name)) {
      const safe = safeName(fn.name, taken)
      names.set(safe, fn.name)
      theirs.set(fn.name, safe)
      fn.name = safe
      changed = true
    }
    if (fn.parameters === undefined) continue
    if (!fn.parameters || typeof fn.parameters !== "object" || Array.isArray(fn.parameters)) {
      fn.parameters = { type: "object", properties: {} }
      changed = true
      continue
    }
    if (fitSchema(fn.parameters)) changed = true
    if (objectRoot(fn.parameters)) changed = true
  }
  if (theirs.size && Array.isArray(b.messages)) {
    for (const m of b.messages) {
      for (const c of Array.isArray(m?.tool_calls) ? m.tool_calls : []) {
        const safe = theirs.get(c?.function?.name)
        if (safe) c.function.name = safe
      }
      if (m?.role === "tool" && theirs.has(m.name)) m.name = theirs.get(m.name)
    }
  }
  const choice = b.tool_choice?.function
  if (choice && theirs.has(choice.name)) choice.name = theirs.get(choice.name)
  return { changed, names }
}

// fitted mends a chat body's tools (fitTools) in place, and gives the names it made safe, each to the client's own.
// WorkBuddy's reply cannot be renamed back here (a v2 provider plugin does not see the reply), so a model that calls
// a mended tool names it by the mended name.
export function fitted(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { body, names: new Map() };
  const { names } = fitTools(body);
  return { body, names };
}
