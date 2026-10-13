// Xiaomi MiMo: shaping a model request for the app's /route or the Token Plan's endpoint, and marking the reply.
import { AUTO_MODELS } from "./constants.mjs"
import { tryJSON } from "./json.mjs"

// a body handed over as bytes is read as the string it is
export function bodyText(body) {
  if (body instanceof ArrayBuffer) return new TextDecoder().decode(body)
  if (ArrayBuffer.isView(body)) return new TextDecoder().decode(new Uint8Array(body.buffer, body.byteOffset, body.byteLength))
  return body
}

// body with its model renamed as `names` say ({from: to}); a body that
// isn't a JSON string, or names another model, stays as it is
export function renamedModel(body, names) {
  if (typeof body !== "string") return body
  const j = tryJSON(body)
  if (Object.hasOwn(names, j?.model)) return JSON.stringify({ ...j, model: names[j.model] })
  return body
}

// mimo-auto, the app's default, is asked as the model it stands for
export const withAutoModel = (body) => (typeof body === "string" && body.includes('"mimo-auto"') ? renamedModel(body, AUTO_MODELS) : body)

// what the app's /route path is at the Token Plan's endpoint: the path after /route
export const planPath = (url) => new URL(url).pathname.replace(/^.*?\/route(?=\/|$)/, "")

// said is an answer with magpie's X-Magpie-Sign-In, which tells what it
// means for the account's sign-in whatever its status: "expired" marks it
// lapsed, "kept" leaves it be. magpie takes it off before the agent sees it.
// A body already read replaces the stream, and the headers that described the
// stream's encoding go.
export function said(res, v, body) {
  const h = new Headers(res.headers)
  if (body !== undefined) {
    h.delete("content-encoding")
    h.delete("content-length")
  }
  h.set("X-Magpie-Sign-In", v)
  return new Response(body !== undefined ? body : res.body, { status: res.status, statusText: res.statusText, headers: h })
}
