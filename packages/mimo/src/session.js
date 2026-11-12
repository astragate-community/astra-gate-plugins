// Xiaomi MiMo: a Xiaomi-account's session — what the host keeps for it, signing on again, keeping it fresh.
//   secret = { kind: 'xiaomi', creds: { userId, cUserId, passToken, deviceId, region, base }, cookies, expires }
// creds is the Xiaomi account (what signs it on again), cookies the MiMo server's session, expires when the app would sign
// on again.
import { providers } from 'astra';
import { PROVIDER, RENEW_AFTER, REGION, HOSTS, baseOf } from './constants.js';
import { Lapsed, session } from './sso.js';
import { tryJSON } from './util.js';

/** The stored sign-in as { creds, cookies, expires }, or null when the secret isn't a Xiaomi-account's. */
export function parseXiaomi(text) {
  const v = tryJSON(text ?? '');
  if (v?.kind !== 'xiaomi' || !v.creds?.passToken || !v.creds?.userId) return null;
  const creds = { ...v.creds };
  creds.base ||= baseOf(creds.region) || HOSTS[REGION];
  return { creds, cookies: v.cookies && typeof v.cookies === 'object' ? v.cookies : {}, expires: Number(v.expires) || 0 };
}

export const secretOf = (creds, cookies, issued) => JSON.stringify({ kind: 'xiaomi', creds, cookies, expires: issued + RENEW_AFTER });

const expire = (account) => providers.accounts.update(PROVIDER, account.key, { status: 'expired' }).catch(() => {});

// renewals under way, one to an account: two accounts signing on at once each keep their own session (a cache; it only
// orders calls inside one engine)
const renewing = new Map();

function renew(account, s, budget) {
  let r = renewing.get(account.key);
  if (!r) {
    r = (async () => {
      const got = await session(s.creds, s.creds.base, budget);
      const issued = Date.now();
      const next = { creds: s.creds, cookies: got.cookies, expires: issued + RENEW_AFTER, renewed: true };
      await providers.accounts.update(PROVIDER, account.key, { secret: secretOf(s.creds, got.cookies, issued) });
      return next;
    })().finally(() => renewing.delete(account.key));
    renewing.set(account.key, r);
  }
  return r;
}

/**
 * The account with a live session, signed on again when it is older than the app lets one get, or when `force` is set (the
 * server turned the last one away). `renewed` says it was signed on again. A passToken Xiaomi no longer takes marks the
 * account expired and throws a Lapsed; a hiccup while the session in hand may still do goes on with it.
 */
export async function fresh(account, { force = false, budget } = {}) {
  const s = parseXiaomi(await account.secret());
  if (!s) throw new Error('Xiaomi MiMo: not signed in');
  if (!force && Object.keys(s.cookies).length && Date.now() < s.expires) return s;
  try {
    return await renew(account, s, budget);
  } catch (e) {
    if (e instanceof Lapsed) {
      await expire(account);
      throw e;
    }
    if (!force && Object.keys(s.cookies).length) return s;
    throw e;
  }
}
