// An account's sign-in over time. The account's credential (the host-held secret) is this JSON:
// { key, refresh, expires, email, userId, clientId } — the access token, the refresh token, when the access token ends.
import { providers } from 'astra';
import { KEEP_RENEWED_MS, PROVIDER, REFRESH_MARGIN } from './constants.js';
import { OAuthError, refreshGrant } from './oidc.js';
import { obj } from './values.js';

export class SignInExpired extends Error {
  constructor() {
    super("Grok's sign-in has expired; sign in again");
    this.signIn = 'expired';
  }
}

/** Reads an account's credential back, or null when it isn't one. */
export function parseSecret(text) {
  try {
    const v = obj(JSON.parse(text));
    return v && typeof v.key === 'string' && v.key ? v : null;
  } catch {
    return null;
  }
}

/** Only an invalid_grant (HTTP 400) means the refresh token is no good; anything else is passing. */
export const signedOut = (e) => e instanceof OAuthError && e.code === 'invalid_grant';

// A refresh token is spent once: `renewing` is each refresh under way (by the refresh token it spends) and `renewed` what
// it gave, kept a minute once saved so a request that read the old credential joins it, and for good when the save failed.
// (Caches: the saved secret is what survives an unloaded plugin.)
export const renewing = new Map();
export const renewed = new Map();

/** The credential with the newest tokens this process got for it. */
export function latest(cred) {
  for (let i = 0; i < 16 && cred.refresh; i++) {
    const done = renewed.get(cred.refresh);
    if (!done || (done.saved && Date.now() - done.at >= KEEP_RENEWED_MS)) break;
    cred = { ...cred, ...done.got };
  }
  return cred;
}

/** Spends the credential's refresh token, once: those who come while it runs wait for it. `save` keeps what it gave, saying whether it could. */
export function renew(cred, save) {
  let r = renewing.get(cred.refresh);
  if (!r) {
    r = (async () => {
      const got = await refreshGrant(cred);
      const done = { got, at: Date.now(), saved: false };
      renewed.set(cred.refresh, done);
      done.saved = await save({ ...cred, ...got });
      done.at = Date.now();
      return got;
    })().finally(() => renewing.delete(cred.refresh));
    renewing.set(cred.refresh, r);
  }
  return r;
}

/** Saves a credential on the account, saying whether it could. */
export const saverOf = (accountKey) => async (cred) => {
  try {
    await providers.accounts.update(PROVIDER, accountKey, { secret: JSON.stringify(cred), email: cred.email || undefined });
    return true;
  } catch {
    return false;
  }
};

/**
 * The credential with a token that isn't about to end: renewed (and saved) when it is, or when `force` says the backend
 * turned the last one away. `getAuth` reads the stored one. Returns { cred, renewed }.
 */
export async function fresh(getAuth, save, { force = false, again = false } = {}) {
  const stored = await getAuth();
  if (!stored) throw new Error('Grok is not signed in');
  const cred = latest(stored);
  const newer = cred.key !== stored.key;
  if (!force && !(cred.expires && cred.expires - Date.now() < REFRESH_MARGIN)) return { cred, renewed: newer };
  if (!cred.refresh) {
    if (cred.expires > Date.now() && !force) return { cred, renewed: newer };
    throw new SignInExpired();
  }
  try {
    return { cred: { ...cred, ...(await renew(cred, save)) }, renewed: true };
  } catch (e) {
    if (signedOut(e)) {
      // spent by someone else, who saved the new one: that one is used
      const now = again ? undefined : await getAuth().catch(() => undefined);
      if (now?.refresh && now.refresh !== cred.refresh && now.refresh !== stored.refresh) return fresh(getAuth, save, { force, again: true });
      throw new SignInExpired();
    }
    // passing: the token in hand may still do
    if (!force && cred.expires > Date.now()) return { cred, renewed: newer };
    throw Object.assign(new Error(`Grok token refresh: ${e?.message ?? e}`), { signIn: 'kept' });
  }
}
