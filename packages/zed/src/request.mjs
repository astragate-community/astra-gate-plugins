// Shaping a request the AI SDK wrote into what Zed's /completions takes.

// wireOf is the API a request was written in, from the path the AI SDK
// sent it to, and the model named in a Gemini path.
export function wireOf(url) {
  const p = new URL(url).pathname
  const g = p.match(/\/models\/([^/:]+):(streamGenerateContent|generateContent)$/)
  if (g) return { wire: "gemini", model: decodeURIComponent(g[1]), stream: g[2] === "streamGenerateContent" }
  if (p.endsWith("/messages")) return { wire: "anthropic" }
  if (p.endsWith("/responses")) return { wire: "responses" }
  if (p.endsWith("/chat/completions")) return { wire: "chat" }
  return null
}

// Zed always streams: what the caller asked for is remembered, the request says stream.
function forceStream(req) {
  const stream = !!req.stream
  req.stream = true
  return stream
}

// providerRequest is the request as Zed takes it for its provider's API,
// and whether the caller asked for a stream (Zed always streams).
export function providerRequest(wire, req, model) {
  switch (wire) {
    case "anthropic": {
      const stream = !!req.stream
      // Zed's Anthropic request has no stream field: the cloud always streams
      delete req.stream
      // Zed's cloud refuses a tool result without is_error ("missing field
      // `is_error`"), which Anthropic's own API leaves out when it is false
      for (const m of req.messages ?? []) {
        for (const b of Array.isArray(m?.content) ? m.content : []) {
          if (b?.type === "tool_result" && !("is_error" in b)) b.is_error = false
        }
      }
      return { req, stream }
    }
    case "responses":
      return { req, stream: forceStream(req) }
    case "chat": {
      const stream = forceStream(req)
      // as Zed writes an xAI request
      if ("max_tokens" in req) {
        req.max_completion_tokens = req.max_tokens
        delete req.max_tokens
      }
      return { req, stream }
    }
    case "gemini": {
      delete req.session_id
      delete req.sessionId
      req.model = "models/" + model
      return { req }
    }
  }
}
