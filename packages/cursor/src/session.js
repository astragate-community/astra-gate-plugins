// An account's token: a JWT's expiry, an API key's exchange, and the token a sign-in stands for. The host keeps one
// secret per account; here it is JSON: { type: "oauth", access, expires } (a browser sign-in) or { type: "api", key }.
import { crypto, http, storage } from 'astra';
import { API, SOON } from './constants.js';
import { headersFor } from './api.js';
import { AuthError, httpError } from './errors.js';
import { expiry } from './jwt.js';

/** The sign-in an account's secret holds, or null. */
export function authOf(secret) {
  try {
    const a = JSON.parse(secret);
    return a && typeof a === 'object' ? a : null;
  } catch {
    return null;
  }
}

// keyToken is the access token for a Cursor API key, as the CLI gets it for CURSOR_API_KEY:
// /auth/exchange_user_api_key, again when it runs out. The token is kept in storage under the key's hash.
export async function keyToken(key) {
  const id = 'exchanged:' + crypto.sha256(key);
  const had = await storage.get(id);
  if (had && (!had.exp || had.exp - Date.now() > SOON)) return had.tok;
  let res;
  try {
    res = await http.fetch(API + '/auth/exchange_user_api_key', { method: 'POST', headers: { ...headersFor(key), 'connect-protocol-version': '' }, body: '{}', timeoutMs: 15_000 });
  } catch (e) {
    throw httpError("couldn't reach Cursor's API: " + e.message, 502);
  }
  if (res.status >= 500) throw httpError(`exchange_user_api_key: HTTP ${res.status}`, 502);
  const j = res.ok ? await res.json().catch(() => null) : null;
  if (!j?.accessToken) throw new AuthError("Cursor didn't take this API key");
  await storage.set(id, { tok: j.accessToken, exp: expiry(j.accessToken) });
  return j.accessToken;
}

/** The token to call Cursor's API with, for an account's secret. */
export async function tokenOf(secret) {
  const auth = authOf(secret);
  if (auth?.type === 'api' && auth.key) return keyToken(auth.key);
  if (auth?.type !== 'oauth' || !auth.access) throw new AuthError("Cursor isn't signed in");
  const exp = auth.expires || expiry(auth.access);
  // Cursor's sign-in has nothing to renew it with: cursor-agent itself signs in again when it runs out (about two months)
  if (exp && exp <= Date.now()) throw new AuthError("Cursor's sign-in has run out; sign in to Cursor again");
  return auth.access;
}
