/** JSON.parse that answers undefined for text that isn't JSON. */
export const parse = (s) => {
  try {
    return JSON.parse(s)
  } catch {
    return undefined
  }
}

/** A request body (string, bytes or a stream) as text. */
export async function bodyText(body) {
  if (body == null) return ""
  if (typeof body === "string") return body
  if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) return Buffer.from(body).toString("utf8")
  return await new Response(body).text()
}

/** An error's message without the "Zed: " the plugin's own errors start with, as a refusal says it. */
export const reasonOf = (e) => String(e?.message ?? e).replace(/^Zed: /, "")
