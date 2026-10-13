// MiniMax Code: shaping a chat request — MiniMax Code's headers, and the one retry on a turned-away token.
import { PLACEHOLDER_KEY, chatBase } from "./constants.mjs"
import { answer } from "./response.mjs"

/** The request as MiniMax Code sends it: its headers on top of the SDK's, the account in Authorization. */
export function sendOf(session) {
  return (input, init, body, a) => {
    const req = input instanceof Request ? input : null
    const headers = new Headers(init?.headers ?? req?.headers)
    headers.delete("content-length")
    headers.set("Authorization", "Bearer " + a.access)
    headers.set("x-api-key", PLACEHOLDER_KEY)
    headers.set("User-Agent", "MiniMaxAgent")
    headers.set("X-Mavis-Agent-Id", "main")
    headers.set("X-Mavis-Timezone-Offset", String(new Date().getTimezoneOffset() * -60))
    if (!headers.get("X-Mavis-Session-Id")) headers.set("X-Mavis-Session-Id", session)
    if (!headers.has("anthropic-version")) headers.set("anthropic-version", "2023-06-01")
    return fetch(req ? req.url : input, { ...init, method: init?.method ?? req?.method ?? "POST", headers, body })
  }
}

/** auth.loader: the SDK's base URL and key, and a fetch that signs each chat request. */
export const loaderOf = (site, fresh, session) => async (getAuth) => {
  const auth = await getAuth()
  if (auth?.type !== "oauth") return {}
  const send = sendOf(session)
  return {
    baseURL: chatBase(site),
    apiKey: PLACEHOLDER_KEY,
    async fetch(input, init) {
      const req = input instanceof Request ? input : null
      let body = init?.body
      if (body === undefined && req) body = await req.clone().text()
      let { a, renewed: did } = await fresh(getAuth)
      let res = await send(input, init, body, a)
      if (res.status === 401) {
        // the token was turned away before its end: a newer one
        // if there is one, else refreshed, and sent once more
        ;({ a } = await fresh(getAuth, a.access))
        did = true
        res = await send(input, init, body, a)
      }
      return answer(res, did)
    },
  }
}
