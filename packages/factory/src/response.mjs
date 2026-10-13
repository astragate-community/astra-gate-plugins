// Factory: replies the plugin writes or marks itself.

// errorReply is an error as the API the request was for words one:
// Anthropic's on /llm/a/, OpenAI's on the others.
export function errorReply(url, status, type, message, headers = new Headers()) {
  headers.set("content-type", "application/json")
  headers.delete("content-length")
  headers.delete("content-encoding")
  const anthropic = new URL(url).pathname.includes("/llm/a/")
  const body = anthropic ? { type: "error", error: { type, message } } : { error: { message, type, code: null } }
  return new Response(JSON.stringify(body), { status, headers })
}

// said is an answer with magpie's X-Magpie-Sign-In, which tells what it
// means for the account's sign-in whatever its status: "expired" marks it
// lapsed, "kept" leaves it be. magpie takes it off before the agent sees it.
export function said(res, v) {
  const h = new Headers(res.headers)
  h.set("X-Magpie-Sign-In", v)
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h })
}