// The Start Plan's requests.
// zcode.z.ai serves the Start Plan only to what looks like ZCode's own
// request, and turns others away with 405 "request has been blocked due to
// unusual activity" (code 3012). A Start Plan request goes as the plugin
// the plan serves (ARNO's "Freeflow", provider zcode-start) sends it: its
// headers (startHeaders) and its body (dress). The texts are prompt.mjs.
import { arch, release } from "node:os"
import { APP_VERSION, UA, ZCODE } from "./constants.mjs"
import PROMPT from "./prompt.mjs"
import { platform, uuid } from "./util.mjs"

/** modelOf reads the model a Messages body asks for. */
export function modelOf(text) {
  try {
    const m = JSON.parse(text)?.model
    return typeof m === "string" ? m : ""
  } catch {
    return ""
  }
}

const osVersion = () => `${process.platform} ${release()} ${arch()}`
const osCategory = () => (process.platform === "darwin" ? "macos" : process.platform === "win32" ? "windows" : "linux")

function intl() {
  try {
    return Intl.DateTimeFormat().resolvedOptions()
  } catch {
    return {}
  }
}

// startHeaders puts ZCode's headers on a Start Plan request, jwt its key.
export function startHeaders(h, jwt) {
  h.delete("x-api-key")
  h.delete("authorization")
  h.delete("X-Device-Mid")
  h.set("Authorization", "Bearer " + jwt)
  h.set("anthropic-version", "2023-06-01")
  h.set("HTTP-Referer", ZCODE)
  h.set("User-Agent", UA + " ai-sdk/anthropic/3.0.81")
  h.set("X-ZCode-App-Version", APP_VERSION)
  h.set("X-Title", "Z Code@cli")
  h.set("X-Release-Channel", "production")
  const o = intl()
  h.set("X-Client-Language", o.locale || "unknown")
  if (o.timeZone) h.set("X-Client-Timezone", o.timeZone)
  h.set("X-ZCode-Agent", "glm")
  h.set("X-Platform", platform())
  h.set("X-Os-Category", osCategory())
  h.set("X-Os-Version", osVersion())
  h.set("x-request-id", uuid())
  h.set("x-zcode-session-type", "main")
  h.set("x-zcode-trace-id", uuid())
}

// WORK_DIR and WORK_GIT are where magpie tells a plugin's fetch the agent
// that asked works: the folder, percent-encoded, and "yes" or "no" for a
// git repository, each left off when magpie doesn't know it (magpie's
// provider.WorkDirHeader and WorkGitHeader). They are for the plugin, not
// the vendor.
const WORK_DIR = "x-magpie-work-dir"
const WORK_GIT = "x-magpie-work-git"

// workPlace takes WORK_DIR and WORK_GIT off h: {dir?, git?}, what magpie
// said of where the agent works.
export function workPlace(h) {
  const place = {}
  const dir = h.get(WORK_DIR)
  if (dir) {
    try {
      place.dir = decodeURIComponent(dir)
    } catch {}
  }
  const git = h.get(WORK_GIT)
  if (place.dir && (git === "yes" || git === "no")) place.git = git
  h.delete(WORK_DIR)
  h.delete(WORK_GIT)
  return place
}

// environment is the prompt's environment section; provider and model
// name the powered-by line, left out with no model. The plugin runs in
// magpie, not in the agent's folder: the working directory and whether it
// is a git repository are the agent's, as magpie tells them (place), and
// each is left out when it isn't told rather than said as magpie's own
// (#86). The agent's shell isn't known here either, so it isn't said; the
// platform and OS version are this computer's, as ZCode's X-Os-* headers
// say them.
export function environment(provider, model, place = {}) {
  const e = PROMPT.environment
  const lines = [e.heading, e.invokedLine]
  if (place.dir) {
    lines.push(`- ${e.cwdLabel}: ${place.dir}`)
    if (place.git) lines.push(`- ${e.gitLabel}: ${place.git === "yes" ? "yes" : e.gitNo}`)
  }
  lines.push(`- ${e.platformLabel}: ${process.platform}`, `- ${e.osVersionLabel}: ${osVersion()}`)
  if (model) lines.push(e.poweredByLine.replace("{provider}", provider).replace("{model}", model))
  return lines.join("\n")
}

// today is the local date, YYYY-MM-DD.
export function today(now = new Date()) {
  const p = (n) => String(n).padStart(2, "0")
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`
}

// contextPrefix is the user turn ZCode puts before the agent's: the day in
// a <system-reminder>, the tags hugging the text.
function contextPrefix() {
  const c = PROMPT.context
  const body = [c.intro, c.currentDateHeading + "\n" + c.currentDateLine.replace("{date}", today()), "", c.outro].join("\n")
  return { role: "user", content: [{ type: "text", text: "<system-reminder>" + body + "</system-reminder>" }] }
}

const cached = (t) => ({ type: "text", text: t, cache_control: { type: "ephemeral" } })

// dress is a Messages request body as ZCode sends it: ZCode's three cached
// system blocks, then the agent's own system text uncached; the context
// prefix as the first turn; no cache mark in the turns but on the last
// block of the last; none on the tools; metadata.user_id naming the
// sign-in's device. site names the powered-by line's provider, place where
// the agent works (workPlace). A body that isn't a Messages request goes as
// it is.
export function dress(text, site, device, place) {
  if (typeof text !== "string" || !text.includes("messages")) return text
  let b
  try {
    b = JSON.parse(text)
  } catch {
    return text
  }
  if (!b || typeof b !== "object" || !Array.isArray(b.messages)) return text
  const provider = site === "bigmodel" ? "bigmodel-api" : "zai-api"
  const model = typeof b.model === "string" ? b.model : ""
  const own = []
  if (typeof b.system === "string") {
    if (b.system.trim()) own.push({ type: "text", text: b.system })
  } else if (Array.isArray(b.system)) {
    for (const x of b.system) if (x?.type === "text" && typeof x.text === "string" && x.text) own.push({ type: "text", text: x.text })
  }
  b.system = [
    cached(PROMPT.cliPrefix),
    cached(PROMPT.stableSections.join("\n\n")),
    cached("\n\n" + [PROMPT.beforeEnvironment, environment(provider, model, place), PROMPT.afterEnvironment].join("\n\n")),
    ...own,
  ]
  b.messages = [contextPrefix(), ...b.messages]
  let last = null
  for (const m of b.messages) {
    if (!m || m.role === "system") continue
    last = m
    if (Array.isArray(m.content)) for (const x of m.content) if (x && typeof x === "object") delete x.cache_control
  }
  if (last && typeof last.content === "string") last.content = [cached(last.content)]
  else if (last && Array.isArray(last.content) && last.content.length) {
    const x = last.content[last.content.length - 1]
    if (x && typeof x === "object" && !x.cache_control) x.cache_control = { type: "ephemeral" }
  }
  if (Array.isArray(b.tools)) for (const t of b.tools) if (t && typeof t === "object") delete t.cache_control
  const meta = b.metadata && typeof b.metadata === "object" ? b.metadata : {}
  b.metadata = { ...meta, user_id: JSON.stringify({ device_id: device, account_uuid: "", session_id: "" }) }
  return JSON.stringify(b)
}
