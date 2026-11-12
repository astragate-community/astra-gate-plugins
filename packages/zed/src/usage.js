// The allowance: what the account says of its plan. Zed tells its editor the plan and its billing period, not how much of the allowance is
// spent, so there are no windows — the plan's name, when the period ends, and a plan Zed won't serve
// (overdue invoices) as the error it is.
import { cloud } from './api.js';
import { orgOf, planName, planOf, stateOf } from './account.js';
import { safeParse as parse } from './json.js';

// jsonError is what Go's encoding/json says of a /users/me reply it can't
// read into zed.Me.
export function jsonError(text, v) {
  if (v !== undefined) return `json: cannot unmarshal ${Array.isArray(v) ? 'array' : typeof v === 'string' ? 'string' : typeof v === 'number' ? 'number' : 'bool'} into Go value of type zed.Me`;
  const c = String(text ?? '').trimStart()[0];
  return c === undefined ? 'unexpected end of JSON input' : `invalid character '${c}' looking for beginning of value`;
}

const RFC3339 = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?(Z|[+-]\d\d:\d\d)$/i;

// `secret` is the account's secret; `save` (when given) is handed the new secret when the plan changed.
export async function usage(secret, save) {
  const s = stateOf(secret);
  if (!s) return { error: 'no such Zed account' };
  let me;
  try {
    const text = await cloud('GET', '/client/users/me', s, undefined, 15_000);
    me = parse(text);
    if (me === null) me = {};
    else if (typeof me !== 'object' || Array.isArray(me)) return { error: 'Zed: an unreadable account: ' + jsonError(text, me) };
  } catch (e) {
    if (e?.status === 401) return { error: `${s.who}: the Zed sign-in has expired — sign in again`, expired: true };
    return { error: e?.message ?? String(e) };
  }
  const plan = planOf(me, s.org || orgOf(me));
  const out = { plan: planName(plan) };
  if (plan !== s.plan && save) await save({ ...s, plan }).catch(() => {});
  const end = me.plan?.subscription_period?.ended_at;
  if (typeof end === 'string' && RFC3339.test(end) && !isNaN(Date.parse(end))) out.until = end;
  if (me.plan?.has_overdue_invoices) out.error = 'Zed: this account has an overdue invoice, so its models are paused (see zed.dev/account)';
  return out;
}
