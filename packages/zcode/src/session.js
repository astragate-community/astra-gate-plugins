// An account's stored sign-in as the requests need it. The host keeps one secret per account; here it is the sign-in's
// state as JSON: { site, base, key, jwt, token, org, project, plan, device, locale, tz, utc }.
import { providers } from 'astra';
import { device } from './api.js';
import { EXPIRED, PROVIDER } from './constants.js';
import { teamKey } from './keys.js';
import { SITES, siteOf } from './sites.js';
import { b64urlText, isTeam } from './util.js';

export function jwtExpiry(jwt) {
  const p = String(jwt ?? '').split('.');
  if (p.length !== 3) return 0;
  try {
    const claims = JSON.parse(b64urlText(p[1]));
    return Number(claims.exp) > 0 ? Number(claims.exp) * 1000 : 0;
  } catch {
    return 0;
  }
}
export const jwtExpired = (jwt) => {
  const t = jwtExpiry(jwt);
  return t > 0 && Date.now() > t;
};
export { EXPIRED };

/** The state a secret holds, filled in: the site, its base and a device id. */
export function stateOf(secret) {
  let s;
  try {
    s = JSON.parse(secret);
  } catch {
    return null;
  }
  if (!s || typeof s !== 'object') return null;
  const site = siteOf(s.site);
  return { ...s, site, base: s.base || SITES[site].base, key: typeof s.key === 'string' ? s.key.trim() : '', device: s.device || device() };
}

/** The key a state sends with: a team seat's, made when the sign-in kept none, then written back to the account. */
export async function keyOf(s, accountKey) {
  if (!isTeam(s) || s.key) return s.key;
  const key = await teamKey(s);
  if (accountKey) {
    const { device: _d, ...stored } = s;
    await providers.accounts.update(PROVIDER, accountKey, { secret: JSON.stringify({ ...stored, device: s.device, key }) }).catch(() => {});
  }
  return key;
}
