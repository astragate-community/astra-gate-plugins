// The one regular expression every word and pattern becomes, and masking with it.

// A hook runs several times a request (onRequest, then onEvent for every chunk) with the same options, so the
// compiled expression is kept until the options' words or patterns change. A const holder: no module-level `let`.
const cache = { key: undefined, re: null }

/** One case-insensitive expression for every word (matched literally) and pattern; null for none. */
export function matcher(options) {
  if (!options || typeof options !== "object") return null
  const key = JSON.stringify([options.words, options.patterns])
  if (cache.key === key) return cache.re
  const parts = []
  for (const word of Array.isArray(options.words) ? options.words : []) {
    if (typeof word === "string" && word.trim()) parts.push(word.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
  }
  // a pattern is wrapped so its own `|` stays inside it; a bad one throws here, and the gateway logs the hook
  for (const pattern of Array.isArray(options.patterns) ? options.patterns : []) {
    if (typeof pattern === "string" && pattern) parts.push("(?:" + pattern + ")")
  }
  const re = parts.length ? new RegExp(parts.join("|"), "gi") : null
  cache.key = key
  cache.re = re
  return re
}

/** What a match is swapped for: the "mask" option, `***` unless it is a string. */
export const maskOf = (options) => (typeof options.mask === "string" ? options.mask : "***")

/** `text` with every match masked. The expression is global and shared, so its position is reset first. */
export function maskText(re, text, mask) {
  re.lastIndex = 0
  return text.replace(re, mask)
}
