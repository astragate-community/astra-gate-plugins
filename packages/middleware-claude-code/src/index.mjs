// Present a channel's requests as Claude Code's, for channels that serve only the official CLI ("this channel only
// serves official Claude Code CLI requests"). Astra's onUpstream hook runs on the request as it goes to one channel,
// after translation into that channel's API, so the identity is written in the API the channel actually reads:
//
//   {"providers": ["<provider id or name>"], "protocol": "anthropic", "version": "2.1.281", "betas": "<comma list>"}
//
// providers is required: with none listed the plugin does nothing (it never applies to every channel by accident).
// protocol is the channel's API it applies to, "anthropic" by default ("chat" also works; "any" is every API).
//
// On a matching request it sets the CLI's headers, and gives the body a Claude Code system prompt when it has none:
// Anthropic gets the billing-attribution block and the identity block in front of the caller's own system blocks,
// and a CLI-shaped metadata.user_id; Chat gets the identity as its first system message. A request that already
// carries them (Claude Code itself) keeps its own. The channel's key is never touched — Astra writes it last.
//
// Astra runs the built file as an ES module in Jint: only onUpstream is exported, and nothing imports a package or a
// node: module. onUpstream is Astra's own hook; magpie does not call it.
import { BETAS, CLI_VERSION, IDENTITY, billingLine, deviceId, fingerprint, headers, sessionUuid } from "./identity.mjs"

export function onUpstream(body, ctx) {
  const o = ctx.options || {}
  const up = ctx.upstream
  if (!up || !matches(o, up)) return
  const version = typeof o.version === "string" && /^\d+\.\d+\.\d+$/.test(o.version) ? o.version : CLI_VERSION
  const betas = typeof o.betas === "string" ? o.betas : BETAS
  const seed = up.provider.id
  for (const [name, value] of Object.entries(headers(up.protocol, seed, version, betas, ctx.sha256))) ctx.setHeader(name, value)
  if (up.protocol === "anthropic") return anthropic(body, seed, version, ctx.sha256)
  if (up.protocol === "chat") return chat(body)
}

/** Whether the options name this channel (by id or name) and its API. */
function matches(o, up) {
  const providers = Array.isArray(o.providers) ? o.providers.filter((p) => typeof p === "string" && p) : []
  if (!providers.includes(up.provider.id) && !providers.includes(up.provider.name)) return false
  const protocol = typeof o.protocol === "string" && o.protocol ? o.protocol : "anthropic"
  return protocol === "any" || protocol === up.protocol
}

const text = (block) => (block && typeof block.text === "string" ? block.text : "")

function firstUserText(messages) {
  for (const m of Array.isArray(messages) ? messages : []) {
    if (!m || m.role !== "user") continue
    const t = typeof m.content === "string" ? m.content : Array.isArray(m.content) ? m.content.map(text).find((s) => s) : ""
    if (t) return t.length > 512 ? t.slice(0, 512) : t
  }
  return ""
}

function anthropic(body, seed, version, sha256) {
  if (!body || typeof body !== "object") return
  const system = typeof body.system === "string" ? (body.system ? [{ type: "text", text: body.system }] : [])
    : Array.isArray(body.system) ? body.system : []
  const first = firstUserText(body.messages)
  const front = []
  if (!system.some((b) => text(b).startsWith("x-anthropic-billing-header:")))
    front.push({ type: "text", text: billingLine(version, fingerprint(first, version, sha256)) })
  if (!system.some((b) => text(b).startsWith("You are Claude Code")))
    front.push({ type: "text", text: IDENTITY })
  body.system = [...front, ...system]
  if (!body.metadata || typeof body.metadata !== "object" || !body.metadata.user_id) {
    const device = deviceId(seed, sha256)
    body.metadata = {
      ...(body.metadata && typeof body.metadata === "object" ? body.metadata : {}),
      user_id: JSON.stringify({ device_id: device, account_uuid: "", session_id: sessionUuid(`${seed}::${device}::${first}`, sha256) }),
    }
  }
  return body
}

function chat(body) {
  if (!body || !Array.isArray(body.messages)) return
  const head = body.messages[0]
  const said = head && (head.role === "system" || head.role === "developer")
    && (typeof head.content === "string" ? head.content : Array.isArray(head.content) ? head.content.map(text).join("") : "")
  if (typeof said === "string" && said.startsWith("You are Claude Code")) return
  body.messages.unshift({ role: "system", content: IDENTITY })
  return body
}
