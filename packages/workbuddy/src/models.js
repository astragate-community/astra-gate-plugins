// WorkBuddy: the models an account has, from WorkBuddy's own product config.
import { http } from 'astra';
import { APP_VERSION, UA_VERSION } from './constants.js';
import { sign } from './api.js';
import { speaksAnthropic, textOnly } from './sites.js';

// creditsOf reads a model's credits, the multiple WorkBuddy's picker shows by it: "x0.03", "0" or 0; "x0.00" is free.
// A rate it can't read (or none, or an infinite one) is undefined: the model is neither free nor rated. The same rule
// as magpie's built-in (wbCredits).
export function creditsOf(c) {
  if (c == null || c === '') return undefined;
  const s = String(c).trim().toLowerCase().replace(/^x/, '');
  const n = Number(s);
  return s !== '' && Number.isFinite(n) && n >= 0 ? n : undefined;
}

/**
 * The plan's models as WorkBuddy's product config lists them: the "cli" agent's list, each with its details. The CLI
 * User-Agent picks WorkBuddy's config (a bare WorkBuddy/<v> gets CodeBuddy IDE's, no cli). Returns the host's model
 * records; the reasoning levels, the free flag and the credit rate WorkBuddy reports have no place in them.
 */
export async function liveModels(site, a) {
  const headers = { ...sign(site, a), 'User-Agent': `CLI/${APP_VERSION} WorkBuddy/${UA_VERSION}`, 'X-Requested-With': 'XMLHttpRequest', Accept: 'application/json' };
  const res = await http.fetch(site.endpoint + '/v3/config', { headers, timeoutMs: 15000 });
  const env = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${site.name}'s config: HTTP ${res.status}`);
  if (env.code) throw new Error(`${site.name}'s config: ${env.msg} (${env.code})`);
  const cfg = env.data ?? {};
  const out = [];
  for (const agent of cfg.agents ?? []) {
    if (agent.name !== 'cli') continue;
    for (const id of agent.models ?? []) {
      const d = (cfg.models ?? []).find((x) => x.id === id);
      const m = { id, name: d?.name || id, protocol: speaksAnthropic(site, id) ? 'anthropic' : 'chat' };
      if (d) {
        if (d.maxInputTokens) m.context = d.maxInputTokens;
        if (d.maxOutputTokens) m.output = d.maxOutputTokens;
        m.vision = d.supportsImages === true && !textOnly(site, id);
        if ((d.reasoning?.supportedEfforts ?? []).length) m.reasoning = true;
      }
      out.push(m);
    }
  }
  // tell apart models the config names alike: deepseek-v4.1-flash and deepseek-v4.1-flash-sg are both "Deepseek-V4.1-Flash"
  const first = new Map();
  for (const m of out) {
    const id = first.get(m.name);
    if (id === undefined) {
      first.set(m.name, m.id);
      continue;
    }
    const rest = m.id.startsWith(id + '-') ? m.id.slice(id.length + 1) : '';
    m.name = `${m.name} (${rest ? rest.toUpperCase() : m.id})`;
  }
  return out;
}
