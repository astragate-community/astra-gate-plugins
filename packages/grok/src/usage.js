// How much of the subscription's allowance is gone, as Grok's backend says it (the same page the CLI's /usage reads): the
// credits of the current period, weekly for SuperGrok, and what on-demand spending has used of its cap.
import { http } from 'astra';
import { BASE } from './constants.js';
import { rateWindow } from './ratelimit.js';

const PERIODS = { DAILY: ['1 day', 24 * 3600], WEEKLY: ['7 days', 7 * 24 * 3600], MONTHLY: ['Month', 30 * 24 * 3600] };
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/** The allowance cards a billing answer (format=credits) holds. */
export function cardsOf(data) {
  const cfg = data?.config ?? {};
  const num = (v) => (typeof v === 'number' ? v : 0);
  let [name, span] = ['Allowance', 0];
  let end = cfg.billingPeriodEnd;
  if (cfg.currentPeriod) {
    [name, span] = PERIODS[String(cfg.currentPeriod.type ?? '').replace(/^USAGE_PERIOD_TYPE_/, '')] ?? ['Allowance', 0];
    end = cfg.currentPeriod.end;
  }
  const at = typeof end === 'string' && RFC3339.test(end) && !Number.isNaN(Date.parse(end)) ? { resetsAt: end } : {};
  const out = [{ name, used: num(cfg.creditUsagePercent), ...(span ? { span } : {}), ...at }];
  const cap = num(cfg.onDemandCap?.val);
  if (cap > 0) out.push({ name: 'On-demand', used: (100 * num(cfg.onDemandUsed?.val)) / cap, ...at, aside: true });
  return out;
}

/** The account's usage card: { windows } or { error, windows: [] }. */
export async function usage(key) {
  let res;
  try {
    res = await http.fetch(`${BASE}/billing?format=credits`, { headers: { authorization: `Bearer ${key}`, accept: 'application/json' }, timeoutMs: 15000, redirect: 'error' });
  } catch (e) {
    return { error: e?.message ?? String(e), windows: [] };
  }
  if (!res.ok) return { error: `Grok billing: HTTP ${res.status}`, windows: [] };
  let data;
  try {
    data = await res.json();
  } catch (e) {
    return { error: `Grok billing: ${e?.message ?? 'not JSON'}`, windows: [] };
  }
  return { windows: cardsOf(data) };
}
