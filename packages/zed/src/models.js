// The models an account may call: Zed's list, as the host's model records.
import { CLOUD, WIRE } from './constants.js';
import { http } from 'astra';
import { userAgent, stale, ZedStatus } from './api.js';
import { safeParse } from './json.js';
import { modelToken } from './token.js';

/** Each model's Zed provider (anthropic, open_ai, x_ai, google), from the last list read: a request is wrapped for the provider its model belongs to. */
export const vendors = new Map();

/** A Zed model entry as the host's record. */
export const hostModel = (m) => ({
  id: m.id,
  name: m.display_name || m.id,
  protocol: WIRE[m.provider],
  context: m.max_token_count || undefined,
  output: m.max_output_tokens || undefined,
  vision: !!m.supports_images,
  reasoning: !!m.supports_thinking || (m.supported_effort_levels ?? []).length > 0,
});

/** What /models lists that can be called: the disabled ones and those of providers the plugin knows no wire for left out. */
export function parseModels(text) {
  const out = (safeParse(text)?.models ?? []).filter((m) => m && m.id && !m.is_disabled && WIRE[m.provider]);
  if (!out.length) throw new Error("Zed lists no models for this account — its plan may not include Zed's hosted models (see zed.dev/account)");
  return out;
}

/** GET /models, minting the token again once if it is stale. */
export async function fetchModels(s) {
  for (let t = 0; ; t++) {
    const tok = await modelToken(s, t > 0);
    const res = await http.fetch(CLOUD + '/models', { headers: { Authorization: 'Bearer ' + tok, 'x-zed-client-supports-x-ai': 'true', 'User-Agent': userAgent() }, timeoutMs: 15000 });
    const text = await res.text();
    if (!res.ok && t === 0 && stale(res.status, res.headers)) continue;
    if (!res.ok) throw new ZedStatus(res.status, text, res.headers);
    const list = parseModels(text);
    for (const m of list) vendors.set(m.id, m.provider);
    return list.map(hostModel);
  }
}
