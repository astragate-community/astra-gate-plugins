// The settings and the migration of a v1 copy's options. The settings are { text, config }: the JSON as the user typed it
// (so the editor keeps their layout) and the parsed object the hook runs.

export const EMPTY = { text: "", config: {} }

/** Parses what the editor holds: { config } for a JSON object (empty text is none), { error } for anything else. */
export function parse(text) {
  if (typeof text !== "string" || !text.trim()) return { config: {} }
  let value
  try {
    value = JSON.parse(text)
  } catch (e) {
    return { error: String(e && e.message ? e.message : e) }
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return { error: "object" }
  return { config: value }
}

/** A stored value cleaned up into settings. */
export function normalize(raw) {
  const r = raw && typeof raw === "object" ? raw : {}
  const text = typeof r.text === "string" ? r.text : ""
  const parsed = parse(text)
  return { text, config: parsed.config ?? {} }
}

/** The v1 options (New API's param_override object) as settings. */
export function fromV1Options(options) {
  if (!options || typeof options !== "object" || Array.isArray(options) || Object.keys(options).length === 0) return { ...EMPTY }
  return { text: JSON.stringify(options, null, 2), config: options }
}
