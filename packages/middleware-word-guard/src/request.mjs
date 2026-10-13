// The user's own text in a request, in each API's shape.

// Which parts of a message carry text we look at, by API.
const isGeminiText = (p) => p && typeof p.text === "string"
const isResponsesText = (p) => p && (p.type === "input_text" || p.type === "text")
const isChatText = (p) => p && p.type === "text"

// The user's messages as { message, parts, isText }: `parts` is where its text parts are, `isText` picks them.
function userMessages(body, protocol) {
  if (protocol === "gemini") {
    const contents = Array.isArray(body.contents) ? body.contents : []
    // a Gemini content without a role is the user's
    return contents.filter((m) => m && (m.role === "user" || !m.role)).map((m) => ({ message: m, parts: m.parts, isText: isGeminiText }))
  }
  if (protocol === "responses") {
    const input = Array.isArray(body.input) ? body.input : []
    return input.filter((m) => m && m.role === "user").map((m) => ({ message: m, parts: m.content, isText: isResponsesText }))
  }
  const messages = Array.isArray(body.messages) ? body.messages : []
  return messages.filter((m) => m && m.role === "user").map((m) => ({ message: m, parts: m.content, isText: isChatText }))
}

/**
 * Calls `fn` on each text of the user's own in `body` and puts back what it returns: the last user message that
 * has text, or all of them. A Responses `input` that is a plain string is the one turn, whatever `all` says.
 */
export function rewriteUserTexts(body, protocol, all, fn) {
  if (protocol === "responses" && typeof body.input === "string") {
    body.input = fn(body.input)
    return
  }
  const hasText = (u) => typeof u.message.content === "string" || (Array.isArray(u.parts) && u.parts.some(u.isText))
  const withText = userMessages(body, protocol).filter(hasText)
  for (const u of all ? withText : withText.slice(-1)) {
    if (typeof u.message.content === "string") u.message.content = fn(u.message.content)
    else for (const part of u.parts) if (u.isText(part)) part.text = fn(part.text)
  }
}
