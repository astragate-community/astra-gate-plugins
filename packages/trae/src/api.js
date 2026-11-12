// Trae: calling the vendor — the IDE's headers, one of its JSON pages, the token renewal, its model lists.
import { crypto, http } from 'astra';
import { Expired, errorOf, lapsedCode } from './errors.js';
import { jwtExp, parseJSON, statusLine, whenOf } from './values.js';
import { accountOf } from './sites.js';

export const REQUEST_TIMEOUT = 20_000;

// headers are the IDE's, for the account and its device
export function ideHeaders(a, site, extra = {}) {
  return {
    'Content-Type': 'application/json',
    Authorization: `Cloud-IDE-JWT ${a.token}`,
    'X-Cloudide-Token': a.token,
    'x-ide-token': a.token,
    'x-uid': a.uid,
    'x-app-id': site.appId,
    'x-device-id': a.deviceId,
    'x-machine-id': a.machineId,
    'x-request-id': crypto.randomUUID(),
    'x-app-version': site.clientVersion,
    'x-app-version-code': site.clientVersionCode,
    'x-ide-version': site.clientVersion,
    'x-ide-version-code': site.clientVersionCode,
    'x-ide-version-type': 'stable',
    'x-device-cpu': 'AMD',
    'x-device-brand': site.brand,
    'x-device-type': 'windows',
    'x-os-version': 'Windows 10',
    'x-system-type': 'Windows',
    ...extra,
  };
}

const answer = async (res) => {
  const text = await res.text();
  return { status: res.status, text, v: parseJSON(text) };
};

// post asks one of Trae's JSON pages with the account
export async function post(a, site, url, body, extraHeaders = {}) {
  return answer(await http.fetch(url, { method: 'POST', headers: ideHeaders(a, site, { Accept: 'application/json', ...extraHeaders }), body: JSON.stringify(body), timeoutMs: REQUEST_TIMEOUT }));
}

// exchange trades a refresh token for a new Cloud-IDE-JWT, as the IDE does: the answer's Result holds the new token
// pair and the account. Trae issues a new refresh token each time and spends the old one.
export async function exchange(refresh, clientId, site, host = site.hosts.auth) {
  let res;
  try {
    res = await http.fetch(host.replace(/\/+$/, '') + '/cloudide/api/v3/trae/oauth/ExchangeToken', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ClientID: clientId || site.clientId, RefreshToken: refresh, ClientSecret: '-', UserID: '' }),
      timeoutMs: REQUEST_TIMEOUT,
    });
  } catch (e) {
    throw new Error(`${site.realm}: renewing the sign-in: ` + (e?.message ?? e));
  }
  const { status, text, v } = await answer(res);
  const r = v.Result ?? v.result ?? v;
  const token = r?.Token ?? r?.token ?? '';
  if (res.ok && token) {
    const info = parseJSON(r.UserInfo ?? r.userInfo);
    return {
      token,
      refresh: r.RefreshToken ?? r.refreshToken ?? refresh,
      expires: whenOf(r.TokenExpireAt ?? r.tokenExpireAt) || jwtExp(token),
      clientId: r.ClientID ?? r.clientId ?? clientId,
      uid: String(info.UserID ?? info.userId ?? r.UserID ?? ''),
      name: String(info.ScreenName ?? info.screenName ?? ''),
      api: info.Host ?? '',
      region: site.regionOf(info),
      account: accountOf(info),
    };
  }
  const e = errorOf(text);
  const msg = e.message || (text.trim() ? text.trim().slice(0, 200) : statusLine(status));
  // a refresh token Trae no longer takes (spent, revoked, past its end, or of another client) is a sign-in to make again
  if ([400, 401, 403].includes(status) || /refresh|expired|invalid|not matched|revoked|unauthori/i.test(msg) || String(e.code) === '10101') {
    throw new Expired(`${site.realm}'s sign-in has expired (${msg}); sign in again`);
  }
  throw new Error(`${site.realm}: renewing the sign-in: ${statusLine(status)} ${msg}`.trim());
}

// A model-list answer that turned the token away, or failed, is the error; else its body.
function listAnswer(r, site) {
  if (r.status === 401 || lapsedCode(errorOf(r.v).code, site)) throw new Expired(`${site.realm}'s sign-in has expired; sign in again`);
  if (r.status !== 200) throw new Error(`${site.realm} models: ${statusLine(r.status)}`);
  return r.v;
}

// batchLists is every chat function's model list in one ask, as TRAE SOLO CN's ai-agent asks (batch_get_detail_param):
// {function: entries}. null when Trae answers it with no lists.
export async function batchLists(a, site) {
  const v = listAnswer(await post(a, site, site.apiOf(a) + '/api/ide/v1/batch_get_detail_param', {
    functions: site.functions, agent_type: '', current_config_info: { config_name: '', is_custom_model: false },
    mode_type: 0, access_type: 0, ab_force_vids: '', ab_autotest_advanced_mode: 0, show_custom_model: true,
  }), site);
  const groups = v.function_configs ?? v.data?.function_configs;
  if (!Array.isArray(groups)) return null;
  const out = {};
  for (const g of groups) {
    const fn = String(g?.function ?? '');
    if (!site.functions.includes(fn) || !Array.isArray(g.config_info_list)) continue;
    out[fn] = [...(out[fn] ?? []), ...g.config_info_list.filter((m) => m?.config_name)];
  }
  return Object.keys(out).length ? out : null;
}

// listOf is one function's model list, as the IDE asks for it
export async function listOf(a, site, fn) {
  const v = listAnswer(await post(a, site, site.apiOf(a) + '/api/ide/v1/get_detail_param', {
    function: fn, config_names: null, need_prompt: false, current_config_info: null, poly_prompt: true, mode_type: null, agent_type: null,
  }), site);
  return (v.config_info_list ?? v.data?.config_info_list ?? []).filter((m) => m?.config_name);
}
