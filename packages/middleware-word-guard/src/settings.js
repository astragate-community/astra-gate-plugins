// The settings and the migration of a v1 copy's options.

const list = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === "string" && x.trim()).map((x) => x.trim()) : [])

/** A stored value cleaned up into settings: unknown or mistyped fields fall back to the defaults. */
export function normalize(raw) {
  const r = raw && typeof raw === "object" ? raw : {}
  return {
    words: list(r.words),
    // a pattern keeps its spaces: only an empty one is dropped
    patterns: Array.isArray(r.patterns) ? r.patterns.filter((p) => typeof p === "string" && p) : [],
    action: r.action === "mask" ? "mask" : "reject",
    check: r.check === "all" ? "all" : "last",
    mask: typeof r.mask === "string" ? r.mask : "***",
    replies: r.replies === true,
    message: typeof r.message === "string" ? r.message : "",
  }
}

/** The v1 options ({ words, patterns, action, check, mask, replies, message }) are the settings as they are. */
export const fromV1Options = normalize

/** The first pattern that is not a valid regular expression, or null. */
export function badPattern(patterns) {
  for (const p of patterns) {
    try {
      new RegExp("(?:" + p + ")", "gi")
    } catch {
      return p
    }
  }
  return null
}
