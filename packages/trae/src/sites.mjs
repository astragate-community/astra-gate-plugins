// Trae: the two realms (Trae CN and Trae international) as tables — hosts, client, versions, fallback models,
// which host a sign-in's named host may be — and the helpers that read the hosts a sign-in names.
import { MODEL, TRAE_DOMAINS } from "./constants.mjs"

// traeHost is a host a sign-in named, when it is a well-formed https one
// on Trae's own domains (no port, no credentials), as origin plus any path;
// "" for anything else, which is then not taken
export function traeHost(h) {
  try {
    const u = new URL(String(h ?? "").trim())
    if (u.protocol !== "https:" || u.username || u.password || u.port || u.search || u.hash) return ""
    const n = u.hostname.toLowerCase()
    if (!TRAE_DOMAINS.some((d) => n === d || n.endsWith("." + d))) return ""
    return (u.origin + u.pathname).replace(/\/+$/, "")
  } catch {
    return ""
  }
}

// authHostOf is the host a sign-in named for its tokens, when it named one
// on the site's own domain (an enterprise's may differ from the consumer
// one); "" when it named none, and the site's own is used
export function authHostOf(h, site) {
  const t = traeHost(h)
  if (!t) return ""
  const n = new URL(t).hostname
  return n === site.webHost || n.endsWith("." + site.webHost) ? t : ""
}

// accountOf keeps the account fields of the sign-in's user info that say
// what kind of account it is (tenant, enterprise, login type), plain values
// only and never anything that looks like a secret, for later use; nothing
// sends them
export function accountOf(info) {
  const out = {}
  for (const [k, v] of Object.entries(info ?? {})) {
    if (!/tenant|enterprise|saas|login|org|team|sso|^ent|usertype|accounttype/i.test(k)) continue
    if (/token|secret|key|password|cookie|session|jwt/i.test(k)) continue
    if (v === null || ["string", "number", "boolean"].includes(typeof v)) out[k] = v
  }
  return out
}

// a site's fallback list names only what differs from MODEL: the defaults go in here
const fallback = (models) => Object.fromEntries(Object.entries(models).map(([id, m]) => [id, { ...MODEL, ...m }]))

// where each part of Trae CN is served; tests point them at a fake
const CN_HOSTS = {
  web: "https://www.trae.cn", // the authorization page
  auth: "https://api.trae.cn", // tokens, the account, credits
  api: "https://trae-api-cn.mchost.guru", // the models
}

// whether a host named by a sign-in is one of Trae CN's model hosts: an https
// host on mchost.guru or named trae-api-…, as the consumer gateway is,
// or another trae.cn host than the consumer site's own (www, api,
// grow…), which an enterprise (SaaS) sign-in may name for its tenant
const cnModelHost = (h) => {
  const t = traeHost(h)
  if (!t) return false
  const n = new URL(t).hostname
  return /(^|\.)mchost\.guru$|^trae-api-/i.test(n) || (/\.trae\.cn$/i.test(n) && !/^(www|api|grow[^.]*)\./i.test(n))
}

// Trae international's US region: an account's region, or a host a sign-in named
const US_REGION = /^US(?:[-_ ]|$)/

const GLOBAL_HOSTS = {
  web: "https://www.trae.ai", // the authorization page
  auth: "https://growsg-normal.trae.ai", // tokens, the account
  api: "https://coresg-normal.trae.ai", // the models, SG
  us: "https://coreva-normal.trae.ai", // the models, US
  pay: "https://api-sg-central.trae.ai", // usage
  usPay: "https://api-us-east.trae.ai", // usage, the US deployment
}

export const SITES = {
  // Trae CN (trae.cn): the authorization page sends the browser back to a
  // callback on 127.0.0.1 with the account's Cloud-IDE-JWT and refresh
  // token; the refresh token is exchanged for a new JWT at
  // /cloudide/api/v3/trae/oauth/ExchangeToken; model requests go to the IDE
  // agent's /api/agent/v3/llm_utils_chat, which answers in its own SSE
  // events. Worked out from two open-source relays (wangqi233/trae2api and
  // autumnsentiment/Trae2api-cn); not run against a real account here.
  // The account's fetch also sends Trae CN's own pages on api.trae.cn
  // (/trae/api/…) as the account, for magpie's daily check-in (每日签到:
  // /trae/api/v2/ug/checkin_credits/status, then /claim).
  "trae-cn": {
    id: "trae-cn",
    name: "Trae CN",
    realm: "Trae CN", // the name the errors and messages carry
    webHost: "trae.cn", // the bare host the sign-in copy names
    hosts: CN_HOSTS,
    clientId: "ono9krqynydwx5", // Trae CN's IDE
    // the clients' own renewal, which binds the JWT to a device: ExchangeToken
    // under /trae/api/v3/oauth, signed with the device's P-256 key
    // (DeviceProof). A JWT renewed at /cloudide/… carries no device, and
    // Trae CN answers its check-in claim 9074 「当前参与用户太多」 every time,
    // while the client's own token is let through (mintonight's side-by-side
    // on yetone/magpie#808). Tried as TRAE SOLO CN first, the one
    // qilimixingkong/trae-checkin found the server takes, then as Trae CN's
    // IDE. It doesn't spend the refresh token.
    deviceExchange: {
      path: "/trae/api/v3/oauth/ExchangeToken",
      as: [
        { clientId: "en1oxy7wnw8j9n", platform: "SOLO_PC", version: "0.1.64" },
        { clientId: "ono9krqynydwx5", platform: "IDE_PC", version: "3.3.99" },
      ],
    },
    appId: "6eefa01c-1036-4c7e-9ca5-d891f63bfcd8",
    ideVersion: "3.3.65", // named to the authorization page
    ideVersionCode: "20260401",
    // the client the model host is told it serves: TRAE SOLO CN 0.1.69, as
    // its ai-agent names itself (same app id). Trae offers a model only to
    // clients new enough for it, and an April IDE was offered no
    // deepseek-v4.1-flash.
    clientVersion: "0.1.69",
    clientVersionCode: "20260917",
    pluginVersion: "2.3.24254",
    brand: "ASUS TUF Gaming A15 FA507RM_FA507RM",
    // the IDE's chat functions: the classic IDE's agent, then SOLO's Work
    // mode, then the TRAE agent (solo_agent, which has deepseek-v4.1-flash),
    // then SOLO Lite's agent
    functions: ["chat_v3", "solo_work_lite", "solo_agent", "solo_agent_lite"],
    // what Trae CN's chat_v3 is known to serve; the live list replaces it
    models: fallback({
      "glm-5.2": { name: "GLM-5.2", limit: { context: 200_000, output: 32_000 } },
      "glm-5": { name: "GLM-5" },
      "kimi-k2.6": { name: "Kimi K2.6", limit: { context: 256_000, output: 0 } },
      "qwen-3.7-plus": { name: "Qwen 3.7 Plus" },
      "DeepSeek-V4-Pro": { name: "DeepSeek V4 Pro" },
      "DeepSeek-V4-Flash": { name: "DeepSeek V4 Flash" },
    }),
    // the model host for an account: Trae CN's own hosts serve no models,
    // so only a host that is one is taken, else the one gateway
    apiOf: (a) => {
      const h = traeHost(a?.api)
      return h && cnModelHost(h) ? h : CN_HOSTS.api
    },
    modelHost: cnModelHost,
    // ownPage: url is one of Trae CN's own JSON pages on api.trae.cn
    // (/trae/api/…: the daily check-in, credits), which the account's fetch
    // sends as the account rather than as a chat
    ownPage: (url) => {
      try {
        const u = new URL(url)
        return u.origin === new URL(CN_HOSTS.auth).origin && u.pathname.startsWith("/trae/api/")
      } catch {
        return false
      }
    },
    // Trae CN's account info carries no region: its one deployment is the
    // one it is asked through
    regionOf: () => "",
    // where usage is asked, and which page it is (CN: credits; read by usage.mjs)
    usage: {
      kind: "credits",
      path: "/trae/api/v2/pay/ide_user_ent_usage",
      label: "credits",
      host: (site) => site.hosts.auth,
      body: { require_usage: true, req_source: 0 },
    },
  },
  // Trae international (trae.ai): the same IDE sign-in flow against the
  // international deployment. Its own authorization page, its own auth and
  // chat hosts, a second (US) deployment the account's region selects, and
  // the dollar billing's entitlements rather than the CN credits page.
  // Worked out from the realm table of wangqi233/trae2api (cn/sg dual-region)
  // and the login URL of wefew/trae2api; run against one Free SG account.
  "trae-global": {
    id: "trae-global",
    name: "Trae Global",
    realm: "Trae Global",
    // its lists mark Auto-mode channels and pay-as-you-go twins
    // is_invisible_to_user, which its picker hides; Trae CN's lists are
    // served whole, as they were before Global joined this package
    hidesInvisible: true,
    webHost: "trae.ai",
    hosts: GLOBAL_HOSTS,
    clientId: "ono9krqynydwx5",
    appId: "6eefa01c-1036-4c7e-9ca5-d891f63bfcd8",
    ideVersion: "3.5.51", // named to the international IDE's current build
    ideVersionCode: "20260401",
    clientVersion: "0.1.69",
    clientVersionCode: "20260917",
    pluginVersion: "2.3.62834",
    brand: "ASUS TUF Gaming A15 FA507RM_FA507RM",
    functions: ["chat_v3", "solo_work_lite", "solo_agent", "solo_agent_lite"],
    // what Trae Global's chat is known to serve (its catalog barely overlaps
    // the CN one's); the live list replaces it
    models: fallback({
      "gpt-5.4": { name: "GPT-5.4" },
      "gemini-3-flash": { name: "Gemini 3 Flash", limit: { context: 1_000_000, output: 0 } },
      "kimi-k2.5": { name: "Kimi K2.5", limit: { context: 256_000, output: 0 } },
      "minimax-m2": { name: "MiniMax M2" },
      "deepseek-v3.2": { name: "DeepSeek V3.2" },
    }),
    // the model host: the account's region (or a US host the sign-in named)
    // selects the US deployment, else the SG one
    apiOf: (a) => {
      const h = traeHost(a?.api)
      const n = h ? new URL(h).hostname : ""
      const region = String(a?.region ?? "").toUpperCase()
      if (/coreva/i.test(n) || /api-us(?:[-.]|$)/i.test(n) || US_REGION.test(region)) return GLOBAL_HOSTS.us
      if (/coresg/i.test(n)) return h
      // another trae.ai host than the site's own (www, api-…, grow…): one an
      // enterprise (SaaS) sign-in named for its tenant
      if (/\.trae\.ai$/i.test(n) && !/^(www\.|api[-.]|grow)/i.test(n)) return h
      return GLOBAL_HOSTS.api
    },
    // a sign-in names a host of Trae's, which can be an auth host
    // (api-us-east), not the chat host
    modelHost: (h) => {
      const t = traeHost(h)
      return !!t && /(^|\.)trae\.ai$/i.test(new URL(t).hostname)
    },
    // Trae Global serves no own JSON pages through the account's fetch
    ownPage: () => false,
    // the account's region, from the sign-in's user info
    regionOf: (s) => String(s?.region ?? s?.aiRegion ?? s?.Region ?? s?.AIRegion ?? "").trim(),
    // the international deployment also answers these
    lapsed: [1001, "1001", 20101, "20101", 401, "401"],
    quota: [4008, "4008", 1005, "1005", 4011, "4011"],
    // where usage is asked, and which page it is (Global: the dollar
    // billing's entitlements; read by usage.mjs)
    usage: {
      kind: "dollar",
      path: "/trae/api/v1/pay/user_current_entitlement_list",
      label: "usage",
      // the US account pays on its own host, the rest on the central one —
      // the auth host's own /cloudide/api/v2/pay pages answer 403 Api Scope
      // Forbidden here
      host: (site, a) => (/^US(?:[-_ ]|$)/i.test(String(a?.region ?? "")) || /api-us/i.test(String(a?.api ?? "")) ? site.hosts.usPay : site.hosts.pay),
      body: {},
    },
  },
}
