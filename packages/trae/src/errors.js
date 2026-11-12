// Trae: what it says went wrong.
import { parseJSON } from './values.js';

// A sign-in Trae turned away: the account is marked for a new sign-in.
export class Expired extends Error {
  constructor(msg) {
    super(msg);
    this.signIn = 'expired';
  }
}

// errorOf is what Trae said went wrong, from its several shapes: a business {code, message}, {error: {code, message}},
// or ByteDance's {ResponseMetadata: {Error: {Code, Message}}}
export function errorOf(v) {
  v = parseJSON(v);
  const meta = v?.ResponseMetadata?.Error;
  if (meta && (meta.Code || meta.Message)) return { code: meta.Code ?? '', message: String(meta.Message ?? meta.Code ?? '') };
  const e = v?.error && typeof v.error === 'object' ? v.error : v;
  const code = e?.code ?? e?.Code ?? v?.code ?? '';
  const message = e?.message ?? e?.msg ?? e?.Message ?? (typeof v?.error === 'string' ? v.error : '') ?? '';
  return { code, message: String(message || '') };
}

// lapsed: Trae turned the token away. 1001 is its "not signed in"; the international deployment also answers 20101.
const CN_LAPSED = [1001, '1001', 401, '401'];
export const lapsedCode = (code, site) => (site?.lapsed ?? CN_LAPSED).includes(code);

const lapsedWords = /not ?log(ged)? ?in|unauthori[sz]ed|token (is )?(expired|invalid)|jwt|未登录|登录(已)?(过期|失效)/i;
const CN_QUOTA = [4008, '4008', 1005, '1005'];
const quotaCode = (code, site) => (site?.quota ?? CN_QUOTA).includes(code);
const quotaWords = /quota|credit|insufficient|exceed|limit|额度|积分|次数|上限|用完/i;

// a model or function this account's chat_v3 doesn't take: another may
export const wrongFunction = (code) => ['4001', '4023', '1005'].includes(String(code));

// failure is the gateway-visible failure for an error Trae answered with: { status, message, expired }. A lapsed
// sign-in is a 401 (the host then asks the provider's refresh), a spent allowance a 429, anything else its own status
// (or 502 for an error in a 200).
export function failure(site, status, code, message) {
  message = message || String(status);
  if (status === 401 || lapsedCode(code, site) || (status === 403 && lapsedWords.test(message))) {
    return { status: 401, expired: true, message: `${site.realm}'s sign-in has expired (${message}); sign in again` };
  }
  if (status === 429 || quotaCode(code, site) || (status === 403 && quotaWords.test(message))) return { status: 429, message: `${site.realm}: ${message}` };
  return { status: status >= 400 ? status : 502, message: `${site.realm}: ${message}${code ? ` (code ${code})` : ''}` };
}
