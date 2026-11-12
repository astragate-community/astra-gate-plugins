// Test helpers: a routed fetch for the harness, and a few Z.ai payload builders.
export const ok = (data) => ({ body: { code: 200, data } });

/** A harness `fetch` that answers by URL substring (first hit wins) and remembers what it was asked. */
export function routed(routes) {
  const calls = [];
  const fetch = async (req) => {
    calls.push(req);
    const hit = routes.find(([part]) => req.url.includes(part));
    if (!hit) return { status: 404, body: {} };
    const r = typeof hit[1] === 'function' ? hit[1](req) : hit[1];
    return { status: r.status ?? 200, headers: { 'content-type': 'application/json' }, body: r.body };
  };
  return { fetch, calls };
}

const b64url = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
export const jwtExpiring = (inSeconds) => `h.${b64url({ exp: Math.floor(Date.now() / 1000) + inSeconds })}.s`;

// a Start Plan balance with one live plan and one bucket for the given (lowercased) models
export const balance = ({ models = ['glm-5.3-flash'], remaining = 10, total = 100, planId = 'p1' } = {}) => ({
  plans: [{ plan_id: planId, status: 'active', name: 'Start Plan' }],
  balances: [{ plan_id: planId, capabilities: models.map((m) => 'model:' + m), remaining_units: remaining, total_units: total, used_units: total - remaining }],
});

export const PERMS = ['providers', 'storage', 'ui', 'net:https://zcode.z.ai', 'net:https://api.z.ai', 'net:https://bigmodel.cn', 'net:https://open.bigmodel.cn'];
