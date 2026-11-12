// The Start Plan's requests.
// zcode.z.ai serves the Start Plan only to what looks like ZCode's own request, and turns others away with 405 "request
// has been blocked due to unusual activity" (code 3012). A Start Plan request goes as the plugin the plan serves (the
// glm CLI, provider zcode-start) sends it: its headers (startHeaders) and its body (dress). The texts are prompt.js.
//
// The v1 plugin read the machine it ran on (process.platform, os.release(), the login shell, the Intl locale). A v2
// sandbox has none of that: the platform is the host's `env.platform`, the locale, time zone and UTC offset are those of
// the console the sign-in was made in (kept in the account's state), and the OS version and shell lines are left out.
import { crypto, env } from 'astra';
import { APP_VERSION, UA, ZCODE } from './constants.js';
import PROMPT from './prompt.js';

/** modelOf reads the model a Messages body asks for. */
export const modelOf = (body) => (typeof body?.model === 'string' ? body.model : '');

const NODE_PLATFORM = { macos: 'darwin', windows: 'win32', linux: 'linux' };
export const platformName = () => `${NODE_PLATFORM[env.platform] ?? env.platform}-${env.platform === 'macos' ? 'arm64' : 'x64'}`; // darwin-arm64, win32-x64, linux-x64, as ZCode names them
const osCategory = () => (NODE_PLATFORM[env.platform] ? env.platform : 'linux');

/** startHeaders: ZCode's headers for a Start Plan request, jwt its key. `s` is the account's state. */
export function startHeaders(headers, jwt, s = {}) {
  const h = { ...headers };
  for (const k of Object.keys(h)) if (['x-api-key', 'authorization', 'x-device-mid'].includes(k.toLowerCase())) delete h[k];
  const out = {
    authorization: 'Bearer ' + jwt,
    'anthropic-version': '2023-06-01',
    'http-referer': ZCODE,
    'user-agent': UA + ' ai-sdk/anthropic/3.0.81',
    'x-zcode-app-version': APP_VERSION,
    'x-title': 'Z Code@cli',
    'x-release-channel': 'production',
    'x-client-language': s.locale || 'unknown',
    'x-zcode-agent': 'glm',
    'x-platform': platformName(),
    'x-os-category': osCategory(),
    'x-request-id': crypto.randomUUID(),
    'x-zcode-session-type': 'main',
    'x-zcode-trace-id': crypto.randomUUID(),
  };
  if (s.tz) out['x-client-timezone'] = s.tz;
  return { ...h, ...out };
}

// WORK_DIR and WORK_GIT are where a host that knows tells the plugin the agent that asked works: the folder,
// percent-encoded, and "yes" or "no" for a git repository. Astra's gateway sends neither today; magpie did.
const WORK_DIR = 'x-magpie-work-dir';
const WORK_GIT = 'x-magpie-work-git';

/** workPlace reads {dir?, git?} from a request's headers and the headers without them. */
export function workPlace(headers) {
  const place = {};
  const rest = {};
  for (const [k, v] of Object.entries(headers ?? {})) {
    if (k.toLowerCase() === WORK_DIR) {
      try {
        place.dir = decodeURIComponent(v);
      } catch {}
    } else if (k.toLowerCase() === WORK_GIT) place.git = v;
    else rest[k] = v;
  }
  if (!place.dir || (place.git !== 'yes' && place.git !== 'no')) delete place.git;
  return { place, rest };
}

// environment is the environment attachment the CLI puts before the agent's turns. The working directory and whether it
// is a git repository are the agent's, when the host tells them, and each is left out when it isn't told. The platform is
// the host's; the shell and OS version are left out (the sandbox cannot see them).
export function environment(place = {}) {
  const e = PROMPT.environment;
  const lines = [e.heading, e.invokedLine];
  if (place.dir) {
    lines.push(` - ${e.cwdLabel}: ${place.dir}`);
    if (place.git) lines.push(` - ${e.gitLabel}: ${place.git === 'yes' ? 'true' : 'false'}`);
  }
  lines.push(` - ${e.platformLabel}: ${NODE_PLATFORM[env.platform] ?? env.platform}`, ` - ${e.untrustedLine}`);
  return lines.join('\n');
}

/** today is the date, YYYY-MM-DD, at the UTC offset (minutes) the sign-in's console had; UTC without one. */
export function today(now = new Date(), utcOffsetMinutes = 0) {
  const d = new Date(now.getTime() + utcOffsetMinutes * 60_000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
}

// reminder is one of the CLI's attachments: a user turn whose text is the body hugged by a <system-reminder> tag, one line off each.
const reminder = (body) => ({ role: 'user', content: [{ type: 'text', text: '<system-reminder>\n' + body + '\n</system-reminder>' }] });

// reminders are the turns the CLI puts before the agent's: its environment, the powered-by line (left out with no model), the day.
function reminders(provider, model, place, utc) {
  const out = [reminder(environment(place))];
  if (model) out.push(reminder(PROMPT.poweredBy.replace('{provider}', provider).replace('{model}', model)));
  out.push(reminder(PROMPT.date.replace('{date}', today(new Date(), utc))));
  return out;
}

const cached = (t) => ({ type: 'text', text: t, cache_control: { type: 'ephemeral' } });

/**
 * dress returns a Messages request body as the CLI sends it: ZCode's prefix uncached, its identity section and its
 * dynamic sections cached, the agent's own system text after them uncached; the environment, the powered-by line and
 * the day as <system-reminder> turns before the agent's turns; no cache mark in the turns but on the last block of the
 * last; none on the tools; metadata.user_id naming the sign-in's device. A body that isn't a Messages request is
 * returned as it is. The input is not changed.
 */
export function dress(body, site, device, place, utc = 0) {
  if (!body || typeof body !== 'object' || !Array.isArray(body.messages)) return body;
  const b = JSON.parse(JSON.stringify(body));
  const provider = site === 'bigmodel' ? 'bigmodel-api' : 'zai-api';
  const model = typeof b.model === 'string' ? b.model : '';
  const own = [];
  if (typeof b.system === 'string') {
    if (b.system.trim()) own.push({ type: 'text', text: b.system });
  } else if (Array.isArray(b.system)) {
    for (const x of b.system) if (x?.type === 'text' && typeof x.text === 'string' && x.text) own.push({ type: 'text', text: x.text });
  }
  b.system = [{ type: 'text', text: PROMPT.cliPrefix }, cached(PROMPT.identity), cached('\n\n' + PROMPT.dynamic), ...own];
  b.messages = [...reminders(provider, model, place, utc), ...b.messages];
  let last = null;
  for (const m of b.messages) {
    if (!m || m.role === 'system') continue;
    last = m;
    if (Array.isArray(m.content)) for (const x of m.content) if (x && typeof x === 'object') delete x.cache_control;
  }
  if (last && typeof last.content === 'string') last.content = [cached(last.content)];
  else if (last && Array.isArray(last.content) && last.content.length) {
    const x = last.content[last.content.length - 1];
    if (x && typeof x === 'object' && !x.cache_control) x.cache_control = { type: 'ephemeral' };
  }
  if (Array.isArray(b.tools)) for (const t of b.tools) if (t && typeof t === 'object') delete t.cache_control;
  const meta = b.metadata && typeof b.metadata === 'object' ? b.metadata : {};
  b.metadata = { ...meta, user_id: JSON.stringify({ device_id: device, account_uuid: '', session_id: '' }) };
  return b;
}
