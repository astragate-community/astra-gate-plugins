// Reading the amounts and times Command Code's account replies give, and writing dollars as magpie does

// number reads an amount given as a JSON number or as a string of one.
export function number(v) {
  if (typeof v === "number") return v
  if (typeof v !== "string" || !v.trim()) return undefined
  const n = Number(v.trim())
  return Number.isNaN(n) ? undefined : n
}

const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/

// when reads a reset time: unix seconds or milliseconds, or RFC 3339; an
// ISO time, undefined when there is none.
export function when(v) {
  if (typeof v === "string" && RFC3339.test(v) && !Number.isNaN(Date.parse(v))) return new Date(v).toISOString()
  let n = number(v)
  if (n === undefined || !(n > 0)) return undefined
  if (n < 1e12) n *= 1000
  const d = new Date(Math.trunc(n))
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString()
}

// money is dollars to the cent, a half cent to the even one, as magpie
// writes them.
export function money(v) {
  const exact = Math.abs(v).toFixed(20)
  const tie = /\.\d\d50*$/.test(exact)
  const s = tie && Number(exact[exact.indexOf(".") + 2]) % 2 === 0 ? exact.slice(0, exact.indexOf(".") + 3) : Math.abs(v).toFixed(2)
  return "$" + (v < 0 ? "-" : "") + s
}
