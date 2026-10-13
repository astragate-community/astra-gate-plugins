// a fetch that answers by URL substring and remembers what it was asked
export function fakeFetch(routes) {
  const calls = []
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url)
    calls.push({ url: u, init, headers: new Headers(init.headers) })
    const hit = routes.find(([part]) => u.includes(part))
    if (!hit) return new Response("{}", { status: 404 })
    const r = typeof hit[1] === "function" ? hit[1](u, init) : hit[1]
    return new Response(typeof r.body === "string" ? r.body : JSON.stringify(r.body), { status: r.status ?? 200, headers: r.headers ?? { "content-type": "application/json" } })
  }
  return calls
}

export const ok = (data) => ({ body: { code: 200, data } })

export const jwtExpiring = (inSeconds) => `h.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + inSeconds })).toString("base64url")}.s`

// a Start Plan balance with one live plan and one bucket for the given (lowercased) models
export const balance = ({ models = ["glm-5.3-flash"], remaining = 10, total = 100, planId = "p1" } = {}) => ({
  plans: [{ plan_id: planId, status: "active", name: "Start Plan" }],
  balances: [{ plan_id: planId, capabilities: models.map((m) => "model:" + m), remaining_units: remaining, total_units: total, used_units: total - remaining }],
})
