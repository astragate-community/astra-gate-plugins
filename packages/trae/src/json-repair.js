// Trae: reading the JSON a model writes into its text, as models get it wrong.

// objectEnd is where the JSON object starting at from (after blanks) ends:
// past its closing brace, -1 when it isn't whole yet, -2 when there's none
export function objectEnd(s, from) {
  let k = from
  while (k < s.length && /\s/.test(s[k])) k++
  if (k >= s.length) return -1
  if (s[k] !== "{") return -2
  let depth = 0
  let str = false
  let esc = false
  for (; k < s.length; k++) {
    const ch = s[k]
    if (str) {
      if (esc) esc = false
      else if (ch === "\\") esc = true
      else if (ch === '"') str = false
      continue
    }
    if (ch === '"') str = true
    else if (ch === "{") depth++
    else if (ch === "}" && --depth === 0) return k + 1
  }
  return -1
}

// escapeRaw escapes the control characters inside JSON strings
export function escapeRaw(s) {
  let out = ""
  let str = false
  let esc = false
  for (const ch of String(s ?? "")) {
    if (str && !esc && ch < " ") {
      out += ch === "\n" ? "\\n" : ch === "\r" ? "\\r" : ch === "\t" ? "\\t" : "\\u" + ch.charCodeAt(0).toString(16).padStart(4, "0")
      continue
    }
    if (str && ch === "\\" && !esc) esc = true
    else {
      if (ch === '"' && !esc) str = !str
      esc = false
    }
    out += ch
  }
  return out
}

// looseJSON reads a JSON object as a model writes one: a string holding a
// raw newline or tab (a file's content written out, community plugins issue #799) is read as if
// they were escaped. null when it isn't one even so.
export function looseJSON(s) {
  for (const t of [s, escapeRaw(s)]) {
    try {
      const v = JSON.parse(t)
      if (v && typeof v === "object" && !Array.isArray(v)) return v
    } catch {}
  }
  return null
}

// fixEscapes makes a backslash that escapes nothing JSON knows a backslash
// of its own (\' is the quote it meant)
function fixEscapes(s) {
  return s.replace(/\\(u[0-9a-fA-F]{4}|["\\/bfnrt])|\\'|\\/g, (m, ok) => (ok ? m : m === "\\'" ? "'" : "\\\\"))
}

// quoteFix escapes the quotes inside strings a model left unescaped: a
// quote ends a key only before its colon, and a value only before what
// may follow the last of one (closing braces or brackets, then the end or
// a comma and the next key or value)
function quoteFix(s) {
  let out = ""
  const stack = []
  let key = false
  for (let i = 0; i < s.length; ) {
    const ch = s[i]
    if (ch !== '"') {
      if (ch === "{") {
        stack.push("{")
        key = true
      } else if (ch === "[") stack.push("[")
      else if (ch === "}" || ch === "]") stack.pop()
      else if (ch === ",") key = stack.at(-1) === "{"
      else if (ch === ":") key = false
      out += ch
      i++
      continue
    }
    const isKey = key && stack.at(-1) === "{"
    const inArray = stack.at(-1) === "["
    out += ch
    i++
    for (; i < s.length; i++) {
      const c = s[i]
      if (c === "\\") {
        out += c + (s[i + 1] ?? "")
        i++
        continue
      }
      if (c !== '"') {
        out += c
        continue
      }
      const after = s.slice(i + 1)
      const ends = isKey ? /^\s*:/.test(after) : (inArray ? /^\s*(?:[}\]]\s*)*(?:$|,\s*["{[\d\-tfn])/ : /^\s*(?:[}\]]\s*)*(?:$|,\s*")/).test(after)
      if (ends) {
        out += c
        i++
        break
      }
      out += '\\"'
    }
    key = false
  }
  return out
}

// repairedJSON reads a JSON object as looseJSON does, and else as models
// get it wrong (community plugins issue #38): every quote escaped ({\"name\":…}), a
// backslash that escapes nothing JSON knows (\_ \| C:\Users in a file's
// content), or quotes inside a string left unescaped ("官方" in a write's
// content)
export function repairedJSON(s) {
  const v = looseJSON(s)
  if (v) return v
  const t = escapeRaw(s)
  const tries = []
  if (/^\s*\{\s*\\"/.test(s)) {
    try {
      const u = JSON.parse('"' + s.trim().replace(/[\n\r\t]/g, (c) => (c === "\n" ? "\\n" : c === "\r" ? "\\r" : "\\t")) + '"')
      tries.push(u, escapeRaw(u))
    } catch {}
    tries.push(s.replace(/\\"/g, '"'))
  }
  tries.push(fixEscapes(t), quoteFix(fixEscapes(t)))
  for (const x of tries) {
    try {
      const v = JSON.parse(x)
      if (v && typeof v === "object" && !Array.isArray(v)) return v
    } catch {}
  }
  return null
}
