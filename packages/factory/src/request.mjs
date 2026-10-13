// Factory: a model request as droid sends it to Factory's API: where it goes, the headers, the body.
import { API } from "./constants.mjs"
import { anthropicBody } from "./anthropic-request.mjs"
import { factoryHeaders, llmBase } from "./api.mjs"
import { bodyModel } from "./body.mjs"
import { byId } from "./models.mjs"
import { droidBody } from "./opening.mjs"
import { unwrapAnthropicTools } from "./tool-replies.mjs"
import { wrapAnthropicTools } from "./tools.mjs"

/**
 * What to send for one fetch the agent made, with account `c` (a live one): the url (an EU org is served from
 * Factory's EU region, an on-prem one from its own host), the init with droid's headers and the adapted body, and
 * the names of the tools whose schema was wrapped.
 */
export function shaped(c, input, init, body, sessionId) {
  let url = input instanceof Request ? input.url : String(input)
  const to = llmBase(c)
  if (to !== API && url.startsWith(API)) url = to + url.slice(API.length)
  const h = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
  h.delete("x-api-key")
  factoryHeaders(h, c)
  const model = byId.get(bodyModel(body))
  const path = new URL(url).pathname
  const upstream = model ? model.upstream : path.includes("/llm/o/") ? "openai" : "anthropic"
  h.set("x-api-provider", upstream)
  h.set("x-session-id", sessionId)
  h.set("x-assistant-message-id", crypto.randomUUID())
  h.set("x-provider-routing-source", "registry_default")
  if (upstream === "openai") h.set("OpenAI-Platform", "org-bHuLtG1fGmYk5YaOihAAXFBw")
  // droid's Anthropic client is made with the key "placeholder",
  // which Anthropic's SDK sends beside the bearer token
  if (path.includes("/llm/a/")) h.set("X-Api-Key", "placeholder")
  // another agent's request opens as droid's does (droidBody)
  const anthropic = path.includes("/llm/a/") && (path.endsWith("/messages") || path.endsWith("/messages/count_tokens"))
  const adapted = anthropic ? wrapAnthropicTools(anthropicBody(body)) : { body: droidBody(path, body), names: new Set() }
  if (adapted.body !== body) h.delete("content-length")
  const method = init?.method ?? (input instanceof Request ? input.method : "POST")
  return { url, path, names: adapted.names, init: { ...init, method, headers: h, body: adapted.body } }
}

/** Sends the request shaped for `c`; a reply to /messages has its wrapped tools' arguments unwrapped. */
export async function send(c, input, init, body, sessionId) {
  const { url, path, names, init: out } = shaped(c, input, init, body, sessionId)
  const res = await fetch(url, out)
  return path.endsWith("/messages") ? unwrapAnthropicTools(res, names) : res
}
