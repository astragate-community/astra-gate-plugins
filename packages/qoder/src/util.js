// Qoder: the small things several modules share.
import { crypto } from 'astra';

/** A random 32-character hex id (a request id, a machine key, a chat id). */
export const hexID = () => crypto.randomUUID().replaceAll('-', '');
/** A tool call's id when Qoder gave none. */
export const callId = () => 'call_' + hexID();
/** Whether a token (or any string-ish field) is missing or only blanks. */
export const blank = (v) => !String(v ?? '').trim();

/** The text of a message's content: a string, or its text parts joined. */
export const textOf = (content) =>
  typeof content === 'string' ? content : Array.isArray(content) ? content.filter((p) => p?.type === 'text').map((p) => p.text ?? '').join('') : '';

export function tryJSON(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * JSON.stringify as the host writes it when it re-serializes a body a plugin's prepare returned (System.Text.Json's default
 * encoder: every non-ASCII UTF-16 unit and the HTML-sensitive characters as upper-case \\uXXXX, a quote as \\u0022). The COSY
 * signature covers the body's bytes, so what is signed has to be what the host sends.
 */
export function hostJson(value) {
  const s = JSON.stringify(value);
  let out = '';
  let inString = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (!inString) {
      out += c;
      if (c === '"') inString = true;
      continue;
    }
    if (c === '\\') {
      const n = s[++i];
      if (n === '"') out += '\\u0022';
      else if (n === 'u') {
        out += '\\u' + s.slice(i + 1, i + 5).toUpperCase();
        i += 4;
      } else out += '\\' + n; // \\ \n \r \t \b \f stay
    } else if (c === '"') {
      out += c;
      inString = false;
    } else {
      const code = c.charCodeAt(0);
      if (code > 0x7e || '<>&\'+`'.includes(c)) out += '\\u' + code.toString(16).toUpperCase().padStart(4, '0');
      else out += c;
    }
  }
  return out;
}
