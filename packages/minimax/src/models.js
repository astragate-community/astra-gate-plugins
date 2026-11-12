// MiniMax Code: the model list — the built-in one, and MiniMax Code's live model config.
import { http } from 'astra';
import { num, obj, str } from './values.js';

// MiniMax Code's own list, for when the live one can't be had.
// thinking: "switchable" (on or off), "forced_on" (always on, at an effort), "on", "off"
export const MODELS = [
  { id: 'MiniMax-M3.1-Flash-Preview', name: 'M3.1-Flash-Preview', context: 512000, output: 128000, images: true, thinking: 'forced_on', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { id: 'MiniMax-M3', name: 'MiniMax-M3', context: 512000, output: 128000, images: true, thinking: 'switchable', efforts: [] },
  { id: 'MiniMax-M2.7', name: 'MiniMax-M2.7', context: 200000, output: 128000, images: false, thinking: 'on', efforts: [] },
  { id: 'MiniMax-M2.7-highspeed', name: 'MiniMax-M2.7-highspeed', context: 200000, output: 128000, images: false, thinking: 'on', efforts: [] },
];

/** A model as the host lists it (every MiniMax Code model speaks Anthropic messages). */
export const hostModel = (m) => ({
  id: m.id,
  name: m.name,
  protocol: 'anthropic',
  context: m.context || undefined,
  output: m.output || undefined,
  vision: !!m.images,
  reasoning: m.thinking !== 'off',
});

export const builtinModels = () => MODELS.map(hostModel);

/** Reads MiniMax Code's model config ({providers:[{providerId:"minimax", config:{models:{<id>:{…}}, model_order?}}]}) as models. */
export function parseModels(body) {
  const p = (Array.isArray(body?.providers) ? body.providers : []).find((x) => x?.providerId === 'minimax');
  const ms = obj(obj(p?.config)?.models);
  if (!ms) return [];
  const order = Array.isArray(p.config.model_order) ? p.config.model_order.filter((id) => ms[id]) : [];
  const ids = [...order, ...Object.keys(ms).filter((id) => !order.includes(id))];
  const out = [];
  for (const id of ids) {
    const d = obj(ms[id]);
    if (!d || !id.trim()) continue;
    const input = Array.isArray(d.modalities?.input) ? d.modalities.input : [];
    const mode = str(d.thinking_config, 'mode');
    const efforts = (d.thinking?.effortOptions ?? d.thinking?.effort_options ?? d.effort_options ?? []).filter((e) => typeof e === 'string' && e && e !== 'default' && e !== 'none');
    out.push({
      id,
      name: str(d, 'name') ?? id,
      context: num(d.limit?.context) ?? 0,
      output: num(d.limit?.output) ?? 0,
      images: input.includes('image') || d.attachment === true,
      thinking: mode === 'switchable' ? 'switchable' : mode === 'forced_off' ? 'off' : mode === 'forced_on' ? 'forced_on' : d.reasoning === false ? 'off' : 'on',
      efforts,
    });
  }
  return out;
}

/** Asks MiniMax Code's model config, as mcode does at start: the signed-in account's first, then, when that is refused, no one's. */
export async function liveModels(site, access) {
  const url = `${site.llm}/mavis/api/v1/models?region=${site.region}&buildEnv=prod`;
  const ask = (auth) => http.fetch(url, { headers: { Accept: 'application/json', ...(auth ? { Authorization: 'Bearer ' + auth } : {}) }, timeoutMs: 10000 });
  let res = await ask(access);
  if (res.status === 401 || res.status === 403) res = await ask('');
  if (!res.ok) throw new Error(`${site.name}'s models: HTTP ${res.status}`);
  return parseModels(await res.json());
}
