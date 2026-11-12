// The account as billing reports it: the plan (the subscription, slow, so it is kept in storage), and the credits
// beyond the plan's.
import { accountJSON } from './http.js';
import { number, when } from './values.js';

// The plan names, by planId prefix, the longest first, with the dollars of
// credits each gives a month (the CLI's getPlanInfo; "individual-pro-v1"
// is the old Pro, $80 of them).
const PLAN_NAMES = [
  ['individual-provider', 'Provider', 15],
  ['individual-pro-v1', 'Pro', 80],
  ['individual-goat', 'GOAT', 70],
  ['individual-ultra', 'Ultra', 300],
  ['individual-max', 'Max', 150],
  ['individual-pro', 'Pro', 30],
  ['individual-go', 'Go', 10],
  ['teams-pro', 'Teams Pro', 40],
];
const NO_PLAN = 'No plan';

// planOf is [prefix, name, monthly dollars] for a planId, or ["", "", 0].
export function planOf(id) {
  const s = String(id ?? '')
    .toLowerCase()
    .replaceAll('_', '-');
  return PLAN_NAMES.find(([p]) => s.startsWith(p)) ?? ['', '', 0];
}

const planName = (id) => planOf(id)[1];

// subscriptionOf is the account's plan as billing/subscriptions says: its
// id and name, when its period ends and whether it renews then; NO_PLAN
// when it has none, undefined when it can't be read.
export async function subscriptionOf(key, timeout) {
  let d;
  try {
    const r = await accountJSON('/alpha/billing/subscriptions', key, timeout);
    // a 200 with success false when Command Code couldn't tell
    // ("write CONNECTION_CLOSED …"): unread, not no plan
    if (r?.success === false) return undefined;
    d = r?.data;
  } catch {
    return undefined;
  }
  if (d?.planId && d.status !== 'canceled' && d.status !== 'incomplete_expired') {
    const renew = typeof d.cancelAtPeriodEnd === 'boolean' ? (d.cancelAtPeriodEnd ? 'off' : 'auto') : '';
    return { id: d.planId, plan: planName(d.planId) || d.planId, until: when(d.currentPeriodEnd), renew };
  }
  return { id: '', plan: NO_PLAN };
}

// Credits beyond the plan's, bought or free ones, let the account every model, the plan's or not (the CLI's
// evaluateModelAccess; Command Code's refusal: "… or extra on demand usage").
export const hasExtra = (c) => number(c?.credits?.purchasedCredits) > 0 || number(c?.credits?.freeCredits) > 0;

// whether the key has such credits: false when they can't be read, so the plan's list stands and a model it leaves
// out is still refused by Command Code, as it was asked.
export async function extraNow(key) {
  try {
    return hasExtra(await accountJSON('/alpha/billing/credits', key, 5_000));
  } catch {
    return false;
  }
}
