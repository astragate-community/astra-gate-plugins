// Factory: reading what a request body holds.

/** A request body as text; undefined when it is none of the shapes fetch is handed here (a string or bytes). */
export function bodyText(body) {
  if (typeof body === "string") return body
  if (body instanceof ArrayBuffer) return Buffer.from(body).toString("utf8")
  if (ArrayBuffer.isView(body)) return Buffer.from(body.buffer, body.byteOffset, body.byteLength).toString("utf8")
  return undefined
}

/** The model a request body names, "" when it names none or can't be read. */
export function bodyModel(body) {
  try {
    if (body == null) return ""
    return JSON.parse(bodyText(body) ?? "")?.model ?? ""
  } catch {
    return ""
  }
}
