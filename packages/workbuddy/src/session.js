// WorkBuddy: an account's tokens — merging, refreshing and keeping them fresh. An account's credential is the JSON of
// its sign-in ({ access, refresh, expires, refreshExpiresAt, domain, tokenType, uid, enterpriseId }), kept by the host
// as the account's secret; a refresh writes the new tokens back the same way.
import { crypto, providers, secrets } from 'astra';
import { EARLY_MS, KEEP_RENEWED_MS, PREPARE_TIMEOUT_MS } from './constants.js';
import { call, domainOf, enterpriseHeaders } from './api.js';

/** The sign-in an account holds, null when it holds none that reads. */
export async function authOf(account) {
  try {
    const a = JSON.parse((await account?.secret()) ?? 'null');
    return a && typeof a === 'object' && typeof a.access === 'string' ? a : null;
  } catch {
    return null;
  }
}

// merge takes a token WorkBuddy gave (sign-in or refresh) into the stored sign-in, times given as at-ms or in-seconds.
export function merge(a, got) {
  const now = Date.now();
  const out = { ...a, access: got.accessToken };
  if (got.refreshToken) out.refresh = got.refreshToken;
  if (got.domain) out.domain = got.domain;
  if (got.tokenType) out.tokenType = got.tokenType;
  if (got.expiresAt > 0) out.expires = got.expiresAt;
  else if (got.expiresIn > 0) out.expires = now + got.expiresIn * 1000;
  if (got.refreshExpiresAt > 0) out.refreshExpiresAt = got.refreshExpiresAt;
  else if (got.refreshExpiresIn > 0) out.refreshExpiresAt = now + got.refreshExpiresIn * 1000;
  return out;
}

const stale = (a) => !!a.expires && Date.now() >= a.expires - EARLY_MS;

// renewing is each refresh under way, by site and the refresh token it spends; renewed is what each gave, kept a minute
// so one that read the old refresh token after it was spent takes that rather than spending it again. Caches only: a
// replaced engine starts them empty and the stored secret is the truth.
const renewing = new Map();
const renewed = new Map();

export const refreshable = (a) => !!a.refresh && !(a.refreshExpiresAt && Date.now() >= a.refreshExpiresAt);

const TOKEN_FIELDS = ['access', 'refresh', 'expires', 'refreshExpiresAt', 'domain', 'tokenType'];
const merged = (a, next) => {
  const out = { ...a };
  for (const k of TOKEN_FIELDS) if (k in next) out[k] = next[k];
  return out;
};

// renew spends a's refresh token, once: those who come while it runs, or within KEEP_RENEWED_MS of it, get what it
// gave. `save` keeps the result.
function renew(site, a, save, timeoutMs) {
  const key = site.id + '\n' + a.refresh;
  const done = renewed.get(key);
  if (done && Date.now() - done.at < KEEP_RENEWED_MS) return Promise.resolve(merged(a, done.next));
  let r = renewing.get(key);
  if (!r) {
    r = (async () => {
      const got = await call(
        site,
        'POST',
        '/v2/plugin/auth/token/refresh',
        { 'X-Refresh-Token': a.refresh, 'X-Auth-Refresh-Source': 'plugin', 'X-Domain': domainOf(site, a), ...enterpriseHeaders(a) },
        {},
        timeoutMs,
      );
      if (!got?.accessToken) throw Object.assign(new Error('WorkBuddy gave no refreshed token'), { bare: true });
      const next = merge(a, got);
      renewed.set(key, { next, at: Date.now() });
      await save?.(next);
      return next;
    })().finally(() => renewing.delete(key));
    renewing.set(key, r);
  }
  return r.then((next) => merged(a, next));
}

/** Where the plugin keeps its own copy of an account's sign-in, for the jobs that run outside a request (the check-in). */
export const mirrorName = (site, key) => `auth.${site.id}.${crypto.sha256(key).slice(0, 24)}`;

/** Writes an account's sign-in: the host's credential for the account, and the plugin's own copy. */
export async function keepAuth(site, key, auth, extra = {}) {
  const secret = JSON.stringify(auth);
  await providers.accounts.update(site.id, key, { ...extra, secret });
  await secrets.set(mirrorName(site, key), secret);
}

const saver = (site, account) => async (next) => {
  try {
    await keepAuth(site, account.key, next);
  } catch {
    // the tokens still serve this request; the next one refreshes again
  }
};

/**
 * The account's sign-in with an access token that isn't about to end: refreshed (and saved) when it is. A refresh that
 * fails, or a refresh token that has ended, leaves the access token there is. Its failures are worded as the built-in's
 * (wbFresh), "WorkBuddy" on both sites.
 */
export async function current(site, account, timeoutMs = PREPARE_TIMEOUT_MS) {
  const a = await authOf(account);
  if (!a) throw new Error(`${site.name} isn't signed in; sign in again`);
  if (!stale(a)) return a;
  if (!refreshable(a)) {
    if (a.access) return a;
    throw new Error('this WorkBuddy account is signed out; sign in again');
  }
  try {
    return await renew(site, a, saver(site, account), timeoutMs);
  } catch (e) {
    if (a.access) return a;
    if (e?.bare) throw e;
    throw new Error(`WorkBuddy token refresh: ${e?.said ?? e?.message ?? e}`);
  }
}

/**
 * The provider's `refresh`, after a 401 / 403: spends the refresh token whatever the access token's clock says.
 * 'renewed' when WorkBuddy gave a new token; nothing when there is nothing to renew or it failed — a WorkBuddy account
 * is never marked expired (the built-in never marked one lapsed), a refresh token that has ended is said by the next
 * request's own error.
 */
export async function refreshed(site, account) {
  const a = await authOf(account);
  if (!a || !refreshable(a)) return undefined;
  try {
    await renew(site, a, saver(site, account), 15000);
    return 'renewed';
  } catch {
    return undefined;
  }
}
