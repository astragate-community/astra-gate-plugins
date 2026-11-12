// WorkBuddy: signing in through the browser — WorkBuddy's own page, which the plugin polls for the token — and keeping
// the account. WorkBuddy desktop's own sign-in file is not read: a v2 plugin has no file access (see README).
import { providers, secrets, t, timers, ui } from 'astra';
import { call, domainOf } from './api.js';
import { APP_VERSION, POLL_MS, SIGN_IN_MS } from './constants.js';
import { hex } from './request.js';
import { keepAuth, merge, mirrorName } from './session.js';
import { SITES } from './sites.js';

// enterpriseOf is the enterprise the account a sign-in gave belongs to: the one /login/account names, else, for an
// account that isn't personal, the one WorkBuddy's account list has for it — the same choice WorkBuddy's own client makes
// (mergeCurrentAccountDetails): the uid's only entry of that type, or the only one it last signed in to. None found is
// personal.
async function enterpriseOf(site, a, who) {
  const own = typeof who?.enterpriseId === 'string' ? who.enterpriseId.trim() : '';
  if (own) return own;
  const type = String(who?.type ?? '').trim().toLowerCase();
  if (!type || type === 'personal') return '';
  let list;
  try {
    list = await call(site, 'GET', '/v2/plugin/accounts', { Authorization: 'Bearer ' + a.access, 'X-Domain': domainOf(site, a) });
  } catch {
    return '';
  }
  const mine = (list?.accounts ?? []).filter((x) => x?.uid === who.uid && typeof x.enterpriseId === 'string' && x.enterpriseId.trim());
  const same = mine.filter((x) => String(x.type ?? '').trim().toLowerCase() === type);
  const last = mine.filter((x) => x.lastLogin);
  const pick = same.length === 1 ? same[0] : last.length === 1 ? last[0] : mine.length === 1 ? mine[0] : undefined;
  return pick ? pick.enterpriseId.trim() : '';
}

// poll asks path until WorkBuddy answers with data, retrying the codes that mean "not yet". `over()` says the user gave up.
async function poll(site, path, headers, retry, deadline, over) {
  for (;;) {
    if (over()) throw Object.assign(new Error('cancelled'), { cancelled: true });
    if (Date.now() > deadline) throw new Error(`${site.name} sign-in timed out`);
    try {
      const data = await call(site, 'GET', path, headers);
      if (data && Object.keys(data).length) return data;
    } catch (e) {
      if (!(retry.includes(e.code) || e.status === 408 || e.status === 429)) throw e;
    }
    await timers.sleep(POLL_MS);
  }
}

/** Asks WorkBuddy for a sign-in page: { state, url }. */
export async function beginSignIn(site) {
  const state = await call(site, 'POST', `/v2/plugin/auth/state?platform=${encodeURIComponent(site.platform)}`, {
    'X-No-Authorization': 'true',
    'X-No-User-Id': 'true',
    'X-No-Enterprise-Id': 'true',
    'X-No-Department-Info': 'true',
  }, {});
  if (!state?.state || !state?.authUrl) throw new Error(`${site.name} gave no sign-in page`);
  const url = new URL(state.authUrl);
  if (url.protocol !== 'https:') throw new Error(`${site.name}'s sign-in page isn't https`);
  url.searchParams.set('version', APP_VERSION);
  url.searchParams.set('loginSessionId', hex());
  return { state: state.state, url: url.toString() };
}

/** Waits for the sign-in the page began: the stored auth ({ access, refresh, … uid, enterpriseId }) and the account's name. */
export async function finishSignIn(site, begun, over = () => false) {
  const deadline = Date.now() + SIGN_IN_MS;
  const q = encodeURIComponent(begun.state);
  const token = await poll(site, `/v2/plugin/auth/token?state=${q}`, {}, [11217], deadline, over);
  if (!token.accessToken) throw new Error(`${site.name} sent back no token`);
  const a = merge({}, token);
  const who = await poll(site, `/v2/plugin/login/account?state=${q}`, {
    Authorization: 'Bearer ' + a.access,
    'X-Domain': domainOf(site, a),
    'X-No-User-Id': 'true',
    'X-No-Enterprise-Id': 'true',
  }, [12151], deadline, over);
  a.uid = who.uid ?? '';
  const enterpriseId = await enterpriseOf(site, a, who);
  if (enterpriseId) a.enterpriseId = enterpriseId;
  return { auth: a, name: who.nickname || who.phoneNumber || who.uid || site.name };
}

/** The account key of a sign-in: the uid, and the enterprise it signed in as. */
export const keyOf = (a) => (a.enterpriseId ? `${a.uid}#${a.enterpriseId}` : String(a.uid || 'account'));

/** Adds the account, or renews the one with that key. */
export async function saveAccount(site, auth, name) {
  const key = keyOf(auth);
  const secret = JSON.stringify(auth);
  const exists = (await providers.accounts.list(site.id)).some((x) => x.key === key);
  if (exists) await keepAuth(site, key, auth, { displayName: name, status: 'active' });
  else {
    await providers.accounts.add(site.id, { key, displayName: name, secret });
    await secrets.set(mirrorName(site, key), secret);
  }
  return key;
}

// ---- the sign-in flow (ui.flows) ----------------------------------------------------------------------------------

// the sign-ins the user gave up on, by view session (module state is only a cache: a replaced engine forgets it, and the
// poll that ran in it is gone with it)
const gaveUp = new Set();

// the build a flow's params name: the provider id the host passes, as the plugin's own or the host's row id
function siteOf(params) {
  const p = String(params?.provider ?? '');
  if (!p) return null;
  return p.endsWith('workbuddy-ai') ? SITES['workbuddy-ai'] : SITES.workbuddy;
}

export const signIn = ui.defineView({
  init: (ctx) => ({ site: siteOf(ctx.params)?.id ?? null, phase: 'idle', url: '', error: '' }),
  render: (s) => {
    const kids = [ui.Heading({ value: t('signIn.title'), level: 2 })];
    if (s.site === null) {
      kids.push(
        ui.Text({ value: t('signIn.choose') }),
        ui.Stack({ direction: 'row', gap: '2' }, [
          ui.Button({ label: t('signIn.site.workbuddy'), variant: 'primary', onPress: { action: 'start', args: { site: 'workbuddy' } } }),
          ui.Button({ label: t('signIn.site.workbuddy-ai'), variant: 'secondary', onPress: { action: 'start', args: { site: 'workbuddy-ai' } } }),
        ]),
      );
    } else if (s.phase === 'waiting') {
      kids.push(
        ui.Text({ value: t('signIn.waiting', { name: SITES[s.site].name }) }),
        ui.Link({ label: t('signIn.open'), href: s.url }),
        ui.Spinner({}),
        ui.Button({ label: t('signIn.cancel'), variant: 'ghost', onPress: 'cancel' }),
      );
    } else {
      kids.push(ui.Text({ value: t('signIn.body', { name: SITES[s.site].name }) }));
      if (s.error) kids.push(ui.Alert({ tone: 'danger', message: s.error }));
      kids.push(ui.Button({ label: t(s.error ? 'signIn.retry' : 'signIn.start'), variant: 'primary', onPress: { action: 'start', args: { site: s.site } } }));
    }
    return ui.Stack({ gap: '4' }, kids);
  },
  actions: {
    start: async (s, args, ctx) => {
      const site = SITES[args?.site ?? s.site];
      if (!site) return;
      s.site = site.id;
      s.error = '';
      gaveUp.delete(ctx.session);
      try {
        const begun = await beginSignIn(site);
        s.phase = 'waiting';
        s.url = begun.url;
        ctx.openExternal(begun.url);
        ctx.flush();
        const done = await finishSignIn(site, begun, () => gaveUp.has(ctx.session));
        await saveAccount(site, done.auth, done.name);
        ctx.toast({ message: t('signIn.done', { name: done.name }), tone: 'success' });
        ctx.close({ ok: true });
      } catch (e) {
        s.phase = 'idle';
        s.error = e?.cancelled ? '' : (e?.message ?? String(e));
      }
    },
    cancel: (s, _a, ctx) => {
      gaveUp.add(ctx.session);
      s.phase = 'idle';
    },
  },
});
