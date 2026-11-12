// The settings and the migration of a v1 copy's options.

export const PROTOCOLS = ["anthropic", "chat", "any"]

const list = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === "string" && x.trim()).map((x) => x.trim()) : [])

/** A stored value cleaned up into settings: unknown or mistyped fields fall back to the defaults. */
export function normalize(raw) {
  const r = raw && typeof raw === "object" ? raw : {}
  return {
    providers: list(r.providers),
    protocol: PROTOCOLS.includes(r.protocol) ? r.protocol : "anthropic",
    version: typeof r.version === "string" ? r.version.trim() : "",
    betas: typeof r.betas === "string" ? r.betas.trim() : "",
  }
}

/** The v1 options ({ providers, protocol, version, betas }) are the settings as they are. */
export const fromV1Options = normalize
