// The settings and the migration of a v1 copy's options.

export const DEFAULTS = { prompt: "", override: false, position: "append", agents: [], models: [] }

const list = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === "string" && x.trim()).map((x) => x.trim()) : [])

/** A stored value cleaned up into settings: unknown or mistyped fields fall back to the defaults. */
export function normalize(raw) {
  const r = raw && typeof raw === "object" ? raw : {}
  return {
    prompt: typeof r.prompt === "string" ? r.prompt : DEFAULTS.prompt,
    override: r.override === true,
    position: r.position === "prepend" ? "prepend" : "append",
    agents: list(r.agents),
    models: list(r.models),
  }
}

/** The v1 options ({ system_prompt, override, position, agents, models }) as settings. */
export function fromV1Options(options) {
  const o = options && typeof options === "object" ? options : {}
  return normalize({ ...o, prompt: o.system_prompt })
}
