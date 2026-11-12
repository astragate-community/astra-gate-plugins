// Calling Devin's servers: the status of an account's key, and the sign-in exchange (both JSON over Connect).
import { http } from 'astra';
import { CLI_VERSION, EXCHANGE, SERVER, USER_STATUS_RPC } from './constants.js';

const STATUS = { 400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 429: 'Too Many Requests', 500: 'Internal Server Error', 502: 'Bad Gateway', 503: 'Service Unavailable' };
const statusText = (status) => STATUS[status] ?? `HTTP ${status}`;

// failure is the status and message for a Connect error: {"code", "message"}, or at a stream's end {"error": {"code", "message"}}.
export function failure(status, text) {
  let msg = String(text ?? '').trim();
  let code = '';
  try {
    const e = JSON.parse(text);
    if (e?.error && typeof e.error === 'object') [code, msg] = [e.error.code ?? '', e.error.message ?? ''];
    else if (e?.code) [code, msg] = [e.code, e.message ?? ''];
    msg ||= code;
  } catch {
    // not JSON: the text is the message
  }
  msg ||= statusText(status);
  const low = msg.toLowerCase();
  if (code === 'unauthenticated') return { status: 401, message: msg + ' — sign in to Devin again' };
  if (code === 'resource_exhausted' || low.includes('quota') || low.includes('rate limit')) return { status: 429, message: 'usage limit reached: ' + msg };
  if (code === 'invalid_argument') return { status: 400, message: msg };
  if (code === 'unavailable') return { status: 503, message: msg };
  if (code) return { status: 502, message: msg };
  return { status, message: msg };
}

const osName = () => 'linux'; // what the CLI says of its machine; the plugin has no machine of its own

// readUserStatus asks GetUserStatus about the key's account and gives the body read, and whether Devin refused the key (the
// status, or the Connect error in the body, says unauthenticated).
export async function readUserStatus(key, server = SERVER) {
  const res = await http.fetch(server + USER_STATUS_RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Connect-Protocol-Version': '1' },
    body: JSON.stringify({ metadata: { ideName: 'devin-cli', ideVersion: CLI_VERSION, extensionName: 'devin-cli', extensionVersion: CLI_VERSION, apiKey: key, locale: 'en', os: osName() } }),
    timeoutMs: 15000,
  });
  const text = await res.text();
  return { res, text, refused: res.status === 401 || failure(res.status, text).status === 401 };
}

// exchange trades the callback's code for the session token `devin auth login` keeps — already shaped
// "devin-session-token$<jwt>".
export async function exchange(code, verifier, redirect) {
  const res = await http.fetch(SERVER + EXCHANGE, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ code, code_verifier: verifier, redirect_uri: redirect }),
    timeoutMs: 30000,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Devin's exchange: ${res.status} ${text.slice(0, 300)}`);
  let r = {};
  try {
    r = JSON.parse(text);
  } catch {
    // no JSON: no token below
  }
  const key = r.sessionToken || r.session_token;
  if (!key) throw new Error("Devin's exchange returned no session token");
  return key;
}
