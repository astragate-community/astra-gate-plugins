// The provider's prepare: sends each request on the plan it belongs to — the coding plan with the account's key, or the
// Start Plan / gift as ZCode's own request. The host sends it; what comes back is not seen here (see README).
import { AstraError } from 'astra';
import { BIGMODEL_BASE, EXPIRED, START_BASE, ZAI_BASE } from './constants.js';
import { giftModel, giftUsable, startPlan } from './gift.js';
import { plansOf } from './routing.js';
import { jwtExpired, keyOf, stateOf } from './session.js';
import { dress, modelOf, startHeaders, workPlace } from './start.js';

/** rebase moves a request path's base from whichever plan's it carries to base (a path alone just joins it). */
export const rebase = (path, base) => {
  for (const b of [START_BASE, ZAI_BASE, BIGMODEL_BASE]) if (path.startsWith(b)) return base + path.slice(b.length);
  return base + (path.startsWith('/') ? path : '/' + path);
};

// a "-Trial" model is the gift's entry: its raw name, or the refusal: the gift is spent, or has no such model.
async function trial(s, gift, model, accountKey) {
  gift ??= await startPlan(s.jwt, s.device).catch(() => null);
  const raw = giftModel(gift, model);
  if (!(raw && giftUsable(s, gift, raw, accountKey))) {
    throw raw
      ? new AstraError('rate_limited', `ZCode's limited quota for ${raw} is exhausted or temporarily unavailable`)
      : new AstraError('invalid_argument', `ZCode has no active limited quota for ${model}`);
  }
  return raw;
}

/** prepare(req, account): where this request goes and how it is dressed. */
export async function prepare(req, account) {
  if (!account) throw new AstraError('invalid_argument', 'not signed in to ZCode');
  const s = stateOf(await account.secret());
  if (!s) throw new AstraError('invalid_argument', 'not signed in to ZCode');
  const { start: alone, gift } = await plansOf(s, account.key);
  const key = await keyOf(s, account.key);
  let body = req.body;
  let start = alone;
  if (body && typeof body === 'object') {
    const m = modelOf(body);
    if (m.toLowerCase().endsWith('-trial')) {
      body = { ...body, model: await trial(s, gift, m, account.key) };
      start = true;
    }
  }
  const { place, rest } = workPlace(req.headers);
  if (start) {
    if (jwtExpired(s.jwt)) throw new AstraError('unavailable', EXPIRED);
    if (!s.jwt) throw new AstraError('invalid_argument', "ZCode's sign-in has no key; sign in again");
    // the Start Plan is served only to what looks like ZCode's own request
    return { url: rebase(req.path, START_BASE), headers: startHeaders(rest, s.jwt, s), body: dress(body, s.site, s.device, place, s.utc) };
  }
  if (!key) throw new AstraError('invalid_argument', "ZCode's sign-in has no key; sign in again");
  return {
    url: rebase(req.path, s.base),
    headers: { ...rest, 'x-api-key': key, authorization: 'Bearer ' + key },
    ...(body !== req.body ? { body } : {}),
  };
}

/** refresh after a 401 / 403: a team seat's key is made again; the rest are kept as they are (the v1 plugin never marked a ZCode account lapsed). */
export async function refresh(account) {
  const s = stateOf(await account.secret());
  if (!s || !s.org || !s.project || !s.token) return undefined;
  try {
    await keyOf({ ...s, key: '' }, account.key);
    return 'renewed';
  } catch {
    return undefined;
  }
}
