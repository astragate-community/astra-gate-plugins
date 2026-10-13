// The live model list: Zen's /models, OpenCode's catalog (metadata) and Zen's docs (protocols), merged over
// what was last known. The state lives in the closure of one book, not in the module.
import { DISCOVERY_TIMEOUT_MS } from "./constants.mjs"
import { bootstrapProvider, buildModels, parseProtocolDocs } from "./models.mjs"

async function readRemote(url, json, headers, callerSignal) {
  const timeout = AbortSignal.timeout(DISCOVERY_TIMEOUT_MS)
  const signal = callerSignal ? AbortSignal.any([callerSignal, timeout]) : timeout
  const response = await fetch(url, { headers, signal })
  if (!response.ok) {
    await response.body?.cancel()
    throw new Error(`Model discovery returned HTTP ${response.status}`)
  }
  return json ? response.json() : response.text()
}

/** A model book for one Zen deployment: `known` is what is verified so far, `discover` refreshes it. */
export function createModelBook({ baseURL, catalogURL, docsURL }) {
  let known = buildModels(Object.keys(bootstrapProvider.models), bootstrapProvider, {}, baseURL)
  let metadata = bootstrapProvider
  let protocols = {}
  let listed = false

  async function discover(signal) {
    const headers = { authorization: "Bearer public", "x-opencode-client": "cli" }
    const [listing, catalog, docs] = await Promise.allSettled([
      readRemote(`${baseURL}/models`, true, headers, signal),
      readRemote(catalogURL, true, undefined, signal),
      readRemote(docsURL, false, undefined, signal),
    ])
    signal?.throwIfAborted()
    let partial = false
    if (catalog.status === "fulfilled" && catalog.value?.opencode?.models) {
      metadata = catalog.value.opencode
    } else {
      partial = true
    }
    if (docs.status === "fulfilled" && Object.keys(parseProtocolDocs(docs.value)).length) {
      protocols = parseProtocolDocs(docs.value)
    } else {
      partial = true
    }
    if (listing.status !== "fulfilled" || !Array.isArray(listing.value?.data)) {
      const fallback = { ...known }
      fallback[Symbol.for("magpie.fellBack")] = true
      return fallback
    }
    const ids = listing.value.data.map((item) => item.id)
    const discovered = buildModels(ids, metadata, protocols, baseURL)
    if (partial) {
      // Preserve previously verified models only while they remain in the live catalog.
      for (const id of ids) {
        if (!discovered[id] && !metadata.models?.[id] && !protocols[id] && known[id]) {
          discovered[id] = known[id]
        }
      }
      discovered[Symbol.for("magpie.fellBack")] = true
    }
    known = discovered
    listed = true
    return discovered
  }

  return {
    get known() {
      return known
    },
    get listed() {
      return listed
    },
    discover,
  }
}
