// Talking to Cline: the identity headers every call carries, the {success, data} envelope its API answers in, and
// what a refusal means for the sign-in.
import { API, CLIENT } from "./constants.mjs"
import { safeJson } from "./util.mjs"

// clientHeaders is the header set resolveProviderRequestHeaders builds for a
// client with that identity; official clients supply a task id per task.
export function clientHeaders(taskId) {
  return {
    "HTTP-Referer": "https://cline.bot",
    "X-Title": "Cline",
    "User-Agent": `Cline/${CLIENT.version}`,
    "X-IS-MULTIROOT": "false",
    "X-CLIENT-TYPE": CLIENT.type,
    "X-CLIENT-VERSION": CLIENT.version,
    "X-PLATFORM": CLIENT.platform,
    "X-PLATFORM-VERSION": CLIENT.version,
    "X-CORE-VERSION": CLIENT.core,
    ...(taskId ? { "X-Task-ID": taskId } : {}),
  }
}

// Lapsed is the sign-in itself gone: a refused refresh, or an API that turned
// the account's token away. magpie marks the account from e.expired.
export class Lapsed extends Error {
  constructor(message) {
    super(message)
    this.expired = true
  }
}

// clineApi is one call to Cline's own API, and the {success, data} envelope it
// answers in. lapsed says which answers mean the sign-in itself is gone (401
// and 403, unless the caller knows this endpoint refuses otherwise); the rest
// is a request that failed.
export async function clineApi(url, { method = "GET", body, headers = {}, signal, lapsed } = {}) {
  const gone = lapsed ?? ((status) => status === 401 || status === 403)
  let res
  try {
    res = await fetch(url, {
      method,
      headers: {
        Accept: "application/json",
        ...clientHeaders(),
        ...headers,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: signal ?? AbortSignal.timeout(15_000),
    })
  } catch (e) {
    throw new Error(`Cline: ${e?.message ?? e}`)
  }
  const text = (await res.text().catch(() => "")).trim()
  if (gone(res.status, text))
    throw new Lapsed(`the sign-in lapsed — Cline refused it (HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ""}); sign in to Cline again`)
  if (!res.ok) throw Object.assign(new Error(`Cline request failed (HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ""})`), { status: res.status })
  const env = safeJson(text)
  if (env && typeof env === "object" && "success" in env) {
    if (!env.success) throw new Error(`Cline request failed${env.error ? `: ${env.error}` : ""}`)
    return env.data
  }
  return env
}

// feedJson reads one of Cline's public feeds (served without a sign-in) as JSON, null when the body isn't;
// `what` names the feed in the error ("Cline model list").
export async function feedJson(path, what) {
  let res
  try {
    res = await fetch(`${API}${path}`, {
      headers: { Accept: "application/json", ...clientHeaders() },
      signal: AbortSignal.timeout(10_000),
    })
  } catch (e) {
    throw new Error(`${what}: ${e?.message ?? e}`)
  }
  if (!res.ok) throw new Error(`${what}: HTTP ${res.status}`)
  return res.json().catch(() => null)
}
