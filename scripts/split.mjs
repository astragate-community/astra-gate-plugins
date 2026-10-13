// Splits a single-file plugin into modules by top-level declaration, the mechanical half of a refactor:
//   node scripts/split.mjs <legacy.mjs> <plan.json> <outDir>
// plan.json: { "modules": { "<module>": { "about": "…", "names": ["declaredName", …] } },
//              "kit": ["name", …],     // declared here but replaced by the plugin kit's (the declaration is dropped)
//              "drop": ["name", …],   // declarations dropped outright
//              "provided": { "name": "module" } }  // dropped here, written by hand in that module (imports point at it)
// Every top-level name must be placed, kit or dropped. Imports and `export`s are worked out from which module
// uses which name, then unused imports are pruned with eslint. Comments stay with the declaration they precede.
// Mutable module state (a top-level `let`) is refused: it cannot be shared across modules.
import * as acorn from "acorn"
import { execFileSync } from "node:child_process"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const [legacy, planFile, outDir] = process.argv.slice(2)
const src = readFileSync(legacy, "utf8")
const plan = JSON.parse(readFileSync(planFile, "utf8"))
const ast = acorn.parse(src, { ecmaVersion: "latest", sourceType: "module" })

const declared = (node) => {
  const d = node.type === "ExportNamedDeclaration" ? node.declaration : node
  if (!d) return []
  if (d.type === "FunctionDeclaration" || d.type === "ClassDeclaration") return [d.id.name]
  if (d.type === "VariableDeclaration") {
    if (d.kind === "let" || d.kind === "var") throw new Error(`top-level ${d.kind} (mutable module state) can't be split: ${src.slice(d.start, d.start + 60)}`)
    return d.declarations.map((x) => {
      if (x.id.type !== "Identifier") throw new Error("destructuring at top level: " + src.slice(d.start, d.start + 60))
      return x.id.name
    })
  }
  return []
}

// the node imports available, by local name
const nodeImports = new Map()
for (const n of ast.body) {
  if (n.type !== "ImportDeclaration") continue
  for (const s of n.specifiers) nodeImports.set(s.local.name, { from: n.source.value, imported: s.type === "ImportSpecifier" ? s.imported.name : s.type === "ImportDefaultSpecifier" ? "default" : "*" })
}

const placed = new Map() // name → module
for (const [m, { names }] of Object.entries(plan.modules)) for (const n of names) placed.set(n, m)
const kit = new Set(plan.kit ?? [])
const drop = new Set([...(plan.drop ?? []), ...Object.keys(plan.provided ?? {})])
for (const [n, m] of Object.entries(plan.provided ?? {})) placed.set(n, m)

// chunks: each declaration with the comments and blank lines before it
const chunks = []
let prev = 0
for (const n of ast.body) {
  if (n.type === "ImportDeclaration") {
    prev = n.end
    continue
  }
  const names = declared(n)
  chunks.push({ names, start: n.start - prev, text: src.slice(prev, n.end), node: n })
  prev = n.end
}
const tail = src.slice(prev).trim()

const unplaced = chunks.flatMap((c) => c.names).filter((n) => !placed.has(n) && !kit.has(n) && !drop.has(n))
if (unplaced.length) throw new Error("not placed: " + unplaced.join(", "))

const modules = {}
for (const [m, { about }] of Object.entries(plan.modules)) modules[m] = { about, chunks: [] }
for (const c of chunks) {
  if (c.names.length === 0) throw new Error("a top-level statement that declares nothing: " + c.text.trim().slice(0, 80))
  const targets = new Set(c.names.map((n) => (kit.has(n) || drop.has(n) ? null : placed.get(n))))
  if (targets.size > 1) throw new Error("one statement's names go to different modules: " + c.names.join(", "))
  const [t] = targets
  if (t) modules[t].chunks.push(c)
}

const identifiersIn = (text) => {
  const found = new Set()
  const walk = (n) => {
    if (!n || typeof n.type !== "string") return
    if (n.type === "Identifier") found.add(n.name)
    for (const k of Object.keys(n)) {
      const v = n[k]
      if (Array.isArray(v)) v.forEach(walk)
      else if (v && typeof v.type === "string") walk(v)
    }
  }
  walk(acorn.parse(text, { ecmaVersion: "latest", sourceType: "module" }))
  return found
}

const exported = new Set(Object.keys(plan.provided ?? {}))
const used = {}
for (const [m, mod] of Object.entries(modules)) {
  const body = mod.chunks.map((c) => c.text).join("")
  used[m] = identifiersIn(body)
  const own = new Set(mod.chunks.flatMap((c) => c.names))
  for (const id of used[m]) if (placed.has(id) && !own.has(id) && placed.get(id) !== m) exported.add(id)
}

mkdirSync(outDir, { recursive: true })
for (const [m, mod] of Object.entries(modules)) {
  const own = new Set(mod.chunks.flatMap((c) => c.names))
  const parts = mod.chunks.map((c) => {
    if (!c.names.some((n) => exported.has(n))) return c.text
    const at = c.start
    return c.text.slice(0, at) + "export " + c.text.slice(at)
  })
  const imports = []
  const byFrom = new Map()
  const add = (from, spec) => byFrom.set(from, [...(byFrom.get(from) ?? []), spec])
  for (const id of used[m]) {
    if (own.has(id)) continue
    if (nodeImports.has(id)) {
      const i = nodeImports.get(id)
      add(i.from, i.imported === id ? id : `${i.imported} as ${id}`)
    } else if (kit.has(id)) add("@astragate-community/plugin-kit", id)
    else if (placed.has(id) && placed.get(id) !== m) add("./" + placed.get(id) + ".mjs", id)
  }
  for (const [from, specs] of byFrom) imports.push(`import { ${[...new Set(specs)].sort().join(", ")} } from "${from}"`)
  const head = `// ${mod.about}\n` + (imports.length ? imports.join("\n") + "\n" : "")
  writeFileSync(join(outDir, m + ".mjs"), head + parts.join("").replace(/^\n+/, "\n"))
}
if (tail) console.log("note: trailing text not placed:\n" + tail)
console.log("split into", Object.keys(modules).join(", "))
console.log("exports:", [...exported].sort().join(" "))

// prune imports eslint finds unused (a name some local variable shadowed), until clean
for (let round = 0; round < 5; round++) {
  let out
  try {
    out = execFileSync("npx", ["eslint", "--format", "json", outDir], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
  } catch (e) {
    out = e.stdout ?? "[]"
  }
  let pruned = 0
  for (const f of JSON.parse(out)) {
    const unusedNames = f.messages.filter((x) => x.ruleId === "no-unused-vars").map((x) => /'([^']+)'/.exec(x.message)?.[1]).filter(Boolean)
    if (!unusedNames.length) continue
    let text = readFileSync(f.filePath, "utf8")
    const lines = text.split("\n")
    for (let i = 0; i < lines.length; i++) {
      const mm = /^import \{ (.*) \} from (".*")$/.exec(lines[i])
      if (!mm) continue
      const keep = mm[1].split(", ").filter((s) => !unusedNames.includes(s.split(" as ").pop()))
      if (keep.length !== mm[1].split(", ").length) {
        pruned++
        lines[i] = keep.length ? `import { ${keep.join(", ")} } from ${mm[2]}` : null
      }
    }
    writeFileSync(f.filePath, lines.filter((l) => l !== null).join("\n"))
  }
  if (!pruned) break
}
