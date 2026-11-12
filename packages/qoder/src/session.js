// Qoder: an account's tokens — refreshing them and keeping them fresh. The host keeps one secret per account; here it is the
// sign-in as JSON: { access, refresh, expires, uid, email, name, machineId, deviceToken, deviceRefresh, deviceChat }.
// Qoder spends a refresh token once, so the new pair is saved straight away, under a lock.
import { providers } from 'astra';
import { DAY, REFRESH_LEAD } from './constants.js';
import { openapi } from './api.js';
import { SignInGone } from './errors.js';
import { blank } from './util.js';

// expiresAt is when a job token Qoder gave with expires_in (milliseconds) runs out; a day when it said none.
export const expiresAt = (jt) => Date.now() + (jt.expires_in > 0 ? jt.expires_in : DAY);

// deviceExpiry is when a device token used for chat runs out: its expires_at (a date) or expires_in (seconds); a day when neither.
export function deviceExpiry(dt) {
  const at = Date.parse(String(dt?.expires_at ?? '').trim());
  if (!isNaN(at)) return at;
  if (dt?.expires_in > 0) return Date.now() + dt.expires_in * 1000;
  return Date.now() + DAY;
}

const lapsed = (site) => new SignInGone(`${site.name}: the sign-in lapsed; sign in again`);

// refreshJob trades the job token's refresh token for a new pair; the old one is spent.
export async function refreshJob(site, refresh, user) {
  if (blank(refresh)) throw lapsed(site);
  const r = await openapi(site, '/api/v1/jobToken/refresh', { method: 'POST', body: { refresh_token: refresh } });
  if (r.status === 401 || r.status === 403) throw new SignInGone(`${user}'s ${site.name} sign-in has expired — sign in again (qoder job token refresh: status ${r.status})`, true);
  if (r.status !== 200) throw new Error(`qoder job token refresh: status ${r.status}`);
  if (blank(r.json?.token) || blank(r.json?.refresh_token)) throw new Error('qoder job token refresh: incomplete token pair');
  return r.json;
}

// refreshDevice trades the device refresh token for a new pair (the device token that is the chat token too, on Qoder CN).
export async function refreshDevice(site, refresh) {
  if (blank(refresh)) throw lapsed(site);
  let r;
  try {
    r = await openapi(site, '/api/v1/deviceToken/refresh', { method: 'POST', body: { refresh_token: refresh } });
  } catch (e) {
    throw new Error(`qoder device token refresh: request failed: ${e?.message ?? e}`);
  }
  if (r.status !== 200) {
    const err = `qoder device token refresh: upstream HTTP ${r.status}`;
    if (r.status === 401 || r.status === 403) throw new SignInGone(`${site.name} sign-in has expired — sign in again (${err})`, true);
    throw new Error(err);
  }
  const token = r.json?.token || r.json?.device_token || '';
  if (blank(token) || blank(r.json?.refresh_token)) throw new Error('qoder device token refresh: incomplete token pair');
  return { token, refresh: r.json.refresh_token, expires: deviceExpiry(r.json) };
}

export function readSecret(text) {
  try {
    const c = JSON.parse(String(text ?? ''));
    return c && typeof c === 'object' ? c : null;
  } catch {
    return null;
  }
}

// renew spends a's chat refresh token: the fields it changes.
async function renew(site, a) {
  if (a.deviceChat) {
    const dt = await refreshDevice(site, a.refresh);
    return { access: dt.token, refresh: dt.refresh, expires: dt.expires, deviceToken: dt.token, deviceRefresh: dt.refresh };
  }
  const jt = await refreshJob(site, a.refresh, a.email || a.uid);
  return { access: jt.token, refresh: jt.refresh_token, expires: expiresAt(jt) };
}

// one refresh at a time: a refresh token is spent once, so two refreshes would spend it twice
let lock = Promise.resolve();
const locked = (fn) => {
  const run = lock.then(fn, fn);
  lock = run.catch(() => {});
  return run;
};

/**
 * The account with a live chat token: refreshed and saved near its end (or, with `force`, always: Qoder just turned it down).
 * Throws a SignInGone when the sign-in can't be used (`expired` when Qoder refused the refresh token).
 */
export const creds = (site, account, { force = false } = {}) =>
  locked(async () => {
    if (!account) throw new SignInGone(`${site.name}: this account is not there; add it again`);
    const a = readSecret(await account.secret());
    if (!a?.access || !a.uid) throw new SignInGone(`${site.name}: not signed in`);
    if (!force && a.expires - Date.now() > REFRESH_LEAD) return a;
    const next = { ...a, ...(await renew(site, a)) };
    await providers.accounts.update(site.id, account.key, { secret: JSON.stringify(next), status: 'active' });
    return next;
  });
