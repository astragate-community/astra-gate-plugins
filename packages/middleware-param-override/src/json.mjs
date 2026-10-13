// JSON values: what "an object" means here, and copying one.

/** A plain object: not null, not an array. */
export function isObj(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v)
}

/** A deep copy of a JSON value, so a configured value is never shared between requests (or fields). */
export function clone(v) {
  return v === undefined || v === null || typeof v !== "object" ? v : JSON.parse(JSON.stringify(v))
}
