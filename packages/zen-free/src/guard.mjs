// The tool guard: a Zen reply may only call tools the agent declared (up to case and separators). A stream is
// checked frame by frame and cut with an error event at the first violation; a JSON reply becomes a 502.
import { GuardError, failure, parseJSON } from "./guard-core.mjs"
import { guardedStream } from "./guard-stream.mjs"
import { isEventStream, rewrittenHeaders } from "./sse.mjs"
import { checkSnapshots } from "./snapshots.mjs"
import { nameGuard } from "./tool-names.mjs"

/** Checks a Zen reply's tool calls against the policy ({ declared }), streaming or not. */
export async function guardToolResponse(response, protocol, policy) {
  if (!response.ok) return response
  if (!["chat", "responses", "anthropic"].includes(protocol)) throw new TypeError(`Unsupported protocol: ${protocol}`)
  const checkName = nameGuard(policy)
  const headers = rewrittenHeaders(response.headers)
  if (isEventStream(response)) {
    return new Response(guardedStream(response, protocol, checkName), {
      status: response.status,
      statusText: response.statusText,
      headers,
    })
  }
  const text = await response.text()
  let value
  let status = response.status
  try {
    value = parseJSON(text)
    checkSnapshots(value, protocol, checkName)
  } catch (error) {
    if (!(error instanceof GuardError)) throw error
    status = 502
    value = failure(protocol, error.message)
  }
  headers.set("content-type", "application/json")
  return new Response(JSON.stringify(value), { status, headers })
}
