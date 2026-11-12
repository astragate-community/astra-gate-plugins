// An account's tokens: how a sign-in is read, merged, refreshed and kept fresh. The pair lives in the account's secret.
import { providers } from 'astra';
import { API, PROVIDER, REFRESH_LEAD, RETRYABLE_GRACE, WORKOS_PREFIX } from './constants.js';
import { Lapsed, clineApi } from './api.js';
import { firstOf, safeJson } from './util.js';

/** Reads an account's secret: the JSON this plugin writes, or a bare string taken as an API key. */
export function authOf(secret) {
  const a = safeJson(secret ?? '');
  if (!a || typeof a !== 'object') return { type: 'api', key: typeof secret === 'string' ? secret.trim() : '' };
  const str = (v) => (typeof v === 'string' ? v : '');
  return {
    type: a.type === 'api' ? 'api' : 'oauth',
    access: str(a.access),
    refresh: str(a.refresh),
    expires: Number(a.expires) || 0,
    key: str(a.key),
    uid: str(a.uid),
    email: str(a.email),
    name: str(a.name),
    accountId: str(a.accountId),
  };
}

/** What an Authorization header carries: a signed-in account's access token with Cline's routing prefix, or the raw API key. */
export function bearerOf(a) {
  if (a?.type === 'api') return a.key;
  const access = typeof a?.access === 'string' ? a.access : '';
  if (!access) return '';
  return access.toLowerCase().startsWith(WORKOS_PREFIX) ? access : WORKOS_PREFIX + access;
}

// an expiry Cline sends as an ISO datetime; one it didn't send (or one that won't parse) is taken as an hour out
export function toMs(v) {
  const t = typeof v === 'string' ? Date.parse(v) : Number(v);
  return Number.isFinite(t) && t > Date.now() ? t : Date.now() + 60 * 60 * 1000;
}

/** Cline's token answer ({accessToken, refreshToken, expiresAt, userInfo}) as what this plugin keeps. */
export function parseAuth(data, fallbackRefresh = '') {
  const access = typeof data?.accessToken === 'string' ? data.accessToken : '';
  if (!access) return { error: 'Cline sent back no access token' };
  const refresh = firstOf(data?.refreshToken, fallbackRefresh);
  if (!refresh) return { error: 'Cline sent back no refresh token' };
  const ui = data?.userInfo && typeof data.userInfo === 'object' ? data.userInfo : {};
  const uid = firstOf(ui.clineUserId, ui.subject);
  const email = firstOf(ui.email);
  return { access, refresh, expires: toMs(data?.expiresAt), uid, email, name: firstOf(ui.name), accountId: firstOf(email, uid) };
}

/**
 * Trades the refresh token for a new pair; Cline rotates it, so the caller saves what comes back. A dead token is
 * refused as 400 invalid_grant (WorkOS's wording rides in the body), not 401 — that is the sign-in gone.
 */
export async function refresh(a) {
  if (!a.refresh) throw new Lapsed("Cline's refresh token is gone; sign in to Cline again");
  const data = await clineApi(`${API}/auth/refresh`, {
    method: 'POST',
    body: { refreshToken: a.refresh, grantType: 'refresh_token' },
    lapsed: (status, text) => [400, 401, 403].includes(status) && /invalid|expired|revoked|unauthorized/i.test(text),
  });
  const p = parseAuth(data, a.refresh);
  if (p.error) throw new Error(`Cline token refresh: ${p.error}`);
  return p;
}

const credOf = (a, renewed = false) => ({ ...a, bearer: bearerOf(a), renewed });

// The rotated pair, kept in memory beside what the account's secret says: the save may fail, and the next request must
// not spend a refresh token that was already spent. A spent refresh token → its chain's newest pair.
const held = new Map();

// Refreshes are serialized: the refresh token is single-use, and two requests renewing at once spend one and lose the other.
let lock = Promise.resolve();
const locked = (fn) => {
  const run = lock.then(fn, fn);
  lock = run.catch(() => {});
  return run;
};

const latest = (a) => {
  const h = held.get(a.refresh);
  return h ? { ...a, access: h.access, refresh: h.refresh, expires: h.expires } : a;
};

async function spend(account, a, r) {
  const p = await refresh(r);
  const next = { ...r, access: p.access, refresh: p.refresh, expires: p.expires, uid: p.uid || r.uid, email: p.email || r.email, name: p.name || r.name, accountId: r.accountId || p.accountId };
  const chain = held.get(a.refresh) ?? {};
  Object.assign(chain, { access: next.access, refresh: next.refresh, expires: next.expires });
  held.set(a.refresh, chain);
  held.set(r.refresh, chain);
  try {
    await providers.accounts.update(PROVIDER, account.key, {
      secret: JSON.stringify({ type: 'oauth', access: next.access, refresh: next.refresh, expires: next.expires, uid: next.uid, email: next.email, name: next.name, accountId: next.accountId }),
    });
  } catch {
    // held keeps the pair for this run
  }
  return next;
}

/**
 * The account's credential with a token still good: one near its end is renewed and the rotated pair saved back. A
 * transient refresh failure keeps the token that is still good; only a token that has actually expired is the sign-in
 * gone. `force` renews whatever the clock says (after the upstream refused the token).
 */
export const fresh = (account, force = false) =>
  locked(async () => {
    const a = authOf(await account.secret());
    if (a.type === 'api') {
      if (!a.key) throw new Lapsed('Cline: no API key; add one to the account');
      return { type: 'api', bearer: a.key, renewed: false, accountId: a.accountId };
    }
    if (!a.access && !a.refresh) throw new Lapsed('Cline: not signed in');
    const r = latest(a);
    if (!force) {
      if (a.access && a.expires - Date.now() > REFRESH_LEAD) return credOf(a);
      if (r.access && r.expires - Date.now() > REFRESH_LEAD) return credOf(r);
    }
    if (!r.refresh) throw new Lapsed("Cline's access token has expired and there is no refresh token; sign in to Cline again");
    try {
      return credOf(await spend(account, a, r), true);
    } catch (e) {
      if (!force && !e?.expired && r.access && r.expires - Date.now() > RETRYABLE_GRACE) return credOf(r);
      throw e;
    }
  });
