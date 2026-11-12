// Trae: the two realms (Trae CN and Trae international) as tables — hosts, client, versions, fallback models,
// which host a sign-in's named host may be — and the helpers that read the hosts a sign-in names.
// A v2 plugin reaches only the origins its manifest lists (net:), so a host a sign-in names is used only when it is
// one of those (an enterprise tenant's own host is not: that account uses the consumer hosts).
import { httpsParts } from './values.js';

export const TRAE_DOMAINS = ['trae.cn', 'trae.ai', 'mchost.guru'];
export const DAY = 24 * 3600 * 1000;
export const EARLY_MS = 2 * 60 * 1000; // a token this close to its end is renewed before it is used
export const MAX = '-max'; // the suffix of a model's Max: deepseek-v4.1-flash-max is deepseek-v4.1-flash in Max mode
export const CONTEXT = 128_000;

// traeHost is a host a sign-in named, when it is a well-formed https one on Trae's own domains (no port, no
// credentials), as origin plus any path; "" for anything else, which is then not taken
export function traeHost(h) {
  const u = httpsParts(h);
  if (!u) return '';
  if (!TRAE_DOMAINS.some((d) => u.host === d || u.host.endsWith('.' + d))) return '';
  return u.origin + u.path;
}

// authHostOf is the host a sign-in named for its tokens, when it named one on the site's own domain; "" otherwise
export function authHostOf(h, site) {
  const t = traeHost(h);
  if (!t) return '';
  const host = httpsParts(t).host;
  return host === site.webHost || host.endsWith('.' + site.webHost) ? t : '';
}

// accountOf keeps the account fields of the sign-in's user info that say what kind of account it is (tenant,
// enterprise, login type), plain values only and never anything that looks like a secret; nothing sends them
export function accountOf(info) {
  const out = {};
  for (const [k, v] of Object.entries(info ?? {})) {
    if (!/tenant|enterprise|saas|login|org|team|sso|^ent|usertype|accounttype/i.test(k)) continue;
    if (/token|secret|key|password|cookie|session|jwt/i.test(k)) continue;
    if (v === null || ['string', 'number', 'boolean'].includes(typeof v)) out[k] = v;
  }
  return out;
}

const hostOf = (u) => httpsParts(u)?.host ?? '';

// where each part of Trae CN is served
const CN_HOSTS = {
  web: 'https://www.trae.cn', // the authorization page
  auth: 'https://api.trae.cn', // tokens, the account, credits
  api: 'https://trae-api-cn.mchost.guru', // the models
};

const GLOBAL_HOSTS = {
  web: 'https://www.trae.ai',
  auth: 'https://growsg-normal.trae.ai',
  api: 'https://coresg-normal.trae.ai', // the models, SG
  us: 'https://coreva-normal.trae.ai', // the models, US
  pay: 'https://api-sg-central.trae.ai', // usage
  usPay: 'https://api-us-east.trae.ai', // usage, the US deployment
};

const US_REGION = /^US(?:[-_ ]|$)/;

export const SITES = {
  'trae-cn': {
    id: 'trae-cn',
    name: 'Trae CN',
    realm: 'Trae CN',
    webHost: 'trae.cn',
    hosts: CN_HOSTS,
    flow: 'signInCn',
    clientId: 'ono9krqynydwx5', // Trae CN's IDE
    appId: '6eefa01c-1036-4c7e-9ca5-d891f63bfcd8',
    ideVersion: '3.3.65', // named to the authorization page
    clientVersion: '0.1.69', // TRAE SOLO CN, as its ai-agent names itself
    clientVersionCode: '20260917',
    pluginVersion: '2.3.24254',
    brand: 'ASUS TUF Gaming A15 FA507RM_FA507RM',
    functions: ['chat_v3', 'solo_work_lite', 'solo_agent', 'solo_agent_lite'],
    // what Trae CN's chat_v3 is known to serve; the account's live list replaces it
    models: [
      { id: 'glm-5.2', name: 'GLM-5.2', context: 200_000, output: 32_000 },
      { id: 'glm-5', name: 'GLM-5' },
      { id: 'kimi-k2.6', name: 'Kimi K2.6', context: 256_000 },
      { id: 'qwen-3.7-plus', name: 'Qwen 3.7 Plus' },
      { id: 'DeepSeek-V4-Pro', name: 'DeepSeek V4 Pro' },
      { id: 'DeepSeek-V4-Flash', name: 'DeepSeek V4 Flash' },
    ],
    // the model host for an account: only Trae CN's own model host is reachable
    apiOf: () => CN_HOSTS.api,
    regionOf: () => '',
    usage: { kind: 'credits', path: '/trae/api/v2/pay/ide_user_ent_usage', label: 'credits', host: (site) => site.hosts.auth, body: { require_usage: true, req_source: 0 } },
  },
  'trae-global': {
    id: 'trae-global',
    name: 'Trae Global',
    realm: 'Trae Global',
    // its lists mark Auto-mode channels and pay-as-you-go twins is_invisible_to_user, which its picker hides
    hidesInvisible: true,
    webHost: 'trae.ai',
    hosts: GLOBAL_HOSTS,
    flow: 'signInGlobal',
    clientId: 'ono9krqynydwx5',
    appId: '6eefa01c-1036-4c7e-9ca5-d891f63bfcd8',
    ideVersion: '3.5.51',
    clientVersion: '0.1.69',
    clientVersionCode: '20260917',
    pluginVersion: '2.3.62834',
    brand: 'ASUS TUF Gaming A15 FA507RM_FA507RM',
    functions: ['chat_v3', 'solo_work_lite', 'solo_agent', 'solo_agent_lite'],
    models: [
      { id: 'gpt-5.4', name: 'GPT-5.4' },
      { id: 'gemini-3-flash', name: 'Gemini 3 Flash', context: 1_000_000 },
      { id: 'kimi-k2.5', name: 'Kimi K2.5', context: 256_000 },
      { id: 'minimax-m2', name: 'MiniMax M2' },
      { id: 'deepseek-v3.2', name: 'DeepSeek V3.2' },
    ],
    // the account's region (or a US host the sign-in named) selects the US deployment, else the SG one
    apiOf: (a) => {
      const host = hostOf(traeHost(a?.api));
      if (/coreva/i.test(host) || /api-us(?:[-.]|$)/i.test(host) || US_REGION.test(String(a?.region ?? '').toUpperCase())) return GLOBAL_HOSTS.us;
      return GLOBAL_HOSTS.api;
    },
    regionOf: (s) => String(s?.region ?? s?.aiRegion ?? s?.Region ?? s?.AIRegion ?? '').trim(),
    lapsed: [1001, '1001', 20101, '20101', 401, '401'],
    quota: [4008, '4008', 1005, '1005', 4011, '4011'],
    usage: {
      kind: 'dollar',
      path: '/trae/api/v1/pay/user_current_entitlement_list',
      label: 'usage',
      host: (site, a) => (/^US(?:[-_ ]|$)/i.test(String(a?.region ?? '')) || /api-us/i.test(String(a?.api ?? '')) ? site.hosts.usPay : site.hosts.pay),
      body: {},
    },
  },
};

// a host a sign-in names for the account's tokens is used only when it is one of the site's own hosts
export const authHostFor = (a, site) => {
  const h = authHostOf(a?.authHost, site);
  return h && Object.values(site.hosts).includes(h) ? h : site.hosts.auth;
};
