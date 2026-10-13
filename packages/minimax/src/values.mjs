// Reading loosely typed JSON: each returns undefined for what isn't the wanted kind.

/** A non-blank string field, trimmed. */
export const str = (o, k) => (typeof o?.[k] === "string" && o[k].trim() ? o[k].trim() : undefined)
/** A finite positive number field. */
export const pos = (o, k) => (typeof o?.[k] === "number" && Number.isFinite(o[k]) && o[k] > 0 ? o[k] : undefined)
/** A plain object (not an array). */
export const obj = (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : undefined)
/** A finite number, or a numeric string as one. */
export const num = (v) => {
  if (typeof v === "number" && Number.isFinite(v)) return v
  if (typeof v === "string" && v.trim() && Number.isFinite(Number(v))) return Number(v)
  return undefined
}
