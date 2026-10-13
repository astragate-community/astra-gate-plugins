// What the SSE collapser (collapse.mjs) and the tool guard (guard.mjs) both need to know about Zen's streams.

/** True when the reply is a server-sent event stream. */
export function isEventStream(response) {
  return response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() === "text/event-stream"
}

/** A copy of the headers fit for a body that was rewritten: its length and encoding no longer apply. */
export function rewrittenHeaders(headers) {
  const copy = new Headers(headers)
  copy.delete("content-length")
  copy.delete("content-encoding")
  return copy
}

/** One SSE line as [field, value] (a single leading space dropped, per the SSE spec). */
export function splitField(line) {
  const colon = line.indexOf(":")
  const field = colon < 0 ? line : line.slice(0, colon)
  let content = colon < 0 ? "" : line.slice(colon + 1)
  if (content.startsWith(" ")) content = content.slice(1)
  return [field, content]
}

/** True for the event that ends a stream of this protocol (chat ends on `[DONE]`, handled by the callers). */
export function endsStream(protocol, type) {
  return (
    (protocol === "responses" && (type === "response.completed" || type === "response.incomplete")) ||
    (protocol === "anthropic" && type === "message_stop")
  )
}

/** True when an event reports that the upstream stream failed. */
export function isFailureEvent(data, type) {
  return type === "error" || data?.error || type === "response.failed" || data?.response?.status === "failed"
}

/** The values of a Map keyed by position, in position order. */
export function sorted(map) {
  return [...map].sort(([a], [b]) => a - b).map(([, value]) => value)
}
