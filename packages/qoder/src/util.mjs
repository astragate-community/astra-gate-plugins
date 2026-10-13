// Qoder: the small things several modules share.
import { randomUUID } from "node:crypto"

/** A random 32-character hex id (a request id, a machine key, a chat id). */
export const hexID = () => randomUUID().replaceAll("-", "")

/** A tool call's id when Qoder gave none. */
export const callId = () => "call_" + hexID()

/** Whether a token (or any string-ish field) is missing or only blanks. */
export const blank = (v) => !String(v ?? "").trim()

/** The body of a fetch call's request as text, whether it came in init or in a Request. */
export async function bodyText(input, init) {
  const b = init.body ?? (input instanceof Request ? await input.clone().text() : undefined)
  return typeof b === "string" ? b : new TextDecoder().decode(b)
}
