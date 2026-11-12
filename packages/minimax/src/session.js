// MiniMax Code: an account's tokens — reading a token answer, refreshing, keeping fresh. The account's credential (the
// host-held secret) is this JSON: { access, refresh, expires, realUserID?, email?, name? }.
import { providers } from 'astra';
import { AUDIENCE, CLIENT_ID, EARLY_MS, KEEP_RENEWED_MS, SCOPE } from './constants.js';
import { OAuthError, postForm } from './api.js';
import { jwtClaims, obj, pos, str } from './values.js';

/** A token answer, as a sign-in: `refresh` is the one to keep when none is sent. */
export function token(body, refresh) {
  const access = str(body, 'access_token');
  const expiresIn = pos(body, 'expires_in');
  if (!access || !expiresIn) throw new OAuthError('invalid_token_response');
  const claims = jwtClaims(access);
  return {
    access,
    refresh: str(body, 'refresh_token') ?? refresh ?? '',
    expires: Date.now() + expiresIn * 1000,
    subject: str(claims, 'sub'),
    accountID: str(claims, 'account_id'),
  };
}

/** Trades a refresh token for a new access token. */
export async function refreshToken(site, refresh) {
  const r = await postForm(site.account + '/oauth2/token', {
    grant_type: 'refresh_token',
    refresh_token: refresh,
    client_id: CLIENT_ID,
    scope: SCOPE,
    audience: AUDIENCE,
  });
  if (!r.ok) throw new OAuthError(r.error ?? 'oauth_request_failed', r.status);
  return token(r.body, refresh);
}

/**
 * The one answer that means the account is signed out, as MiniMax Code reads it: invalid_grant with HTTP 400. Anything
 * else (a 5xx, a timeout, another error) is passing, and the sign-in is kept.
 */
export const signedOut = (e) => e instanceof OAuthError && e.code === 'invalid_grant' && e.httpStatus === 400;

export class SignInExpired extends Error {
  constructor(site) {
    super(`this ${site.name} account is signed out; sign in again`);
    this.signIn = 'expired';
  }
}

// MiniMax spends a refresh token once: the refresh gives a new one, and the old one asked again is invalid_grant, which
// signs the account out. So a refresh token is never sent twice from here.
//
// `renewing` is each refresh under way, by site and the refresh token it spends; `renewed` is what each gave, kept a
// minute once saved so a request that read the old token after the refresh was saved joins it rather than spending the
// old token again, and kept for good when the save failed: the account's newest tokens are then here only. (Both are
// caches: the plugin may be unloaded at any time, and the saved secret is what survives.)
export const renewing = new Map();
export const renewed = new Map();

/** The sign-in `a` with the newest tokens this process got for it. */
export function latest(site, a) {
  for (let i = 0; i < 16 && a.refresh; i++) {
    const done = renewed.get(site.id + '\n' + a.refresh);
    if (!done || (done.saved && Date.now() - done.at >= KEEP_RENEWED_MS)) break;
    a = { ...a, ...done.got };
  }
  return a;
}

/** Spends a's refresh token, once: those who come while it runs wait for it. `save` keeps what it gave, saying whether it could. */
export function renew(site, a, save) {
  const key = site.id + '\n' + a.refresh;
  let r = renewing.get(key);
  if (!r) {
    r = (async () => {
      const t = await refreshToken(site, a.refresh);
      const got = { access: t.access, refresh: t.refresh, expires: t.expires };
      const done = { got, at: Date.now(), saved: false };
      renewed.set(key, done);
      done.saved = await save({ ...a, ...got });
      done.at = Date.now();
      return got;
    })().finally(() => renewing.delete(key));
    renewing.set(key, r);
  }
  return r;
}

/** Reads an account's credential back as a sign-in, or null when it isn't one. */
export function parseSecret(text) {
  try {
    const v = obj(JSON.parse(text));
    return v && typeof v.access === 'string' && v.access ? v : null;
  } catch {
    return null;
  }
}

/** Saves a sign-in as the account's credential, saying whether it could. */
export const saverOf = (site, key) => async (a) => {
  try {
    await providers.accounts.update(site.id, key, { secret: JSON.stringify(a) });
    return true;
  } catch {
    return false;
  }
};

/**
 * `fresh` is the account with an access token that isn't about to end, refreshed (and saved) when it is, or when MiniMax
 * turned away the access token `rejected` and no newer one is had. `renewed` says the token isn't the one stored: this
 * call or another refreshed it. `getAuth` reads the stored sign-in.
 */
export const freshOf = (site, save) => {
  const fresh = async (getAuth, rejected, again = false) => {
    const stored = await getAuth();
    if (!stored?.access) throw new Error(`${site.name} isn't signed in`);
    const a = latest(site, stored);
    const newer = a.access !== stored.access;
    if (rejected !== undefined && a.access !== rejected) return { a, renewed: true };
    const force = rejected !== undefined;
    if (!force && !(a.expires && Date.now() >= a.expires - EARLY_MS)) return { a, renewed: newer };
    if (!a.refresh) {
      if (Date.now() < a.expires) return { a, renewed: newer };
      throw new SignInExpired(site);
    }
    try {
      return { a: { ...a, ...(await renew(site, a, save)) }, renewed: true };
    } catch (e) {
      if (signedOut(e)) {
        // spent by someone else, who saved the new one: that one is used
        const now = again ? undefined : await getAuth().catch(() => undefined);
        if (now?.refresh && now.refresh !== a.refresh && now.refresh !== stored.refresh) return fresh(getAuth, rejected, true);
        throw new SignInExpired(site);
      }
      // passing: the token in hand may still do
      if (!force && Date.now() < a.expires) return { a, renewed: newer };
      throw Object.assign(new Error(`${site.name} token refresh: ${e?.message ?? e}`), { signIn: 'kept' });
    }
  };
  return fresh;
};
