// Cline's refusals as the status and message a gateway client should see (v1 answered them in OpenAI's error shape).
import { firstOf, safeJson } from './util.js';

// the refusals Cline's own client keys on, as it spells them (errors.ts and ClineError.ts): whole phrases and codes, never a loose
// substring: a 403 that happens to mention "tokens" is not a lapsed sign-in
const NOT_SUBSCRIBED = 'the user is not subscribed to required model plan';
const NOT_SUBSCRIBED_FORMATTED = 'no access to clinepass subscription models yet. subscribe to clinepass';

const STATUS = {
  400: 'Bad Request',
  401: 'Unauthorized',
  402: 'Payment Required',
  403: 'Forbidden',
  404: 'Not Found',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
  504: 'Gateway Timeout',
};

/**
 * An upstream chat refusal as { status, message }. The gates Cline puts in front of a model each say what they want: a plan
 * subscription (403), or money (an empty account is a 429 "out of credits", so a pool moves on to another account).
 */
export function failure(status, text) {
  if (status < 400 || status > 599) status = 502;
  let msg = String(text ?? '').trim();
  const j = safeJson(text);
  const code = firstOf(j?.error?.code, j?.code, j?.error?.error);
  if (j) {
    if (typeof j?.error?.message === 'string') msg = j.error.message;
    else if (typeof j?.message === 'string') msg = j.message;
  }
  msg ||= STATUS[status] ?? `HTTP ${status}`;
  const low = msg.toLowerCase();
  // a model the account isn't entitled to: the sign-in is fine, the plan isn't there (the cline-pass group, mostly)
  if (code === 'ENTITLEMENT_ERROR' || low.includes(NOT_SUBSCRIBED) || low.includes(NOT_SUBSCRIBED_FORMATTED))
    return {
      status: 403,
      message: "this model needs a subscription the account hasn't got (ClinePass): pick a usage-billed model, or subscribe at app.cline.bot (" + msg.replace(/^Error\s*\d*[:：]?\s*/, '') + ')',
    };
  // an empty account: say what the gateway said and where to fill it ("Insufficient balance" is the gateway's older wording for the same answer)
  if (status === 402 || code === 'insufficient_credits' || low.includes('insufficient_credits') || (low.includes('insufficient balance') && low.includes('cline credits balance'))) {
    const bal = Number(j?.error?.current_balance ?? j?.current_balance);
    const at = firstOf(j?.error?.buy_credits_url, j?.buy_credits_url) || 'https://app.cline.bot/credits';
    return { status: 429, message: `out of credits ($${Number.isFinite(bal) ? bal.toFixed(2) : '0.00'}): top up at ${at}` };
  }
  // the account's token was refused: 401 always, and a 403 only when it says so in so many words, not when it merely mentions "token"
  if (status === 401 || (status === 403 && /^(unauthorized|invalid[ _]token|sign[ -]?in|not signed in|token (?:expired|invalid|revoked)|(?:access |refresh )?token expired)$/i.test(msg.trim())))
    return { status: 401, message: 'the sign-in lapsed: sign in again' };
  // a spend cap or a rate limit, as Cline's client names them
  if (status === 429 || code === 'SPEND_LIMIT_EXCEEDED' || /\b(?:rate limit|too many requests|quota exceeded|spend limit)\b/i.test(msg)) return { status: 429, message: 'usage limit reached: ' + msg };
  return { status, message: msg.slice(0, 2000) };
}
