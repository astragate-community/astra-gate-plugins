// The one regular expression every word and pattern becomes, and masking with it.

// A hook runs several times a request (onRequest, then onEvent for every chunk) with the same settings, so the
// compiled expression is kept until the settings' words or patterns change. A const holder: no module-level `let`.
const cache = { key: undefined, re: null }

/** One case-insensitive expression for every word (matched literally) and pattern; null for none. */
export function matcher(settings) {
  if (!settings || typeof settings !== "object") return null
  const key = JSON.stringify([settings.words, settings.patterns])
  if (cache.key === key) return cache.re
  const parts = []
  for (const word of Array.isArray(settings.words) ? settings.words : []) {
    if (typeof word === "string" && word.trim()) parts.push(word.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
  }
  // a pattern is wrapped so its own `|` stays inside it; a bad one throws here, and the gateway logs the hook
  for (const pattern of Array.isArray(settings.patterns) ? settings.patterns : []) {
    if (typeof pattern === "string" && pattern) parts.push("(?:" + pattern + ")")
  }
  const re = parts.length ? new RegExp(parts.join("|"), "gi") : null
  cache.key = key
  cache.re = re
  return re
}

/** What a match is swapped for: the "mask" setting, `***` unless it is a string. */
export const maskOf = (settings) => (typeof settings.mask === "string" ? settings.mask : "***")

/** `text` with every match masked. The expression is global and shared, so its position is reset first. */
export function maskText(re, text, mask) {
  re.lastIndex = 0
  return text.replace(re, mask)
}
