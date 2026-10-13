// The model list: the one built in, what Grok's backend lists for an account, and the OpenCode model entries made of it.
import { BASE, SIGN_IN_EXPIRED } from "./constants.mjs"
import { sign } from "./identity.mjs"
import { homeOf, token } from "./session.mjs"

// the levels the built-in offered for grok-4.7 before Grok listed any (its
// maker's, as models.dev has them): kept when the list can't be read, so
// a move leaves an agent's reasoning level where it was
const DEFAULT_EFFORTS = ["low", "medium", "high", "xhigh"]

// each effort as the variant OpenCode shows for it
const variantsOf = (efforts) => Object.fromEntries(efforts.map((e) => [e, { reasoningEffort: e }]))

export const DEFAULT_MODELS = {
  "grok-4.7": {
    name: "Grok 4.7",
    attachment: true,
    reasoning: true,
    tool_call: true,
    modalities: { input: ["text", "image"], output: ["text"] },
    variants: variantsOf(DEFAULT_EFFORTS),
  },
}

// listModels is what the account can use, as the CLI's backend lists it:
// Responses models only, each with its context window and efforts
// (listed hardest first, kept easiest first).
export async function listModels(key) {
  const headers = new Headers()
  await sign(headers, key)
  const res = await fetch(`${BASE}/models`, { headers })
  const text = await res.text()
  // a token Grok turned away before its time (signed out elsewhere) is a
  // sign-in gone, said as one past its time is: a move takes it along
  // untried rather than stopping on it
  if (res.status === 401) throw new Error(SIGN_IN_EXPIRED)
  if (!res.ok) throw new Error(`Grok models: ${res.status} ${text.slice(0, 200)}`)
  const out = []
  for (const d of JSON.parse(text)?.data ?? []) {
    if (!d?.id || (d.api_backend && d.api_backend !== "responses")) continue
    const efforts = (d.reasoning_efforts ?? []).map((e) => e?.value).filter(Boolean).reverse()
    out.push(...windowsOf(d, efforts))
  }
  if (!out.length) throw new Error("Grok listed no models")
  return out
}

// labelOf is a window as the picker shows it: 500000 is "500k".
const labelOf = (n) => (n % 1000 === 0 ? `${n / 1000}k` : String(n))

// windowsOf is one model for each context window Grok lists. context_window
// is the default and keeps the plain id (grok-4.7), so a saved agent stays
// where it was. Each other size in context_windows is offered beside it
// (grok-4.7@500k), the way the CLI's /context-window offers it. A list with
// one size, or none, stays one model.
export function windowsOf(d, efforts) {
  const name = d.name || d.id
  const fallback = Number(d.context_window) || 0
  const listed = (Array.isArray(d.context_windows) ? d.context_windows : [])
    .map(Number)
    .filter((n) => Number.isInteger(n) && n > 0)
  const windows = [...new Set(listed.length ? listed : [fallback].filter(Boolean))]
  const base = windows.includes(fallback) ? fallback : windows[0] ?? 0
  const out = [{ id: d.id, apiId: d.id, name, context: base || fallback, window: base, efforts }]
  for (const w of windows) {
    if (w === base) continue
    out.push({ id: `${d.id}@${labelOf(w)}`, apiId: d.id, name: `${name} @ ${labelOf(w)}`, context: w, window: w, efforts })
  }
  return out
}

// entryOf is a listed model as OpenCode keeps it, over what it had for it (was).
export function entryOf(m, was, providerID) {
  return {
    ...was,
    id: m.id,
    providerID,
    name: m.name,
    // the id as offered, window and all: magpie and the AI SDK send
    // api.id as the body's model, and fetch reads the window from it
    // (modelOf) before Grok sees the plain model
    api: { ...(was.api ?? {}), id: m.id, url: BASE, npm: "@ai-sdk/openai" },
    limit: { ...(was.limit ?? {}), context: m.context || was.limit?.context || 0, output: was.limit?.output ?? 0 },
    capabilities: {
      ...(was.capabilities ?? {}),
      reasoning: m.efforts.length > 0 || !!was.capabilities?.reasoning,
      attachment: true,
      toolcall: true,
      input: { ...(was.capabilities?.input ?? {}), text: true, image: true },
    },
    variants: variantsOf(m.efforts),
  }
}

// providerModels is provider.models: the account's models, keyed by id.
export async function providerModels(provider, { auth } = {}) {
  const have = provider?.models ?? {}
  if (!auth || auth.type !== "oauth" || !auth.refresh) return have
  // a list Grok couldn't give is a failure, not the few configured:
  // magpie keeps the list it had
  const list = await listModels((await token(homeOf(auth), false)).key)
  const base = have["grok-4.7"] ?? Object.values(have)[0] ?? {}
  const out = {}
  for (const m of list) out[m.id] = entryOf(m, have[m.id] ?? have[m.apiId] ?? base, provider.id)
  return out
}
