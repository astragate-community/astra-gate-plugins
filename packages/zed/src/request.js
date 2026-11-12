// Shaping a request the gateway wrote into what Zed's /completions takes: the provider's own request, wrapped.

/** Zed always streams: the caller's own choice is the reply's business (ctx.request.stream), the request says stream. */
const forceStream = (req) => {
  req.stream = true;
};

/** The request as Zed takes it for its provider's API. Returns a new object; the host's own is left alone. */
export function providerRequest(wire, body, model) {
  const req = structuredClone(body ?? {});
  switch (wire) {
    case 'anthropic':
      // Zed's Anthropic request has no stream field: the cloud always streams
      delete req.stream;
      // Zed's cloud refuses a tool result without is_error ("missing field `is_error`"), which Anthropic's own API leaves out when it is false
      for (const m of req.messages ?? []) {
        for (const b of Array.isArray(m?.content) ? m.content : []) {
          if (b?.type === 'tool_result' && !('is_error' in b)) b.is_error = false;
        }
      }
      return req;
    case 'responses':
      forceStream(req);
      return req;
    case 'chat':
      forceStream(req);
      // as Zed writes an xAI request
      if ('max_tokens' in req) {
        req.max_completion_tokens = req.max_tokens;
        delete req.max_tokens;
      }
      return req;
    case 'gemini':
      delete req.session_id;
      delete req.sessionId;
      req.model = 'models/' + model;
      return req;
  }
  return req;
}
