// What the tool guard's modules share: its error, the shape checks on upstream JSON, and the stream-delta helpers.

/** A reply the guard refuses (as opposed to a bug); rendered to the client in the protocol's error shape. */
export class GuardError extends Error {}

export function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

export function list(value) {
  if (value == null) return []
  if (!Array.isArray(value)) throw new GuardError("Invalid upstream tool snapshot")
  return value
}

/** A tool call's position in a stream delta. */
export function position(value) {
  const result = value ?? 0
  if (!Number.isSafeInteger(result) || result < 0) throw new GuardError("Invalid upstream tool index")
  return result
}

/** Appends a function-call delta: name and arguments concatenate, any other key is kept as sent. */
export function appendFunction(target, fragment) {
  if (!object(fragment)) throw new GuardError("Invalid upstream function delta")
  for (const [key, value] of Object.entries(fragment)) {
    if (key === "name" || key === "arguments") {
      if (typeof value !== "string") throw new GuardError("Invalid upstream function delta")
      target[key] = (target[key] ?? "") + value
    } else {
      Object.defineProperty(target, key, {
        value,
        writable: true,
        enumerable: true,
        configurable: true,
      })
    }
  }
}

/** The error body a refusal is shown as; `stream` is the in-stream event (responses differs from its JSON body). */
export function failure(protocol, message, stream = false) {
  if (protocol === "anthropic") return { type: "error", error: { type: "api_error", message } }
  if (protocol === "responses") {
    return stream
      ? { type: "error", code: "undeclared_tool", message }
      : { error: { type: "upstream_error", code: "undeclared_tool", message } }
  }
  return { error: { message, type: "upstream_error" } }
}

export function parseJSON(text) {
  let value
  try {
    value = JSON.parse(text)
  } catch {
    throw new GuardError("Invalid JSON in upstream response")
  }
  if (!object(value)) throw new GuardError("Invalid JSON object in upstream response")
  return value
}
