// Zed's browser sign-in: an RSA key, a loopback port, and the encrypted token the browser brings back.
import crypto from "node:crypto"
import http from "node:http"
import { cloud } from "./api.mjs"
import { modelsOff, orgOf, planName, planOf, who } from "./account.mjs"
import { SIGN_IN_TIMEOUT, SITE, SUCCEEDED } from "./constants.mjs"
import { parse } from "./json.mjs"
import { fetchModels, lists } from "./models.mjs"

// padded is URL-safe base64 with its padding, as Rust's URL_SAFE writes it.
export const padded = (b) => {
  const s = b.toString("base64url")
  return s + "=".repeat((4 - (s.length % 4)) % 4)
}

// decrypt reads the access token the callback carried: RSA-OAEP SHA-256,
// PKCS#1 v1.5 before that.
export function decrypt(key, ciphertext) {
  const ct = Buffer.from(String(ciphertext).replace(/=+$/, ""), "base64url")
  try {
    return crypto.privateDecrypt({ key, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, ct).toString("utf8")
  } catch {}
  // Node and Bun refuse PKCS#1 v1.5 decryption, so its padding is taken off
  // here: 00 02 <non-zero bytes> 00 <message>
  try {
    const em = crypto.privateDecrypt({ key, padding: crypto.constants.RSA_NO_PADDING }, ct)
    const end = em.indexOf(0, 2)
    if (em[0] === 0 && em[1] === 2 && end >= 10) return em.subarray(end + 1).toString("utf8")
  } catch {}
  throw new Error("Zed sign-in: the access token couldn't be decrypted")
}

// signedInWith reads the callback's token, asks Zed who the account is and
// reads its models, so the picker has them before the first request.
export async function signedInWith(key, uid, ciphertext, systemId) {
  const access = decrypt(key, ciphertext)
  const s = { userId: uid, access, systemId }
  const me = parse(await cloud("GET", "/client/users/me", s))
  if (!me) throw new Error("Zed: an unreadable account")
  const org = orgOf(me)
  if (modelsOff(me, org)) throw new Error("Zed: this account's organization has Zed's hosted models turned off")
  s.org = org
  s.who = who(me)
  const plan = planOf(me, org)
  try {
    lists.set(uid, { at: Date.now(), models: await fetchModels(s) })
  } catch {}
  return {
    type: "success",
    access,
    refresh: JSON.stringify({ userId: uid, systemId, org, plan, planName: planName(plan), login: me.user?.github_login || me.user?.username || "", name: me.user?.name ?? "" }),
    expires: 0,
    accountId: s.who,
  }
}

// signIn is Zed's own sign-in, run as the editor runs it.
export async function signIn() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 })
  const pub = padded(publicKey.export({ type: "pkcs1", format: "der" }))
  const systemId = crypto.randomUUID()
  let got
  const back = new Promise((resolve) => (got = resolve))
  // Zed's page sends the browser to the port on whatever path; the query is
  // what counts
  const server = http.createServer((req, res) => {
    const q = new URL(req.url ?? "/", "http://127.0.0.1").searchParams
    const uid = q.get("user_id")
    const tok = q.get("access_token")
    if (!uid || !tok) {
      res.writeHead(404).end()
      return
    }
    got({ uid, tok })
    res.writeHead(302, { Location: SUCCEEDED }).end()
  })
  await new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  const port = server.address().port
  const q = new URLSearchParams({ native_app_port: String(port), native_app_public_key: pub, system_id: systemId })
  const close = () => {
    try {
      server.close()
      server.closeAllConnections?.()
    } catch {}
  }
  return {
    url: `${SITE}/native_app_signin?${q}`,
    instructions: "Sign in to Zed in the browser; it comes back here when you're done.",
    method: "auto",
    async callback() {
      let timer
      try {
        const cb = await Promise.race([back, new Promise((r) => (timer = setTimeout(() => r(null), SIGN_IN_TIMEOUT)))])
        if (!cb) return { type: "failed", error: "the sign-in timed out" }
        return await signedInWith(privateKey, cb.uid, cb.tok, systemId)
      } catch (e) {
        return { type: "failed", error: e.message }
      } finally {
        clearTimeout(timer)
        close()
      }
    },
  }
}
