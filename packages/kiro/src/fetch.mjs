// Kiro: the fetch OpenCode is given — each Messages request, answered through Kiro's own API.
import { generate } from "./chat.mjs"
import { messagesError } from "./refusals.mjs"

async function bodyOf(input, init) {
  const b = init.body ?? (input instanceof Request ? await input.clone().text() : undefined)
  return JSON.parse(typeof b === "string" ? b : new TextDecoder().decode(b))
}

// chatFetch answers a request to the Anthropic provider's fetch: Messages only.
export async function chatFetch(creds, getAuth, auth, input, init) {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
  const path = new URL(url).pathname
  if (!/\/messages$/.test(path)) return messagesError(404, `this plugin only answers Anthropic Messages requests, not ${path}`)
  let req
  try {
    req = await bodyOf(input, init)
  } catch {
    return messagesError(400, "a request that isn't JSON")
  }
  return generate(creds, (await getAuth()) ?? auth, req, init.signal)
}
