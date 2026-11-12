// The models: ZCode's provider config (zcode.z.ai's), a plan's models read from it, and how each is declared to the host.
import { http, permissions } from 'astra';
import { APP_VERSION, MODELS, START_BASE, START_MODELS, UA, ZAI_BASE, ZCODE } from './constants.js';
import { call } from './api.js';
import { giftID, giftNames, startPlan } from './gift.js';
import { plansOf } from './routing.js';
import { stateOf } from './session.js';
import { isBigModel } from './sites.js';
import { platformName } from './start.js';

// planID is ZCode's providerId for the plan served at base; a team's plan has the individual one's models.
export const planID = (base) =>
  base.includes('/zcode-plan/') ? 'account:zai-start-plan' : isBigModel(base) ? 'account:bigmodel-individual-coding-plan' : 'account:zai-individual-coding-plan';

const efforts = (vs) => [...new Set(vs.map((v) => (v === 'disabled' ? 'none' : v === 'enabled' ? 'high' : v)))];

// modelsOf is a plan's models in ZCode's provider config.
export function modelsOf(cfg, plan) {
  const c = cfg?.config ?? {};
  const ids = [];
  const on = new Set();
  const add = (id) => {
    if (!on.has(id.toLowerCase())) on.add(id.toLowerCase()), ids.push(id);
  };
  for (const r of c.providerConfigRules?.providerRules ?? []) if (r.providerId === plan) (r.builtinModelIds ?? []).forEach(add);
  const off = new Set();
  for (const r of c.modelConfigRules?.builtinProviderModelRules ?? []) {
    if (r.providerId !== plan) continue;
    if (r.config?.enabled === false) off.add(String(r.modelId).toLowerCase());
    else add(r.modelId);
  }
  const out = [];
  for (const id of ids) {
    if (off.has(id.toLowerCase())) continue;
    const m = { id, context: 0, output: 0, efforts: [] };
    for (const r of c.modelConfigRules?.modelRules ?? []) {
      let re;
      try {
        re = new RegExp(`^(?:${r.modelMatch})$`, 'i');
      } catch {
        continue;
      }
      if (!re.test(id)) continue;
      const x = r.config ?? {};
      if (x.properties?.contextWindow > 0) m.context = x.properties.contextWindow;
      if (x.optionSpecs?.maxOutputTokens?.max > 0) m.output = x.optionSpecs.maxOutputTokens.max;
      if (typeof x.properties?.inputFormat?.supportsImage === 'boolean') m.image = x.properties.inputFormat.supportsImage;
      if (x.optionSpecs?.reasoningLevel?.values?.length) m.efforts = efforts(x.optionSpecs.reasoningLevel.values);
    }
    out.push(m);
  }
  return out;
}

// remoteConfig is the release of ZCode's provider config zcode.z.ai names now. The config sits on a host of ZCode's
// choosing, which a v2 plugin may fetch only when its net: permissions name the origin: otherwise this throws and
// the built-in table stands in.
async function remoteConfig() {
  const c = await call('GET', `${ZCODE}/api/v1/client/configs?app_version=${APP_VERSION}&platform=${platformName()}`, { timeoutMs: 8000 });
  const url = c?.configs?.builtin_provider_config_json;
  if (!String(url ?? '').startsWith('https://')) throw new Error("ZCode's configs name no provider config");
  const origin = /^(https:\/\/[^/?#]+)/.exec(url)[1].toLowerCase();
  if (!permissions.has('net:' + origin)) throw new Error(`the plugin may not reach ${origin}`);
  const res = await http.fetch(url, { headers: { 'user-agent': UA }, timeoutMs: 8000 });
  if (!res.ok) throw new Error(`ZCode's provider config: ${res.status}`);
  return res.json();
}

// the config zcodeConfig kept, and when (a cache: a restart reads it again)
const configCache = { cfg: null, at: 0 };
export const forgetConfig = () => (configCache.at = 0);

/** ZCode's provider config, kept for 10 minutes; null when it can't be had. */
export async function zcodeConfig() {
  if (Date.now() - configCache.at < 600_000) return configCache.cfg;
  let cfg = null;
  try {
    cfg = await remoteConfig();
  } catch {}
  configCache.cfg = cfg;
  configCache.at = Date.now();
  return cfg;
}

/** A model as the host's list takes it. */
export const record = (m) => ({
  id: m.id,
  name: m.id,
  protocol: 'anthropic',
  context: m.context || 0,
  output: m.output || 0,
  vision: !!m.image,
  reasoning: (m.efforts ?? []).some((e) => e !== 'none'),
});

/** The account's plan's models, as ZCode's config lists them now (the table stands in when it can't be had). */
export async function modelsFor(account) {
  const s = account ? stateOf(await account.secret()) : null;
  if (!s) return MODELS.map(record);
  const { start, gift: known } = await plansOf(s, account.key).catch(() => ({ start: false, gift: null }));
  const gift = start ? await startPlan(s.jwt, s.device).catch(() => null) : known;
  const base = start ? START_BASE : s.base;
  const cfg = await zcodeConfig().catch(() => null);
  let ms = modelsOf(cfg, planID(base));
  if (!ms.length) ms = start ? START_MODELS : MODELS;
  const out = new Map(ms.map((m) => [m.id, record(m)]));
  const details = [...ms, ...modelsOf(cfg, planID(START_BASE)), ...modelsOf(cfg, planID(ZAI_BASE)), ...MODELS];
  const about = (raw) => details.find((m) => m.id.toLowerCase() === raw.toLowerCase()) ?? { efforts: [] };
  const has = new Set([...out.keys()].map((id) => id.toLowerCase()));
  for (const raw of giftNames(gift)) {
    // a gift-only account's models are its gift's, by their own names, as ZCode lists them (its Start Plan's GLM-5.3,
    // which the plan's config leaves out): every request of it goes to the gift anyway
    if (start && !has.has(raw.toLowerCase())) {
      const plain = about(raw).id ?? raw;
      has.add(raw.toLowerCase());
      out.set(plain, record({ ...about(raw), id: plain }));
    }
    const id = giftID(raw);
    if (!out.has(id)) out.set(id, record({ ...about(raw), id }));
  }
  return [...out.values()];
}
