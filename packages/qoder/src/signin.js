// Qoder: the sign-in — a PKCE device flow (the site's page, then a poll of its openapi for the device token), whose device
// token is traded for the job token the model calls use. Qoder CN falls back to chatting on the device token when its job token
// is refused. The poll runs in slices of one action (the sign-in code stays good between them), so a long wait never holds
// one action open.
import { crypto, encoding, providers, t, timers, ui } from 'astra';
import { SIGN_IN_MS, SLICE_MS } from './constants.js';
import { openapi } from './api.js';
import { deviceExpiry, expiresAt } from './session.js';
import { blank } from './util.js';

const randomToken = (bytes) => encoding.base64url.encode(crypto.randomBytes(bytes));
// the S256 PKCE challenge of a verifier
export const challengeOf = (verifier) => encoding.base64url.encode(crypto.digest('sha256', verifier, { encoding: 'bytes' }));

/** The device flow's start: what the browser opens and the poll asks with. */
export function begin(site) {
  const verifier = randomToken(64);
  const nonce = crypto.randomUUID();
  const machineId = crypto.randomUUID();
  const q = new URLSearchParams({ challenge: challengeOf(verifier), challenge_method: 'S256', nonce, machine_id: machineId, client_id: site.clientId });
  if (site.redirect) q.set('redirect_uri', site.redirect);
  return { url: `${site.web}/device/selectAccounts?${q}`, nonce, verifier, machineId, until: Date.now() + SIGN_IN_MS };
}

// pollDeviceToken asks for the device token every 2 seconds until the user has authorized it, or the slice is over (null).
export async function pollDeviceToken(site, d, budgetMs = Infinity, sleep = (ms) => timers.sleep(ms)) {
  const sliceEnd = Date.now() + budgetMs;
  for (;;) {
    if (Date.now() > d.until) throw new Error(`${site.name}: the sign-in timed out; start again`);
    if (Date.now() + 2000 > sliceEnd) return null;
    try {
      const r = await openapi(site, '/api/v1/deviceToken/poll', { query: { nonce: d.nonce, verifier: d.verifier, challenge_method: 'S256' } });
      if (r.status === 200 && !blank(r.json?.token)) return r.json;
    } catch {} // a hiccup: ask again
    await sleep(2000);
  }
}

// chatTokens is the token pair the model calls run on: the job token the device token is traded for, or, on a site whose job
// token is refused, the device token itself.
export async function chatTokens(site, dt) {
  const jr = await openapi(site, '/api/v1/me/jobToken', { method: 'POST', token: dt.token, body: { clientId: site.clientId } });
  if (jr.status === 200) {
    if (blank(jr.json?.token)) throw new Error(`${site.name} job token: empty token in response`);
    return { access: jr.json.token, refresh: jr.json.refresh_token ?? '', expires: expiresAt(jr.json) };
  }
  if (site.deviceChat && jr.status >= 400 && jr.status < 500) {
    // Qoder CN's CLI never makes a job token: its device token is what signs the model calls, renewed as a device token
    return { access: dt.token, refresh: dt.refresh_token ?? '', expires: deviceExpiry(dt), deviceChat: true };
  }
  throw new Error(`${site.name} job token: status ${jr.status}: ${jr.text.trim().slice(0, 300)}`);
}

/** The account the device token stands for, ready to save: { key, email, secret }. */
export async function finish(site, d, dt) {
  const chat = await chatTokens(site, dt);
  let email = '';
  let name = '';
  try {
    const info = await openapi(site, '/api/v1/userinfo', { token: dt.token });
    if (info.status >= 200 && info.status < 300) [email, name] = [info.json?.email ?? '', info.json?.name ?? ''];
  } catch {}
  const uid = dt.user_id;
  if (blank(uid)) throw new Error(`${site.name}: the sign-in named no user`);
  const key = email || String(uid);
  return {
    key,
    email,
    secret: JSON.stringify({ ...chat, uid, email, name: name || dt.user_name || '', machineId: d.machineId, deviceToken: dt.token, deviceRefresh: dt.refresh_token ?? '' }),
  };
}

/** Adds the account, or puts the new sign-in into the one of that key (a re-login). */
export async function keep(site, a) {
  const info = { displayName: a.email || a.key, ...(a.email ? { email: a.email } : {}), status: 'active', secret: a.secret };
  const existing = await providers.accounts.list(site.id);
  if (existing.some((x) => x.key === a.key)) await providers.accounts.update(site.id, a.key, info);
  else await providers.accounts.add(site.id, { key: a.key, ...info });
}

// polls one slice; on a token, adds the account and closes. Changes `s` in place so a flush shows it.
async function wait(site, s, ctx) {
  s.error = null;
  s.waiting = true;
  ctx.flush();
  try {
    const dt = await pollDeviceToken(site, s.begun, SLICE_MS);
    s.waiting = false;
    if (!dt) return s;
    await keep(site, await finish(site, s.begun, dt));
    ctx.toast({ message: t('signIn.done', { site: site.name }), tone: 'success' });
    ctx.close({ ok: true });
  } catch (e) {
    s.waiting = false;
    s.begun = null;
    s.error = e?.message ?? String(e);
  }
  return s;
}

/** The sign-in view of a site. */
export const signInView = (site) =>
  ui.defineView({
    init: () => ({ begun: null, waiting: false, error: null }),
    render: (s) =>
      ui.Stack({ gap: '4' }, [
        ui.Heading({ value: t('signIn.title', { site: site.name }), level: 2 }),
        ...(s.error ? [ui.Alert({ tone: 'danger', message: s.error })] : []),
        ui.Text({ value: t('signIn.body', { site: site.name }) }),
        ...(s.begun
          ? [
              ui.Link({ label: t('signIn.open'), href: s.begun.url }),
              s.waiting ? ui.Spinner({ label: t('signIn.waiting') }) : ui.Button({ label: t('signIn.continue'), variant: 'primary', onPress: 'wait' }),
            ]
          : [ui.Button({ label: t('signIn.start', { site: site.name }), variant: 'primary', onPress: 'start' })]),
      ]),
    actions: {
      start: (s, _a, ctx) => {
        s.begun = begin(site);
        ctx.openExternal(s.begun.url);
        return wait(site, s, ctx);
      },
      wait: (s, _a, ctx) => wait(site, s, ctx),
    },
  });
