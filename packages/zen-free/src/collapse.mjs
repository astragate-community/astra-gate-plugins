// Zen is always asked to stream; when the caller wanted a plain JSON reply the stream is read to its end and
// collapsed back into one response object here.
import { MAX_BYTES } from "./constants.mjs"
import { accumulatorFor } from "./accumulators.mjs"
import { endsStream, isEventStream, isFailureEvent, rewrittenHeaders, splitField } from "./sse.mjs"

function jsonResponse(source, protocol, value, error) {
  const headers = rewrittenHeaders(source.headers)
  headers.set("content-type", "application/json")
  if (error) {
    const detail = { type: "upstream_error", message: error }
    value = protocol === "anthropic" ? { type: "error", error: detail } : { error: { ...detail, param: null, code: null } }
  }
  return new Response(JSON.stringify(value), {
    status: error ? 502 : source.status,
    headers,
  })
}

function errorMessage(value, fallback = "Upstream stream failed") {
  if (typeof value === "string" && value) return value
  return value?.message || value?.error?.message || fallback
}

/** Reads a streamed reply to its end and returns it as one JSON response (an error as a 502 in the protocol's shape). */
export async function collapseResponse(response, protocol) {
  if (!response.ok) return response
  if (!isEventStream(response)) return response
  const accumulator = accumulatorFor(protocol)
  let completed = false
  let failure
  let eventName = ""
  let dataLines = []
  let lineParts = []
  let skipLF = false

  function dispatch() {
    const name = eventName
    const text = dataLines.join("\n")
    eventName = ""
    dataLines = []
    if (failure) return
    if (name === "error") {
      let value = text
      try {
        value = JSON.parse(text)
      } catch {
        /* Error events may contain plain text. */
      }
      failure = errorMessage(value)
      return
    }
    if (!text.trim()) return
    if (text.trim() === "[DONE]") {
      if (protocol === "chat") completed = true
      return
    }
    let data
    try {
      data = JSON.parse(text)
    } catch {
      failure = "Invalid JSON in upstream SSE event"
      return
    }
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      failure = "Invalid JSON object in upstream SSE event"
      return
    }
    const type = data.type ?? name
    if (isFailureEvent(data, type)) {
      failure = errorMessage(data.error ?? data.response?.error ?? data)
      return
    }
    if (completed) return
    try {
      accumulator.apply(data, type)
    } catch (error) {
      failure = errorMessage(error, "Invalid upstream SSE event")
      return
    }
    if (endsStream(protocol, type)) completed = true
  }

  function line(value) {
    if (value === "") return dispatch()
    if (value.startsWith(":")) return
    const [field, content] = splitField(value)
    if (field === "data") dataLines.push(content)
    if (field === "event") eventName = content
  }

  function feed(text) {
    let start = 0
    if (skipLF && text.length) {
      if (text[0] === "\n") start = 1
      skipLF = false
    }
    const endings = /[\r\n]/g
    endings.lastIndex = start
    let match
    while ((match = endings.exec(text))) {
      lineParts.push(text.slice(start, match.index))
      line(lineParts.join(""))
      lineParts = []
      start = match.index + 1
      if (match[0] === "\r") {
        if (text[start] === "\n") start++
        else if (start === text.length) skipLF = true
      }
      endings.lastIndex = start
    }
    if (start < text.length) lineParts.push(text.slice(start))
  }

  if (response.body) {
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let bytes = 0
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        bytes += value.byteLength
        if (bytes > MAX_BYTES) {
          failure = "Upstream SSE exceeds the 32 MiB buffer limit"
          await reader.cancel()
          break
        }
        feed(decoder.decode(value, { stream: true }))
        if (failure) {
          await reader.cancel()
          break
        }
      }
      feed(decoder.decode())
    } finally {
      reader.releaseLock()
    }
  }
  if (!failure && !completed) failure = "Upstream SSE ended without a completion marker"
  let body
  if (!failure) {
    try {
      body = accumulator.finish()
    } catch (error) {
      failure = errorMessage(error)
    }
  }
  return jsonResponse(response, protocol, body, failure)
}
