// Which of Devin's models take images: what Devin tells its CLI's model picker (GetCliModelConfigs), under the
// SNAPSHOT's word, and models.dev's for a model Devin said nothing of.
import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { MODEL_CONFIGS_RPC } from "./constants.mjs"
import { SNAPSHOT_IMAGES } from "./snapshot.mjs"
import { PB, dec, fields } from "./protobuf.mjs"
import { metadata } from "./api.mjs"
import { entryOf, refreshed } from "./cache.mjs"

// parseModelConfigs reads GetCliModelConfigsResponse: its
// client_model_configs (1), each with its model_uid (22) and
// supports_images (5), a bool proto3 leaves out when false.
export function parseModelConfigs(b) {
  const out = {}
  for (const f of fields(b)) {
    if (f.num !== 1 || f.wire !== 2) continue
    let uid = ""
    let images = false
    for (const g of fields(f.data)) {
      if (g.num === 22 && g.wire === 2) uid = dec.decode(g.data)
      else if (g.num === 5 && g.wire === 0) images = g.n !== 0
    }
    if (uid) out[uid] = images
  }
  return Object.keys(out).length ? out : null
}

// Each account's word on images, kept and asked again as its list is.
const said = new Map()

async function askModelConfigs(key, server) {
  const res = await fetch(server + MODEL_CONFIGS_RPC, {
    method: "POST",
    headers: { "Content-Type": "application/proto", "Connect-Protocol-Version": "1" },
    body: new PB().bytes(1, metadata(key)).done(),
    signal: AbortSignal.timeout(15_000),
  })
  if (!res.ok) throw new Error(`GetCliModelConfigs: ${res.status}`)
  const images = parseModelConfigs(new Uint8Array(await res.arrayBuffer()))
  if (!images) throw new Error("GetCliModelConfigs: no models")
  return images
}

// imagesFor is what Devin says of each model id's images for key's
// account, SNAPSHOT_IMAGES under it; with wait false, a first ask isn't
// waited for.
export async function imagesFor(key, server, wait = true) {
  if (!said.has(key)) said.set(key, entryOf())
  const c = await refreshed(said.get(key), { load: () => askModelConfigs(key, server), wait })
  return { ...SNAPSHOT_IMAGES, ...(c.value ?? {}) }
}

/** Forgets what Devin said of each account's images. */
export const forgetSaid = () => said.clear()

const bare = (id) => String(id).toLowerCase().split("/").pop()

// The ids models.dev's catalog says take images, read once: { ids } is null until then.
const catalog = { ids: null }

/** Forgets the catalog read, so the next seesImages reads it again. */
export const forgetCatalog = () => {
  catalog.ids = null
}

// seesImages is whether a model Devin said nothing of takes images, as
// magpie's built-in tells it (models.go: m.Images || catalog.SeesImages):
// models.dev's word for the id — most of the providers listing it taking
// images — from the catalog magpie's `magpie sync` or OpenCode keeps, and
// no when neither has it.
export function seesImages(id) {
  if (!catalog.ids) {
    catalog.ids = new Set()
    const cache = process.env.XDG_CACHE_HOME || join(homedir(), ".cache")
    for (const p of [join(cache, "magpie", "models.json"), join(homedir(), ".cache", "opencode", "models.json")]) {
      let m
      try {
        m = JSON.parse(readFileSync(p, "utf8"))
      } catch {
        continue
      }
      if (!m || typeof m !== "object" || !Object.keys(m).length) continue
      const votes = new Map()
      for (const pr of Object.values(m))
        for (const [mid, x] of Object.entries(pr?.models ?? {})) {
          const b = bare(mid)
          votes.set(b, (votes.get(b) ?? 0) + ((x?.modalities?.input ?? []).includes("image") ? 1 : -1))
        }
      for (const [b, v] of votes) if (v > 0) catalog.ids.add(b)
      break
    }
  }
  return catalog.ids.has(bare(id))
}

// withImages is a list of models with what entries (listed's) say of their
// images on them; a model they say nothing of is left as it was.
export function withImages(models, entries) {
  const by = new Map(entries.map((m) => [m.id, m.image]))
  return Object.fromEntries(
    Object.entries(models ?? {}).map(([id, m]) => {
      const image = by.get(id)
      if (typeof image !== "boolean") return [id, m]
      const caps = m?.capabilities ?? {}
      return [id, { ...m, capabilities: { ...caps, attachment: image, input: { ...(caps.input ?? { text: true }), image } } }]
    }),
  )
}
