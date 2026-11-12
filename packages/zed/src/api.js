// Calling cloud.zed.dev's /client/* with an account's pair, and how Zed turns a request away.
import { env, http } from 'astra';
import { CLOUD, VERSION } from './constants.js';
import { safeParse } from './json.js';

// Zed's user agent: Zed/<version> (<os>), in Rust's names (the sandbox does not know the CPU).
export const userAgent = () => `Zed/${VERSION} (${{ darwin: 'macos', win32: 'windows' }[env.platform] ?? env.platform ?? 'unknown'})`;

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
};

/** The message in an error body: {code, message}, else the body itself, else the status's name. */
export function failure(status, body) {
  const j = safeParse(body);
  if (j && typeof j === 'object') {
    if (j.message) return String(j.message);
    if (typeof j.error === 'string' && j.error) return j.error;
    if (j.code) return String(j.code);
  }
  const s = String(body ?? '').trim();
  if (s && s.length < 500) return s;
  if (status === 402) return 'payment required: this Zed account has no plan that calls models, or its allowance is used up';
  return STATUS[status] ?? String(status);
}

export class ZedStatus extends Error {
  constructor(status, body, headers) {
    super(`Zed: ${failure(status, body)} (${status})`);
    this.status = status;
    this.headers = headers ?? {};
  }
}

/** Zed refusing the account's own sign-in (a 401 for its model token). */
export class SignInExpired extends Error {}

/** A model token Zed calls stale: a new one fixes it. */
export const stale = (status, headers = {}) => status === 401 || !!headers['x-zed-expired-token'] || !!headers['x-zed-outdated-token'];

/** One /client/* request with the account's pair; the body text. */
export async function cloud(method, path, s, body, timeoutMs = 20000) {
  const headers = { Authorization: `${s.userId} ${s.access}`, 'Content-Type': 'application/json', 'User-Agent': userAgent() };
  if (s.systemId) headers['x-zed-system-id'] = s.systemId;
  const res = await http.fetch(CLOUD + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), timeoutMs });
  const text = await res.text();
  if (!res.ok) throw new ZedStatus(res.status, text, res.headers);
  return text;
}

/** The HTTP status a failure's code stands for: upstream_http_<n> or http_<n>, else what the code names. */
export function failedStatus(code) {
  code = String(code ?? '');
  for (const p of ['upstream_http_', 'http_']) {
    if (code.startsWith(p)) {
      const n = Number(code.slice(p.length));
      if (Number.isInteger(n)) return n;
    }
  }
  if (code.includes('rate_limit')) return 429;
  if (code.includes('overloaded')) return 529;
  if (code.includes('billing') || code.includes('payment')) return 402;
  if (code.includes('context_length')) return 400;
  return 502;
}

/** failedStatus, but a status that isn't an error one is a 502. */
export function errorStatusOf(code) {
  const n = failedStatus(code);
  return n >= 400 && n <= 599 ? n : 502;
}

/** The status and message for a request Zed turned away: its {code, message, upstream_status}, a 402 as the plan it is. */
export function refusal(status, body) {
  if (status === 402) return [402, "payment required: this account's plan doesn't include Zed's hosted models, or its allowance is used up (see zed.dev/account)"];
  // a model token refused right after it was minted: the account's own sign-in just worked
  if (status === 401) return [401, 'the sign-in was refused: sign in again'];
  const j = safeParse(body) ?? {};
  let code = status;
  const up = Number(j.upstream_status);
  if (up >= 400 && up <= 599) code = up;
  else if (j.code) {
    const n = failedStatus(j.code);
    if (n !== 502) code = n;
  }
  if (code < 400 || code > 599) code = 502;
  let msg = failure(status, body);
  if (Number(j.retry_after) > 0) msg += ` (retry after ${Number(j.retry_after)}s)`;
  return [code, msg];
}
