// The model list an account is offered: the CLI's, kept; and the entries as OpenCode's config and runtime take them.
import { BASE, CHAT, ID } from "./constants.mjs"
import { SNAPSHOT_IMAGES } from "./snapshot.mjs"
import { cliAnswersFor } from "./identity.mjs"
import { cliPath, homeFor, runCLI } from "./cli.mjs"
import { entryOf, refreshed } from "./cache.mjs"
import { seesImages, withImages } from "./images.mjs"
import { listed, parseFamilies, snapshotFamilies } from "./variants.mjs"

// Each account's model list as the CLI last gave it (see cache.mjs). A CLI
// that doesn't answer for the account (#17: on Windows it lists its own
// account's) is never asked for it: the account has Devin's list as of
// SNAPSHOT.
const lists = new Map()

// the list `devin models list` gives for key's account, in the entry c
async function askCLI(c, key, server) {
  const home = await homeFor(key, server)
  if (c.cli === undefined) c.cli = await cliAnswersFor(key, server, home)
  if (c.cli === false) return undefined
  const { out } = await runCLI(home, "models", "list", "--format", "json")
  const fams = parseFamilies(out)
  if (!fams.length) throw new Error("devin models list: no models")
  return fams
}

export async function familiesFor(key, server, wait = true) {
  if (!lists.has(key)) lists.set(key, entryOf({ cli: undefined }))
  const c = lists.get(key)
  await refreshed(c, { load: () => askCLI(c, key, server), allowed: () => c.cli !== false && !!cliPath(), wait })
  return c.value ?? snapshotFamilies()
}

/** Forgets every account's list. */
export const forgetLists = () => lists.clear()

// the capability a model's image flag stands for: what Devin said, else models.dev's
const imageOf = (m) => m.image ?? seesImages(m.id)
const variantsOf = (m) => Object.fromEntries(m.efforts.map((e) => [e, { reasoningEffort: e }]))

// a `listed` entry as OpenCode's config takes a model
export function configModel(m) {
  const image = imageOf(m)
  return {
    id: m.id,
    name: m.name,
    tool_call: true,
    reasoning: m.efforts.length > 0,
    attachment: image,
    temperature: true,
    modalities: { input: image ? ["text", "image"] : ["text"], output: ["text"] },
    limit: { context: m.context, output: m.output },
    ...(m.efforts.length ? { variants: variantsOf(m) } : {}),
  }
}

// a `listed` entry as OpenCode's runtime takes a model
export function runtimeModel(m) {
  const image = imageOf(m)
  return {
    id: m.id,
    providerID: ID,
    name: m.name,
    api: { id: m.id, url: BASE, npm: CHAT },
    status: "active",
    headers: {},
    options: {},
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: { context: m.context, output: m.output },
    capabilities: {
      temperature: true,
      reasoning: m.efforts.length > 0,
      attachment: image,
      toolcall: true,
      input: { text: true, image, audio: false, video: false, pdf: false },
      output: { text: true, image: false, audio: false, video: false, pdf: false },
      interleaved: false,
    },
    release_date: "",
    variants: variantsOf(m),
  }
}

// the models config starts a provider with: Devin's list as of SNAPSHOT
export const configModels = () => Object.fromEntries(listed(snapshotFamilies(), [], SNAPSHOT_IMAGES).map((m) => [m.id, configModel(m)]))

// the account's models at runtime: with no CLI, the models it was given, with what Devin says of their images;
// with one, its list
export async function liveModels(provider, key, server, images) {
  const keep = Object.keys(provider?.models ?? {})
  if (!cliPath()) return withImages(provider.models, listed(snapshotFamilies(), keep, images))
  const families = await familiesFor(key, server)
  return Object.fromEntries(listed(families, keep, images).map((m) => [m.id, runtimeModel(m)]))
}
