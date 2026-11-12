// The model token: what /models is asked with, minted from the account's pair.
import { cloud, SignInExpired, ZedStatus } from './api.js';
import { safeParse } from './json.js';

// Each account's model token, in memory: Zed mints them for an hour or so and says when one is stale, so none is written down.
const tokens = new Map();
const minting = new Map();

/** A live model token for s, minted anew when `renew` is set (the last one was refused) or none is kept. */
export async function modelToken(s, renew) {
  const key = `${s.userId} ${s.access}`;
  if (!renew && tokens.has(key)) return tokens.get(key);
  if (minting.has(key)) return minting.get(key);
  const run = (async () => {
    try {
      const tok = safeParse(await cloud('POST', '/client/llm_tokens', s, { organization_id: s.org }))?.token;
      if (!tok) throw new Error('Zed: no model token in the reply');
      tokens.set(key, tok);
      return tok;
    } catch (e) {
      tokens.delete(key);
      if (e instanceof ZedStatus && e.status === 401) throw new SignInExpired(`${s.who || 'the account'}: the Zed sign-in has expired — sign in again`);
      throw e;
    }
  })();
  minting.set(key, run);
  try {
    return await run;
  } finally {
    minting.delete(key);
  }
}

/** Drops the account's kept model token (the next call mints a new one). */
export const forget = (s) => void tokens.delete(`${s.userId} ${s.access}`);
