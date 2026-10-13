// The fetch every request goes through: signed with the key both ways Command Code takes it, a Go key's chat
// completions sent to /alpha/generate
import { kept } from "@astragate-community/plugin-kit"
import { planNow } from "./account.mjs"
import { generate } from "./generate.mjs"
import { markGo } from "./metadata.mjs"
import { refusal } from "./refusals.mjs"
import { workPlace } from "./request.mjs"
import { liveKey } from "./signin.mjs"

// GO_NO_API is the Provider API refusing a Go plan's key: "Your Go plan
// doesn't include API access. Upgrade to Provider or higher …" (#969)
const GO_NO_API = /\bGo plan doesn.t include API access/i

// signedFetch is the fetch for an account `auth` (getAuth reads it again each time, as it may have changed);
// `saved` is the plan its sign-in saved
export function signedFetch(client, getAuth, auth, saved) {
  return async function fetchSigned(input, init = {}) {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    const headers = new Headers(init.headers ?? (input instanceof Request ? input.headers : undefined))
    const key = await liveKey((await getAuth()) ?? auth)
    headers.set("Authorization", `Bearer ${key}`)
    headers.set("x-api-key", key)
    const place = workPlace(headers)
    const chatting = /\/chat\/completions$/.test(new URL(url).pathname)
    let chat
    if (chatting) {
      try {
        const b = init.body ?? (input instanceof Request ? await input.clone().text() : undefined)
        chat = JSON.parse(typeof b === "string" ? b : new TextDecoder().decode(b))
      } catch {
        return refusal({ status: 400, message: "a request that isn't JSON" })
      }
      if ((await planNow(key, saved)) === "Go") return kept(await generate(key, chat, init.signal, place))
    }
    // the Provider API's answer goes on as it came, the account
    // kept: the built-in neither marked one lapsed nor cleared it
    const res = await fetch(input, { ...init, headers })
    if (res.ok) return kept(res)
    // a Go key the plan wasn't known for (billing/subscriptions slow
    // or failing, nothing saved yet) is refused by the Provider API
    // (#969): it is Go from now on, and a chat completion is asked
    // again where Go is served
    const text = await res.text()
    if (GO_NO_API.test(text)) {
      await markGo(client, key, (await getAuth()) ?? auth)
      if (chatting) return kept(await generate(key, chat, init.signal, place))
    }
    return kept(res, text)
  }
}
