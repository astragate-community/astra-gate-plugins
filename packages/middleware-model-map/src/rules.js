// The mapping: compiling rules, and following a name through them. Behaviour is the v1 plugin's, unchanged;
// only the input differs: a list of { from, to } rules (what the settings view stores) instead of the options object.

/** A chain longer than this is a mistake (or a pattern that keeps matching its own output); stop there. */
export const MAX_CHAIN = 16

/** A `from` written /like this/ (flags optional) is a regular expression; null for an exact name. */
export function parsePattern(from) {
  const written = /^\/(.+)\/([a-z]*)$/.exec(from)
  // "g" is dropped: a global regexp's test() remembers lastIndex between calls
  return written ? new RegExp(written[1], written[2].replace("g", "")) : null
}

/**
 * Rules compiled: exact names, and patterns (a `from` written /like this/), in list order. Entries whose
 * `to` isn't a non-empty string are ignored; a later exact rule for the same name wins. A pattern that does
 * not compile is skipped (v1 threw on it and so mapped nothing at all).
 */
export function compileRules(rules) {
  const exact = {}
  const patterns = []
  if (!Array.isArray(rules)) return { exact, patterns }
  for (const rule of rules) {
    if (!rule || typeof rule.from !== "string" || typeof rule.to !== "string" || !rule.from || !rule.to) continue
    let pattern
    try {
      pattern = parsePattern(rule.from)
    } catch {
      continue
    }
    if (pattern) patterns.push([pattern, rule.to])
    else exact[rule.from] = rule.to
  }
  return { exact, patterns }
}

/**
 * The v1 plugin's options -- `{"mapping": {...}}` or New API's flat `{...}`, plus `keep_upstream_name` -- as
 * the rules and the flag the v2 plugin stores. Used once, when Astra upgrades an installed v1 copy.
 */
export function fromV1Options(options) {
  const none = { rules: [], keepUpstreamName: false }
  if (!options || typeof options !== "object") return none
  const mapping = options.mapping && typeof options.mapping === "object" ? options.mapping : options
  const rules = []
  for (const from of Object.keys(mapping)) {
    const to = mapping[from]
    if (typeof to !== "string" || !to || from === "keep_upstream_name") continue
    rules.push({ id: "r" + (rules.length + 1), from, to })
  }
  return { rules, keepUpstreamName: options.keep_upstream_name === true }
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
