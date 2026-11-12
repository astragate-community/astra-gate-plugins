// Trae: loose values its answers carry (JSON in a string, expiry times, a JWT's exp, query strings).
import { encoding } from 'astra';

// whenOf reads one of Trae's expiry times: seconds, milliseconds or ISO
export function whenOf(v) {
  if (v === undefined || v === null || v === '') return 0;
  if (typeof v === 'string' && !/^\d+$/.test(v.trim())) {
    const t = Date.parse(v);
    return isNaN(t) ? 0 : t;
  }
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n < 1e11 ? n * 1000 : n;
}

// base64urlToText decodes a JWT segment (base64url, padding or none) as UTF-8 text; it throws on anything else
export const base64urlToText = (input) => encoding.utf8.decode(encoding.base64url.decode(String(input).replace(/=+$/, '')));

// jwtExp is a JWT's exp, in ms, 0 when it has none
export function jwtExp(token) {
  try {
    return whenOf(JSON.parse(base64urlToText(String(token).split('.')[1]))?.exp);
  } catch {
    return 0;
  }
}

export const parseJSON = (s) => {
  if (s && typeof s === 'object') return s;
  try {
    const v = JSON.parse(String(s ?? ''));
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
};

// queryOf reads the query of a pasted address (or a bare query string) into a Map; the first of a repeated name wins
export function queryOf(text) {
  let s = String(text ?? '').trim();
  const hash = s.indexOf('#');
  if (hash >= 0) s = s.slice(0, hash);
  const at = s.indexOf('?');
  if (at >= 0) s = s.slice(at + 1);
  else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = '';
  const out = new Map();
  for (const [k, v] of new URLSearchParams(s)) if (!out.has(k)) out.set(k, v);
  return out;
}

// the parts of an https URL: { origin, host, path } or null for anything with a port, credentials, query or fragment
export function httpsParts(text) {
  let u;
  try {
    u = new URL(String(text ?? '').trim());
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || u.port || u.username || u.password || u.search || u.hash) return null;
  return { origin: 'https://' + u.hostname, host: u.hostname, path: u.pathname.replace(/\/+$/, '') };
}

export const statusLine = (status) => `${status} ${{ 200: 'OK', 400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 429: 'Too Many Requests', 500: 'Internal Server Error', 502: 'Bad Gateway', 503: 'Service Unavailable' }[status] ?? ''}`.trim();
