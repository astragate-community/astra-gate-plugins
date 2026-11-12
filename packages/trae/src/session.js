// Trae: an account's sign-in as kept, and its tokens — renewing them, and keeping them fresh.
// The sign-in lives in the plugin's own secrets (`auth:<provider>:<account key>`), the one place every caller —
// models, usage, refresh, the check-in job — reads and writes it; the host's per-account secret is only a placeholder.
import { crypto, secrets } from 'astra';
import { exchange } from './api.js';
import { Expired } from './errors.js';
import { DAY, EARLY_MS, authHostFor, authHostOf, traeHost } from './sites.js';
import { jwtExp } from './values.js';

export const authName = (site, key) => `auth:${site.id}:${key}`;

// the account key a sign-in is kept under: its uid, else its name
export const keyOf = (s) => String(s.uid || s.name || '');

const digits = (n) => {
  const bytes = crypto.randomBytes(n);
  return Array.from(bytes, (b, i) => (i === 0 ? 1 + (b % 9) : b % 10)).join('');
};
const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

// newDevice is the machine an account signs in from, made once at sign-in and named to the authorization page, then
// sent with every request: a fresh one each time is what the relays saw requests dropped for.
export const newDevice = () => ({ deviceId: digits(19), machineId: hex(crypto.randomBytes(16)) });

// normalise a stored (or just signed-in) sign-in to the shape the rest of the code reads
export function toAuth(s, site) {
  return {
    token: s.token,
    refresh: s.refresh,
    expires: s.expires || jwtExp(s.token) || Date.now() + DAY,
    uid: String(s.uid ?? ''),
    name: String(s.name ?? ''),
    clientId: s.clientId || site.clientId,
    deviceId: s.deviceId || '',
    machineId: s.machineId || '',
    api: traeHost(s.api) || '',
    region: site.regionOf(s),
    host: traeHost(s.host) || '',
    authHost: authHostOf(s.authHost, site),
    account: s.account && typeof s.account === 'object' ? s.account : {},
  };
}

export async function load(site, key) {
  const raw = await secrets.get(authName(site, key));
  if (!raw) return null;
  try {
    const a = toAuth(JSON.parse(raw), site);
    return a.token ? a : null;
  } catch {
    return null;
  }
}

export const save = (site, key, a) => secrets.set(authName(site, key), JSON.stringify(a));

// renewals under way, one to a refresh token (Trae spends it once)
const renewing = new Map();

// renew exchanges the account's refresh token and keeps the result
export function renew(site, key, a) {
  let r = renewing.get(a.refresh);
  if (!r) {
    r = (async () => {
      const x = await exchange(a.refresh, a.clientId, site, authHostFor(a, site));
      const got = { ...a, token: x.token, refresh: x.refresh, expires: x.expires || jwtExp(x.token) || Date.now() + DAY, clientId: x.clientId || a.clientId, renewed: true };
      await save(site, key, got);
      return got;
    })().finally(() => renewing.delete(a.refresh));
    renewing.set(a.refresh, r);
  }
  return r;
}

// fresh is the account with a token that has a while to go, renewed when it hasn't
export async function fresh(site, key) {
  const a = await load(site, key);
  if (!a) throw new Expired(`${site.realm}: not signed in`);
  if (!a.expires || a.expires - Date.now() > EARLY_MS || !a.refresh) return a;
  try {
    return await renew(site, key, a);
  } catch (e) {
    // a hiccup: the token in hand may still do
    if (!(e instanceof Expired) && a.expires > Date.now()) return a;
    throw e;
  }
}
