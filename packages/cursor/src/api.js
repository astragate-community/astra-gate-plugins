// Cursor's JSON (Connect) API: the headers it is called with, and the account questions asked of it.
import { http } from 'astra';
import { API, VERSION_FALLBACK } from './constants.js';
import { failure, httpError } from './errors.js';

export const clientVersion = () => 'cli-' + VERSION_FALLBACK;

export function headersFor(tok) {
  return {
    'content-type': 'application/json',
    'connect-protocol-version': '1',
    ...(tok ? { authorization: `Bearer ${tok}` } : {}),
    'x-cursor-client-version': clientVersion(),
    'x-cursor-client-type': 'cli',
    'x-ghost-mode': 'true',
  };
}

// unary is a Connect call in JSON.
export async function unary(base, path, tok, body = {}, timeout = 15_000) {
  const res = await http.fetch(base + '/' + path, { method: 'POST', headers: headersFor(tok), body: JSON.stringify(body), timeoutMs: timeout });
  const text = await res.text();
  if (!res.ok) {
    const f = failure(res.status, text);
    throw httpError(f.message, f.status);
  }
  return JSON.parse(text || '{}');
}

// planName is the plan's name, as `cursor-agent about` says it (GetPlanInfo's planName); "" when Cursor names none.
export async function planName(tok) {
  return String((await unary(API, 'aiserver.v1.DashboardService/GetPlanInfo', tok))?.planInfo?.planName ?? '').trim();
}

// whoIs is the account's email and plan, as `cursor-agent about` says them.
export async function whoIs(tok) {
  const [me, plan] = await Promise.allSettled([unary(API, 'aiserver.v1.DashboardService/GetMe', tok), planName(tok)]);
  return {
    email: me.status === 'fulfilled' ? String(me.value?.email ?? '').trim() : '',
    plan: plan.status === 'fulfilled' ? plan.value : '',
  };
}

// dashboard is a call of the dashboard service with an empty body, the answer as it came; made with the token alone,
// without the CLI's client headers.
export const dashboard = (tok, method) =>
  http.fetch(API + '/aiserver.v1.DashboardService/' + method, {
    method: 'POST',
    headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json', 'connect-protocol-version': '1' },
    body: '{}',
    timeoutMs: 15_000,
  });
