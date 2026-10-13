// The mapping: compiling the options into rules, and following a name through them.

/** A chain longer than this is a mistake (or a pattern that keeps matching its own output); stop there. */
const MAX_CHAIN = 16

/**
 * The options' mappings, compiled: exact names, and patterns (a key written /like this/).
 * `{"mapping": {...}}` and New API's flat `{...}` are both accepted; entries whose target isn't a non-empty
 * string are ignored, so is the sibling option `keep_upstream_name` of the flat form.
 */
export function compileRules(options) {
  if (!options || typeof options !== "object") return { exact: {}, patterns: [] }
  const mapping = options.mapping && typeof options.mapping === "object" ? options.mapping : options
  const exact = {}
  const patterns = []
  for (const key of Object.keys(mapping)) {
    const target = mapping[key]
    if (typeof target !== "string" || !target || key === "keep_upstream_name") continue
    const written = /^\/(.+)\/([a-z]*)$/.exec(key)
    // "g" is dropped: a global regexp's test() remembers lastIndex between calls
    if (written) patterns.push([new RegExp(written[1], written[2].replace("g", "")), target])
    else exact[key] = target
  }
  return { exact, patterns }
}

/** What `name` maps to: exact names first, then patterns in order, followed until nothing (or a repeat) is next. */
export function resolveModel(name, rules) {
  const seen = [name]
  let current = name
  for (let step = 0; step < MAX_CHAIN; step++) {
    const next = mapOnce(current, rules)
    if (next === undefined || next === current || seen.includes(next)) return current
    seen.push(next)
    current = next
  }
  return current
}

// hasOwnProperty, so a model called "constructor" or "toString" doesn't map to Object.prototype's members
function mapOnce(name, rules) {
  if (Object.prototype.hasOwnProperty.call(rules.exact, name)) return rules.exact[name]
  for (const [pattern, target] of rules.patterns) {
    if (pattern.test(name)) return name.replace(pattern, target)
  }
}
