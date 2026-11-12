// Where each API names the model in a reply: the part of the middleware that puts the asked name back.

// Each API names the model in its own place. The first place found is the only one rewritten, and the event
// (or body) is returned only when something was written, so an untouched one costs the gateway no re-encode.

/** A stream event, with the model it names replaced by `asked`; undefined when it names none. */
export function nameAskedInEvent(ev, asked) {
  // Anthropic: message_start carries the whole message, written even when it already says `asked`
  if (ev.type === "message_start" && ev.message && typeof ev.message.model === "string") {
    ev.message.model = asked
    return ev
  }
  // Chat chunks
  if (typeof ev.model === "string" && ev.model !== asked) {
    ev.model = asked
    return ev
  }
  // Responses: response.created / response.completed
  if (ev.response && typeof ev.response.model === "string") {
    ev.response.model = asked
    return ev
  }
  // Gemini names it in modelVersion
  if (typeof ev.modelVersion === "string" && ev.modelVersion !== asked) {
    ev.modelVersion = asked
    return ev
  }
}

/** A whole reply, with the model it names replaced by `asked`; undefined when it names none. */
export function nameAskedInResponse(body, asked) {
  if (typeof body.model === "string") {
    body.model = asked
    return body
  }
  if (body.response && typeof body.response.model === "string") {
    body.response.model = asked
    return body
  }
  if (typeof body.modelVersion === "string" && body.modelVersion !== asked) {
    body.modelVersion = asked
    return body
  }
}
