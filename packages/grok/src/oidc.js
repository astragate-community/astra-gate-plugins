// The xAI sign-in (OpenID Connect at auth.x.ai): the device-code flow and the refresh-token grant, as the standards write
// them (RFC 8628, OIDC Core). Endpoints come from the issuer's discovery document, with the known ones as a fallback.
import { http } from 'astra';
import { CLIENT_ID, FALLBACK_ENDPOINTS, ISSUER, SCOPE } from './constants.js';
import { jwtClaims, obj, pos, str } from './values.js';

export class OAuthError extends Error {
  constructor(code, status, message) {
    super(message ?? `xAI's sign-in server said ${code}${status ? ` (HTTP ${status})` : ''}`);
    this.code = code;
    this.httpStatus = status;
  }
}

let discovered; // a cache: the plugin may be unloaded at any time

/** The issuer's endpoints. Only endpoints at the issuer's own origin are used (that is all the plugin may reach). */
export async function endpoints() {
  if (discovered) return discovered;
  let found = {};
  try {
    const res = await http.fetch(ISSUER + '/.well-known/openid-configuration', { timeoutMs: 10000, redirect: 'error' });
    if (res.ok) found = obj(await res.json()) ?? {};
  } catch {}
  const own = (v, fallback) => (typeof v === 'string' && v.startsWith(ISSUER + '/') ? v : fallback);
  discovered = {
    device_authorization_endpoint: own(found.device_authorization_endpoint, FALLBACK_ENDPOINTS.device_authorization_endpoint),
    token_endpoint: own(found.token_endpoint, FALLBACK_ENDPOINTS.token_endpoint),
  };
  return discovered;
}

export const forgetEndpoints = () => (discovered = undefined);

/** Posts an OAuth form; ok is false when the answer is an HTTP error or carries an "error". */
export async function postForm(url, fields) {
  const res = await http.fetch(url, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields).toString(),
    timeoutMs: 30000,
    redirect: 'error',
  });
  let body;
  try {
    body = obj(JSON.parse(await res.text()));
  } catch {}
  if (!body) throw new OAuthError('invalid_json_response', res.status);
  const error = str(body, 'error');
  return { ok: res.status >= 200 && res.status < 300 && !error, status: res.status, body, error };
}

/** A token answer as a credential; `keep` is the refresh token to keep when none is sent, `clientId` the client it is for. */
export function credentialOf(body, { keep, clientId = CLIENT_ID } = {}) {
  const key = str(body, 'access_token');
  const expiresIn = pos(body, 'expires_in');
  if (!key || !expiresIn) throw new OAuthError('invalid_token_response');
  const claims = jwtClaims(str(body, 'id_token')) ?? jwtClaims(key);
  return {
    key,
    refresh: str(body, 'refresh_token') ?? keep ?? '',
    expires: Date.now() + expiresIn * 1000,
    email: str(claims, 'email') ?? '',
    userId: str(claims, 'sub') ?? '',
    clientId,
  };
}

/** Trades a refresh token for a new access token (a refresh token may be spent once: the answer holds the next). */
export async function refreshGrant(cred) {
  const r = await postForm((await endpoints()).token_endpoint, { grant_type: 'refresh_token', refresh_token: cred.refresh, client_id: cred.clientId || CLIENT_ID });
  if (!r.ok) throw new OAuthError(r.error ?? 'oauth_request_failed', r.status);
  const got = credentialOf(r.body, { keep: cred.refresh, clientId: cred.clientId });
  return { ...got, email: got.email || cred.email, userId: got.userId || cred.userId };
}

/** Starts the device-code flow. */
export async function startDevice() {
  const r = await postForm((await endpoints()).device_authorization_endpoint, { client_id: CLIENT_ID, scope: SCOPE });
  if (!r.ok) throw new OAuthError(r.error ?? 'oauth_request_failed', r.status);
  const b = r.body;
  const deviceCode = str(b, 'device_code');
  const userCode = str(b, 'user_code');
  const uri = str(b, 'verification_uri_complete') ?? str(b, 'verification_uri') ?? str(b, 'verification_url');
  if (!deviceCode || !userCode || !uri) throw new OAuthError('invalid_device_authorization_response');
  return { deviceCode, userCode, url: uri, deadline: Date.now() + (pos(b, 'expires_in') ?? 600) * 1000, intervalMs: (pos(b, 'interval') ?? 5) * 1000 };
}

const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';

/**
 * Polls for the sign-in until it is done (the credential), refused or past its end. With `budgetMs` it gives up waiting
 * after that long and returns null: the device is still good, ask again.
 */
export async function pollDevice(d, sleep, budgetMs = Infinity) {
  const until = Date.now() + budgetMs;
  const url = (await endpoints()).token_endpoint;
  while (Date.now() < d.deadline) {
    if (Date.now() + d.intervalMs > until) return null;
    await sleep(d.intervalMs);
    const r = await postForm(url, { grant_type: DEVICE_GRANT, device_code: d.deviceCode, client_id: CLIENT_ID });
    if (r.ok) return credentialOf(r.body);
    if (r.error === 'authorization_pending') continue;
    if (r.error === 'slow_down') {
      d.intervalMs += 5000;
      continue;
    }
    if (r.error === 'access_denied') throw new OAuthError('access_denied', r.status, 'the sign-in was turned down');
    if (r.error === 'expired_token') throw new OAuthError('expired_token', r.status, 'the sign-in code expired');
    throw new OAuthError(r.error ?? 'device_authorization_failed', r.status);
  }
  throw new OAuthError('expired_token', 0, 'the sign-in code expired');
}
