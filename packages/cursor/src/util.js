// Small helpers on the host's encoding (the sandbox has no Buffer).
import { encoding } from 'astra';

/** A base64url text as the string it encodes (UTF-8); null when it is not base64. */
export function b64urlText(text) {
  const clean = String(text).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  if (/[^A-Za-z0-9_-]/.test(clean)) return null;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(encoding.base64url.decode(clean));
  } catch {
    return null;
  }
}

/** Bytes as base64url, no padding. */
export const b64urlBytes = (bytes) => encoding.base64url.encode(bytes).replace(/=+$/, '');

export const unhex = (hex) => encoding.hex.decode(hex);

/** The status words Cursor's refusals fall back to (Go's http.StatusText, as the v1 plugin's kit said them). */
const WORDS = { 400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 408: 'Request Timeout', 429: 'Too Many Requests', 500: 'Internal Server Error', 502: 'Bad Gateway', 503: 'Service Unavailable', 504: 'Gateway Timeout' };
export const statusText = (status) => WORDS[status] ?? String(status);
