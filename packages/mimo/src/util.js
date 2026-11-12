// Small shared helpers: JSON that may not be JSON, a response header by any spelling, and the words for a status.

/** JSON.parse that answers undefined for text that isn't JSON (a sign-in page where an API answer was due). */
export function tryJSON(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** A reply header by name, whatever case the host gave it. */
export function header(res, name) {
  for (const [k, v] of Object.entries(res?.headers ?? {})) if (k.toLowerCase() === name) return v;
  return undefined;
}

const STATUS = { 400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 408: 'Request Timeout', 429: 'Too Many Requests', 500: 'Internal Server Error', 502: 'Bad Gateway', 503: 'Service Unavailable', 504: 'Gateway Timeout' };

/** A status as "502 Bad Gateway". */
export const statusLine = (status) => `${status} ${STATUS[status] ?? ''}`.trim();

/** The message in an error body ({error: {message}}, {error}, {message}, {msg}, {detail}), else the body cut short after the status. */
export function vendorError(text, fallback) {
  const v = tryJSON(text);
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    const err = v.detail !== undefined && v.detail !== null ? v.detail : v.error;
    if (Array.isArray(v.errors) && typeof v.errors[0]?.message === 'string' && v.errors[0].message) return v.errors[0].message;
    if (err && typeof err === 'object' && typeof err.message === 'string' && err.message) return err.message;
    if (typeof err === 'string' && err) return err;
    const m = (typeof v.message === 'string' && v.message) || (typeof v.msg === 'string' && v.msg);
    if (m) return m;
  }
  const s = String(text ?? '').split(/\s+/).filter(Boolean).join(' ');
  if (!s || s.startsWith('<')) return fallback;
  const r = [...s];
  return fallback + ': ' + (r.length > 300 ? r.slice(0, 300).join('') + '…' : s);
}

/** A SignInGone is an account Xiaomi no longer signs in: it must be signed in again. */
export class Lapsed extends Error {}
