// Qoder: the COSY envelope that signs a call to the model API, as Qoder's desktop client does.
import { createCipheriv, createHash, publicEncrypt, constants } from "node:crypto"
import { COSY_VERSION, RSA_KEY } from "./constants.mjs"
import { hexID } from "./util.mjs"

// machineOS names the machine as Qoder's desktop clients do.
export function machineOS() {
  const arch = { x64: "x86_64", ia32: "x86", arm64: "aarch64" }[process.arch] ?? process.arch
  return arch + "_" + process.platform
}

// userBlob is the account as the envelope carries it: AES-128-CBC under a
// fresh key that is its own IV, the key wrapped with Qoder's RSA key.
export function userBlob(u) {
  const raw = JSON.stringify({ uid: u.uid, aid: "", name: u.name ?? "", email: u.email ?? "", security_oauth_token: u.access })
  const key = Buffer.from(hexID().slice(0, 16))
  const c = createCipheriv("aes-128-cbc", key, key)
  const info = Buffer.concat([c.update(raw, "utf8"), c.final()]).toString("base64")
  const wrapped = publicEncrypt({ key: RSA_KEY, padding: constants.RSA_PKCS1_PADDING }, key).toString("base64")
  return { info, key: wrapped }
}

// cosyHeaders signs a call to url whose body, in its wire form, is body.
export function cosyHeaders(url, u, body, ts = Math.floor(Date.now() / 1000)) {
  if (!u?.machineId) throw new Error("Qoder: the account has no machine id; sign in again")
  const blob = userBlob(u)
  const payload = Buffer.from(
    JSON.stringify({ version: "v1", requestId: hexID(), info: blob.info, cosyVersion: COSY_VERSION, ideVersion: "" }),
  ).toString("base64")
  let path = new URL(url).pathname
  if (path.startsWith("/algo")) path = path.slice(5)
  const sig = createHash("md5").update(`${payload}\n${blob.key}\n${ts}\n${body}\n${path}`).digest("hex")
  const m = u.machineId
  return {
    Accept: "application/json",
    "Accept-Encoding": "identity",
    "Content-Type": "application/json",
    Authorization: `Bearer COSY.${payload}.${sig}`,
    "Cosy-Business-Product": "app",
    "Cosy-Business-Type": "agent",
    "Cosy-ClientIp": m,
    "Cosy-ClientType": "10",
    "Cosy-Data-Policy": "disagree",
    "Cosy-Date": String(ts),
    "Cosy-Key": blob.key,
    "Cosy-MachineId": m,
    "Cosy-MachineToken": m,
    "Cosy-MachineType": "5",
    "Cosy-MachineOS": machineOS(),
    "Cosy-Scene": "app",
    "Cosy-User": u.uid,
    "Cosy-Version": COSY_VERSION,
    "Login-Version": "v2",
  }
}
