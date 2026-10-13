// Calling Z.ai's JSON endpoints.
import { statusText } from "@astragate-community/plugin-kit"
import { UA, ZCODE } from "./constants.mjs"
import { uuid } from "./util.mjs"

export class ZError extends Error {
  constructor(message, status) {
    super(message)
    this.status = status
  }
}

export const anyDevice = uuid() // X-Device-Mid for calls made signed out (the model list)

// the statuses whose words magpie's built-in said as Go's http.StatusText; any other status keeps
// the server's own reason phrase (the kit's statusText would give Node's words for it instead)
const GO_WORDS = new Set([400, 401, 403, 404, 405, 408, 429, 500, 502, 503, 504])

// call asks one of Z.ai's JSON endpoints, which wrap what they say in
// {code, msg, data}: a code of 0 or 200 is a success. zcode.z.ai is told
// the machine's id (X-Device-Mid), as ZCode tells it.
export async function call(method, url, { auth, body, headers, device, signal } = {}) {
  const h = { "Content-Type": "application/json", Accept: "application/json", "User-Agent": UA }
  if (auth) h.Authorization = auth
  if (url.startsWith(ZCODE + "/")) h["X-Device-Mid"] = device || anyDevice
  Object.assign(h, headers ?? {})
  const res = await fetch(url, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body), signal })
  const text = await res.text()
  let env
  try {
    env = JSON.parse(text)
  } catch {}
  const code = env?.code == null ? "" : String(env.code)
  if (!res.ok) {
    if (env?.msg) throw new ZError(code && code !== "0" ? `${env.msg} (${res.status}, code ${code})` : `${env.msg} (${res.status})`, res.status)
    throw new ZError(GO_WORDS.has(res.status) ? statusText(res.status) : `${res.status} ${res.statusText}`.trim(), res.status)
  }
  if (!env || typeof env !== "object") throw new ZError("not JSON", res.status)
  if (code && code !== "0" && code !== "200") throw new ZError(env.msg || `error ${code}`, res.status)
  return env.data ?? null
}
