export const PERMS = ['providers', 'storage', 'ui', 'net:https://api2.cursor.sh', 'net:https://cursor.com'];

/** A harness `fetch` answering by URL substring (first hit wins), remembering what it was asked. */
export function routed(routes) {
  const calls = [];
  const fetch = async (req) => {
    calls.push(req);
    const hit = routes.find(([part]) => req.url.includes(part));
    if (!hit) return { status: 404, body: {} };
    const r = typeof hit[1] === 'function' ? hit[1](req) : hit[1];
    return { status: r.status ?? 200, headers: { 'content-type': 'application/json' }, body: r.body ?? {} };
  };
  return { fetch, calls };
}

// a JWT that runs out at exp (seconds) and says what claims say
export const jwt = (claims) => `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`;
export const live = () => jwt({ exp: Math.floor(Date.now() / 1000) + 3600 });

const values = (...vs) => ({ enumParameter: { values: vs.map((value) => ({ value })) } });
const variant = (legacySlug, effort, context, extra = {}) => ({ legacySlug, parameterValues: [{ id: 'effort', value: effort }, { id: 'context', value: context }], ...extra });
export const claude = {
  name: 'claude-x',
  clientDisplayName: 'Claude X',
  contextTokenLimit: 200000,
  parameterDefinitions: [{ id: 'context', parameterType: values('200k', '1m') }, { id: 'effort', parameterType: values('low', 'high') }],
  variants: [
    variant('claude-x-low', 'low', '200k', { isDefaultNonMaxConfig: true }),
    variant('claude-x-high', 'high', '200k'),
    variant('claude-x-low-1m', 'low', '1m', { isMaxMode: true }),
    variant('claude-x-high-1m', 'high', '1m', { isMaxMode: true }),
  ],
};
