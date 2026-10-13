// Small readers the other modules share.

/** The first of the values that is a non-blank string, trimmed; "" when there is none. */
export const firstOf = (...vs) => vs.find((v) => typeof v === "string" && v.trim())?.trim() ?? ""

/** text as JSON, or null */
export const safeJson = (text) => {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/** Why a thrown value failed, as text. */
export const messageOf = (e) => e?.message ?? String(e)
