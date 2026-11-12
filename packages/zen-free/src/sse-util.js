// What the reply transform needs to know about Zen's streams.

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
