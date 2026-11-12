// MiniMax Code: signing in with the OAuth device flow (PKCE).
import { crypto, encoding, timers } from 'astra';
import { AUDIENCE, CLIENT_ID, DEVICE_GRANT, SCOPE, SIGN_IN_MS } from './constants.js';
import { OAuthError, identity, postForm } from './api.js';
import { token } from './session.js';
import { pos, str } from './values.js';

/** A URL-safe random string: a PKCE verifier. */
export const randomToken = (bytes = 32) => encoding.base64url.encode(crypto.randomBytes(bytes));
/** The S256 PKCE challenge of a verifier. */
export const challengeOf = (verifier) => encoding.base64url.encode(crypto.sha256(verifier, { encoding: 'bytes' }));

export async function startDevice(site) {
  const verifier = randomToken(32);
  const r = await postForm(site.account + '/oauth2/device/code', {
    client_id: CLIENT_ID,
    scope: SCOPE,
    audience: AUDIENCE,
    code_challenge: challengeOf(verifier),
    code_challenge_method: 'S256',
  });
  if (!r.ok) throw new OAuthError(r.error ?? 'oauth_request_failed', r.status);
  const b = r.body;
  const userCode = str(b, 'user_code');
  const deviceCode = str(b, 'device_code');
  const expiredIn = pos(b, 'expired_in');
  // MiniMax's own variant: no device_code, the user code polled for, an end that may be an at-ms, an interval in ms
  const byUser = !deviceCode && !!userCode && expiredIn !== undefined;
  const uri = str(b, 'verification_uri') ?? str(b, 'verification_url');
  const at = expiredIn === undefined ? undefined : expiredIn < 1e12 ? expiredIn : Math.ceil((expiredIn - Date.now()) / 1000);
  const expiresIn = pos(b, 'expires_in') ?? (at > 0 ? at : undefined);
  const interval = pos(b, 'interval');
  if (!(deviceCode ?? (byUser ? userCode : undefined)) || !userCode || !uri) throw new OAuthError('invalid_device_authorization_response');
  return {
    verifier,
    userCode,
    poll: byUser ? { user_code: userCode } : { device_code: deviceCode },
    url: str(b, 'verification_uri_complete') ?? uri,
    deadline: Date.now() + (expiresIn ? expiresIn * 1000 : SIGN_IN_MS),
    intervalMs: byUser && interval !== undefined ? interval : (interval ?? 5) * 1000,
  };
}

/**
 * Polls for the sign-in until it is done (the token), refused or past its end. With `budgetMs` it gives up waiting after
 * that long and returns null: the device (its `intervalMs` may have grown) is still good, ask again. (A view's action has
 * a wall-clock limit, so the flow polls in slices.)
 */
export async function pollDevice(site, d, budgetMs = Infinity) {
  const until = Date.now() + budgetMs;
  while (Date.now() < d.deadline) {
    if (Date.now() + d.intervalMs > until) return null;
    await timers.sleep(d.intervalMs);
    const r = await postForm(site.account + '/oauth2/token', {
      grant_type: DEVICE_GRANT,
      ...d.poll,
      client_id: CLIENT_ID,
      code_verifier: d.verifier,
    });
    const status = str(r.body, 'status');
    if (r.ok && status === 'pending') continue;
    if (r.ok && status === 'slow_down') {
      d.intervalMs += 5000;
      continue;
    }
    if (r.ok && (status === 'denied' || status === 'access_denied')) throw new OAuthError('access_denied', 0, 'the sign-in was turned down');
    if (r.ok && (status === 'expired' || status === 'expired_token')) throw new OAuthError('expired_token', 0, 'the sign-in code expired');
    if (r.ok) return token(r.body);
    if (r.error === 'authorization_pending') continue;
    if (r.error === 'slow_down') {
      d.intervalMs += 5000;
      continue;
    }
    throw new OAuthError(r.error ?? 'device_authorization_failed', r.status);
  }
  throw new OAuthError('expired_token', 0, 'the sign-in code expired');
}

/** What a finished sign-in keeps: the credential (the account's secret) and the account row's key and name. */
export function signedInResult(site, t, who) {
  const uid = who.realUserID ?? t.accountID ?? t.subject ?? '';
  return {
    key: uid || site.id,
    displayName: who.email || who.name || uid || site.name,
    email: who.email ?? null,
    credential: {
      access: t.access,
      refresh: t.refresh,
      expires: t.expires,
      ...(who.realUserID ? { realUserID: who.realUserID } : {}),
      ...(who.email ? { email: who.email } : {}),
      ...(who.name ? { name: who.name } : {}),
    },
  };
}

/** Finishes a sign-in: who the account is (best effort), then the result. */
export async function finish(site, t) {
  let who = {};
  try {
    who = await identity(site, t.access);
  } catch {}
  return signedInResult(site, t, who);
}
