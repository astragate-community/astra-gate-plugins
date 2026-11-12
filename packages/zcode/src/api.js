// Calling Z.ai's JSON endpoints.
import { crypto, http } from 'astra';
import { UA, ZCODE } from './constants.js';

export class ZError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

let anyDevice; // X-Device-Mid for calls made signed out (the model list); a cache, made on first use
export const device = () => (anyDevice ??= crypto.randomUUID());

// the statuses whose words magpie's built-in said as Go's http.StatusText (the v1 plugin kept them)
const WORDS = { 400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 405: 'Method Not Allowed', 408: 'Request Timeout', 429: 'Too Many Requests', 500: 'Internal Server Error', 502: 'Bad Gateway', 503: 'Service Unavailable', 504: 'Gateway Timeout' };

// call asks one of Z.ai's JSON endpoints, which wrap what they say in {code, msg, data}: a code of 0 or 200 is a
// success. zcode.z.ai is told the machine's id (X-Device-Mid), as ZCode tells it.
export async function call(method, url, { auth, body, headers, device: dev, timeoutMs = 15000 } = {}) {
  const h = { 'content-type': 'application/json', accept: 'application/json', 'user-agent': UA };
  if (auth) h.authorization = auth;
  if (url.startsWith(ZCODE + '/')) h['x-device-mid'] = dev || device();
  Object.assign(h, headers ?? {});
  const res = await http.fetch(url, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body), timeoutMs });
  const text = await res.text();
  let env;
  try {
    env = JSON.parse(text);
  } catch {}
  const code = env?.code == null ? '' : String(env.code);
  if (!res.ok) {
    if (env?.msg) throw new ZError(code && code !== '0' ? `${env.msg} (${res.status}, code ${code})` : `${env.msg} (${res.status})`, res.status);
    throw new ZError(WORDS[res.status] ?? String(res.status), res.status);
  }
  if (!env || typeof env !== 'object') throw new ZError('not JSON', res.status);
  if (code && code !== '0' && code !== '200') throw new ZError(env.msg || `error ${code}`, res.status);
  return env.data ?? null;
}
