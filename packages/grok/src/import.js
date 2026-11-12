// Accounts from a sign-in made elsewhere: a Grok Build `auth.json` (or one of its entries) or a CLIProxyAPI (CPA) xAI
// account file, pasted as text.
import { CLIENT_ID, ISSUER } from './constants.js';
import { jwtClaims, obj } from './values.js';

const filled = (v) => typeof v === 'string' && v !== '';

/**
 * An xAI OAuth account from a CPA file as the CLI keeps it in auth.json; throws for a file that is not one. The refresh
 * token is kept: CPA must stop using the account, since both clients rotate the same token.
 */
export function cpaAuth(source) {
  if (!source || typeof source !== 'object' || Array.isArray(source) || source.type !== 'xai' || source.auth_kind !== 'oauth' || source.disabled !== false) {
    throw new Error('CPA file is not an enabled xAI OAuth account');
  }
  if (![source.access_token, source.refresh_token, source.sub, source.email].every(filled)) throw new Error('CPA xAI account is missing its tokens or identity');
  if (typeof source.last_refresh !== 'string' || typeof source.expired !== 'string') throw new Error('CPA xAI account has invalid token timestamps');
  const createTime = Date.parse(source.last_refresh);
  const expiresAt = Date.parse(source.expired);
  if (!Number.isFinite(createTime) || !Number.isFinite(expiresAt)) throw new Error('CPA xAI account has invalid token timestamps');
  const claims = jwtClaims(source.access_token);
  const audience = Array.isArray(claims?.aud) ? claims.aud : [claims?.aud];
  if (claims?.iss !== ISSUER || !audience.includes(CLIENT_ID)) throw new Error('CPA token is not for the Grok Build xAI account');
  return {
    key: source.access_token,
    auth_mode: 'oidc',
    create_time: new Date(createTime).toISOString(),
    user_id: source.sub,
    email: source.email,
    refresh_token: source.refresh_token,
    expires_at: new Date(expiresAt).toISOString(),
    oidc_issuer: ISSUER,
    oidc_client_id: CLIENT_ID,
  };
}

/** The first entry (by key) of a Grok Build auth.json that holds a token. */
function entryOf(all) {
  for (const k of Object.keys(all).sort()) if (all[k] && typeof all[k].key === 'string' && all[k].key) return all[k];
  return null;
}

/** Reads pasted text — a CPA file, an auth.json or one of its entries — as an account credential; throws what is wrong with it. */
export function parseImport(text) {
  let source;
  try {
    source = JSON.parse(String(text ?? ''));
  } catch {
    throw new Error('that is not valid JSON');
  }
  if (!obj(source)) throw new Error('that is not a Grok account (a JSON object is expected)');
  const entry = source.type === 'xai' ? cpaAuth(source) : typeof source.key === 'string' ? source : entryOf(source);
  if (!entry) throw new Error('no sign-in with a token in that JSON');
  if (entry.oidc_issuer && entry.oidc_issuer !== ISSUER) throw new Error('that sign-in is not from xAI');
  if (!filled(entry.refresh_token)) throw new Error('that sign-in has no refresh token, so it could not be renewed');
  const expires = Date.parse(entry.expires_at ?? '');
  const claims = jwtClaims(entry.key);
  return {
    key: entry.key,
    refresh: entry.refresh_token,
    expires: Number.isFinite(expires) ? expires : 0,
    email: filled(entry.email) ? entry.email : '',
    userId: filled(entry.user_id) ? entry.user_id : (typeof claims?.sub === 'string' ? claims.sub : ''),
    clientId: filled(entry.oidc_client_id) ? entry.oidc_client_id : CLIENT_ID,
  };
}
