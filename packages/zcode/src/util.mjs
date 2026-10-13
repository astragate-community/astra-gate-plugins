// Small value helpers the other modules share.

export const uuid = () => crypto.randomUUID()
export const platform = () => `${process.platform}-${process.arch}` // darwin-arm64, win32-x64, linux-x64, as ZCode names them

/** The first non-blank string of ss, trimmed; "" when there is none. */
export const first = (...ss) => ss.map((s) => (typeof s === "string" ? s.trim() : "")).find((s) => s) ?? ""

export const isNum = (v) => typeof v === "number" && Number.isFinite(v)

/** A number the Start Plan's balance gives as a number or a numeric string (parseFloat, so "12x" is 12). */
export const num = (v) => {
  const n = typeof v === "string" ? parseFloat(v) : v
  return isNum(n) ? n : undefined
}

/** startNum reads a number the balance gives as a number or a string (strictly: "12x" is none). */
export function startNum(v) {
  if (isNum(v)) return v
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v.trim())
    if (!Number.isNaN(n)) return n
  }
  return undefined
}

/** A seat on a team's plan: a state that names its organisation and project. */
export const isTeam = (s) => !!(s.org && s.project)

/** The account's name on a sign-in: its email (a phone sign-in's placeholder domain off), name or id. */
export const who = (u) => first(String(u?.email ?? "").replace(/@phone\.local$/, ""), u?.name, u?.user_id, "ZCode")
