// Calling Devin's servers: the metadata each request carries, the account's status, the sign-in exchange.
import { CLI_VERSION, EXCHANGE, SERVER, USER_STATUS_RPC } from "./constants.mjs"
import { PB } from "./protobuf.mjs"
import { failure } from "./refusals.mjs"

const osName = () => (process.platform === "win32" ? "windows" : process.platform)

// metadata is what each request says of the client: the CLI's own (with
// its ide and extension names alone Devin lists one model).
export const metadata = (key) =>
  new PB().str(1, "devin-cli").str(2, CLI_VERSION).str(3, key).str(4, "en").str(5, osName()).str(7, CLI_VERSION).str(12, "chisel").str(28, "chisel")

// userStatus asks GetUserStatus about the key's account.
export function userStatus(key, server) {
  return fetch(server + USER_STATUS_RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Connect-Protocol-Version": "1" },
    body: JSON.stringify({
      metadata: { ideName: "devin-cli", ideVersion: CLI_VERSION, extensionName: "devin-cli", extensionVersion: CLI_VERSION, apiKey: key, locale: "en", os: osName() },
    }),
    signal: AbortSignal.timeout(15_000),
  })
}

// readUserStatus is userStatus with its body read, and whether Devin refused the key (the status, or the
// Connect error in the body, says unauthenticated).
export async function readUserStatus(key, server) {
  const res = await userStatus(key, server)
  const text = await res.text()
  return { res, text, refused: res.status === 401 || failure(res.status, text).status === 401 }
}

// exchange trades the callback's code for the session token `devin auth
// login` keeps — already shaped "devin-session-token$<jwt>" — and the
// hosts the account is on.
export async function exchange(code, verifier, redirect) {
  const res = await fetch(SERVER + EXCHANGE, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ code, code_verifier: verifier, redirect_uri: redirect }),
    signal: AbortSignal.timeout(30_000),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`Devin's exchange: ${res.status} ${text.slice(0, 300)}`)
  let r = {}
  try {
    r = JSON.parse(text)
  } catch {}
  const key = r.sessionToken || r.session_token
  if (!key) throw new Error("Devin's exchange returned no session token")
  return { key, webapp: r.devinWebappHost, api: r.devinApiUrl }
}
