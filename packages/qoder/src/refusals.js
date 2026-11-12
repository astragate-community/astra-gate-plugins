// Qoder: turning a failure (Qoder's) into the status and message the gateway shows. Qoder's own code says what it is, read as
// Qoder's client reads it: only 105 (loginExpired) is a lapsed sign-in there, so a 401/403 that carries another code isn't one
// here either (#98: a queued 10605 came as a 403 and read as "sign in again"). A refused chat with no code is a 401, and a quota
// a 429.
const STATUS_TEXT = { 400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 408: 'Request Timeout', 409: 'Conflict', 413: 'Request Entity Too Large',
  418: "I'm a teapot", 429: 'Too Many Requests', 500: 'Internal Server Error', 502: 'Bad Gateway', 503: 'Service Unavailable', 504: 'Gateway Timeout' };

const QUEUED = '10605';
// the codes Qoder's client counts as a plan's usage or credits used up
const QUOTA_CODES = new Set(['110', '112', '113', '114', '115', '116', '117', '118', '119', '122']);
// refusals of this request, not of the account: sensitive content, not supported, input too long, too many media, a custom model's service
const REQUEST_CODES = new Set(['406', '416', '430', '80411', '80412', '100400', '100401', '100403']);
const BUSY_WAIT = 30;

export function failure(status, text) {
  if (status < 400 || status > 599) status = 502;
  let msg = String(text ?? '').trim();
  let code = '';
  let queue;
  try {
    const j = JSON.parse(text);
    code = j?.code == null ? '' : String(j.code);
    if (j?.message) msg = String(j.message);
    // details is a JSON string, or the object itself
    const d = typeof j?.details === 'string' ? JSON.parse(j.details) : j?.details;
    if (d?.error?.message) msg += ': ' + d.error.message;
    // the queue's state: the message itself, as a JSON string, or a field
    queue = j?.queue && typeof j.queue === 'object' ? j.queue : undefined;
    if (!queue && typeof j?.message === 'string' && j.message.trim().startsWith('{')) {
      const q = JSON.parse(j.message);
      if (q && typeof q === 'object' && ('isQueued' in q || 'serviceAvailable' in q || 'retryAfterSeconds' in q)) queue = q;
    }
  } catch {}
  msg ||= STATUS_TEXT[status] ?? `HTTP ${status}`;
  // Qoder's queue for the model: busy for now, with when to ask again. The sign-in is fine, so it is a 503.
  if (code === QUEUED || queue?.isQueued === true || queue?.serviceAvailable === false) {
    const n = Number(queue?.retryAfterSeconds);
    const wait = Number.isFinite(n) && n > 0 ? Math.ceil(n) : BUSY_WAIT;
    const model = queue?.modelKey ? ` for ${queue.modelKey}` : '';
    const tier = queue?.queueType ? ` (this plan's queue: ${queue.queueType})` : '';
    const what = queue?.isQueued === true ? 'queued the request' : 'is busy';
    return { status: 503, message: `Qoder ${what}${model}${tier}; try again in ${wait}s`, retryAfter: wait };
  }
  if (QUOTA_CODES.has(code)) return { status: 429, message: 'usage limit reached: ' + msg };
  if (REQUEST_CODES.has(code)) return { status: 400, message: `Qoder refused the request (${code}): ${msg}` };
  // Qoder's own words go with a 401: a 401 right after signing in isn't a lapsed sign-in, and its reason is what says what is
  if (status === 401 || status === 403) {
    const said = msg && msg !== STATUS_TEXT[status] ? ` (Qoder said ${status}: ${msg.slice(0, 300)})` : '';
    return { status: 401, message: 'the sign-in lapsed — sign in again' + said };
  }
  if (status === 429 || msg.toLowerCase().includes('quota')) return { status: 429, message: 'usage limit reached: ' + msg };
  return { status, message: msg };
}
