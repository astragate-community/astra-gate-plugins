// Trae: the browser sign-in — the IDE's own: the realm's authorization page, which sends the browser back to a callback
// on 127.0.0.1. A v2 plugin cannot listen on a port, so the callback address is not served: the browser shows it as a
// page that failed to load and the user pastes that address back (it carries the account's Cloud-IDE-JWT).
import { exchange } from './api.js';
import { accountOf, authHostOf } from './sites.js';
import { toAuth } from './session.js';
import { parseJSON, whenOf } from './values.js';

// the callback the authorization page is told to come back to; nothing listens there
export const CALLBACK = 'http://127.0.0.1:58472/authorize';

const enc = encodeURIComponent;

// authorizationUrl is the realm's authorization page, naming the device and where the browser comes back to
export function authorizationUrl(site, device, trace, callback = CALLBACK) {
  const q = {
    login_version: '1',
    auth_from: 'solo',
    login_channel: 'native_ide',
    plugin_version: site.pluginVersion,
    auth_type: 'local',
    client_id: site.clientId,
    redirect: '0',
    login_trace_id: trace,
    auth_callback_url: callback,
    machine_id: device.machineId,
    device_id: device.deviceId,
    x_device_id: device.deviceId,
    x_machine_id: device.machineId,
    x_device_brand: site.brand,
    x_device_type: 'windows',
    x_os_version: 'Windows 10 Pro',
    x_env: '',
    x_app_version: site.ideVersion,
    x_app_type: 'stable',
    // the enterprise (SaaS) sign-in is offered beside the personal one
    hide_saas_login: 'false',
  };
  return `${site.hosts.web}/authorization?` + Object.entries(q).map(([k, v]) => `${enc(k)}=${enc(v)}`).join('&');
}

// signedIn reads the callback's query (a Map): userJwt (the token pair) and userInfo (the account), or, from the
// older page, a refresh token alone, which is exchanged for the pair
export async function signedIn(q, device, site) {
  if (q.get('error')) throw new Error(q.get('error_description') || q.get('error'));
  const jwt = parseJSON(q.get('userJwt'));
  const info = parseJSON(q.get('userInfo'));
  const host = q.get('host') || info.Host || '';
  let s = {
    token: jwt.Token ?? jwt.token ?? '',
    refresh: jwt.RefreshToken ?? jwt.refreshToken ?? q.get('refreshToken') ?? '',
    expires: whenOf(jwt.TokenExpireAt ?? jwt.tokenExpireAt),
    clientId: jwt.ClientID ?? jwt.clientId ?? q.get('clientId') ?? site.clientId,
    uid: String(info.UserID ?? info.userId ?? q.get('userId') ?? ''),
    name: String(info.ScreenName ?? info.screenName ?? ''),
    api: host,
    region: site.regionOf(info),
    host,
    authHost: authHostOf(q.get('authHost') || q.get('auth_host') || info.AuthHost || info.authHost, site),
    account: accountOf(info),
  };
  if (!s.token && s.refresh) {
    const x = await exchange(s.refresh, s.clientId, site, s.authHost || site.hosts.auth);
    s = { ...s, ...x, uid: x.uid || s.uid, name: x.name || s.name, api: x.api || s.api, region: x.region || s.region, host: s.host || x.api, account: { ...x.account, ...s.account } };
  }
  if (!s.token) throw new Error(`${site.webHost} sent back no token`);
  if (!s.refresh) throw new Error(`${site.webHost} sent back no refresh token`);
  return toAuth({ ...s, ...device }, site);
}
