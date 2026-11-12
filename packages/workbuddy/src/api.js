// WorkBuddy: calling its API and signing a request as its desktop app does.
import { http } from 'astra';
import { UA_VERSION } from './constants.js';
import { api } from './sites.js';

const STATUS = { 400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 408: 'Request Timeout', 429: 'Too Many Requests', 500: 'Internal Server Error', 502: 'Bad Gateway', 503: 'Service Unavailable', 504: 'Gateway Timeout' };
export const statusText = (status) => STATUS[status] ?? `HTTP ${status}`;

export class WBError extends Error {
  constructor(message, code, status, said) {
    super(message);
    this.code = code;
    this.status = status;
    this.said = said; // as magpie's built-in (wbCall) worded it
  }
}

const parse = (text) => {
  try {
    const v = JSON.parse(text);
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
};

// call makes a request of WorkBuddy's plugin API, which answers {code, msg, data}; a code but 0 is an error.
export async function call(site, method, path, headers = {}, body, timeoutMs = 30000) {
  const res = await http.fetch(site.endpoint + path, {
    method,
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': 'WorkBuddy/' + UA_VERSION, ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
    timeoutMs,
  });
  const text = await res.text();
  const env = parse(text);
  const code = Number.parseInt(env.code, 10) || 0;
  if (!res.ok) {
    const why = env.msg || env.message || env.error?.message || text.slice(0, 200) || statusText(res.status);
    const said = code ? env.msg || `error ${code}` : env.msg || statusText(res.status);
    throw new WBError(`${site.name}: ${why} (HTTP ${res.status}${env.code ? ', code ' + env.code : ''})`, env.code, res.status, said);
  }
  if (env.code) throw new WBError(`${site.name}: ${env.msg || 'error'} (${env.code})`, env.code, res.status, env.msg || `error ${code}`);
  return env.data;
}

export const domainOf = (site, a) => a.domain || new URL(api(site)).host;

// enterpriseHeaders names the enterprise (team) an account signed in as, as WorkBuddy's own client does on every
// request it makes for that account (X-Enterprise-Id and X-Tenant-Id, both the account's enterpriseId). Without them
// WorkBuddy answers as the personal account: /v3/config lists the personal plan's models and not the enterprise's.
export function enterpriseHeaders(a) {
  const id = typeof a?.enterpriseId === 'string' ? a.enterpriseId.trim() : '';
  return id ? { 'X-Enterprise-Id': id, 'X-Tenant-Id': id } : {};
}

// sign is what WorkBuddy's desktop app sends with a chat: the account's own, the client's, and the attribution
// WorkBuddy's usage list shows as the client that asked (使用端). A chat without them is counted under no client at
// all. Returns the headers; the chat's ids are `attend`'s (request.js).
export function sign(site, a) {
  return {
    Authorization: 'Bearer ' + a.access,
    'X-User-Id': a.uid ?? '',
    'X-Domain': domainOf(site, a),
    'X-Product': 'SaaS',
    'X-IDE-Type': 'WorkBuddy',
    'User-Agent': 'WorkBuddy/' + UA_VERSION,
    'X-Requested-With': 'XMLHttpRequest',
    'X-Agent-Intent': 'craft',
    'X-Agent-Purpose': 'conversation',
    'X-IDE-Name': 'WorkBuddy',
    'X-IDE-Version': UA_VERSION,
    ...enterpriseHeaders(a),
    ...(site.ai ? { 'X-Agent-Type': 'main' } : {}),
  };
}

// postMeter asks the billing API (the meter has no /v2 prefix, on either build) and gives its answer whole: the HTTP
// status, WorkBuddy's code and message, and its data. Callers decide what a code means.
export async function postMeter(site, a, path, body = {}) {
  const res = await http.fetch(site.endpoint + path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'User-Agent': 'WorkBuddy/' + UA_VERSION,
      Authorization: 'Bearer ' + a.access,
      'X-User-Id': a.uid ?? '',
      'X-Domain': domainOf(site, a),
      'X-Product': 'SaaS',
      'X-IDE-Type': 'WorkBuddy',
      ...enterpriseHeaders(a),
    },
    body: JSON.stringify(body),
    timeoutMs: 20000,
  });
  const env = parse(await res.text());
  return { status: res.status, code: Number.parseInt(env.code, 10) || 0, msg: env.msg || env.message || '', data: env.data ?? null };
}

// meter is postMeter for a call that must succeed: errors are said as magpie's built-in did — WorkBuddy's message,
// else its code, else the HTTP status.
export async function meter(site, a, path, body = {}) {
  const r = await postMeter(site, a, path, body);
  if (r.status < 200 || r.status >= 300) {
    if (r.code) throw new Error(r.msg || `error ${r.code}`);
    throw new Error(r.msg || statusText(r.status));
  }
  if (r.code) throw new Error(r.msg || `error ${r.code}`);
  return r.data;
}
