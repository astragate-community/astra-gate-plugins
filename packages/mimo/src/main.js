// Xiaomi MiMo's Token Plan as an Astra v2 provider: an account is a `tp-` API key and the plan's regional endpoint.
// Based on an MIT-licensed community plugin (see THIRD_PARTY_NOTICES.md).
import { AstraError, crypto, definePlugin, providers, t, ui } from 'astra';
import { DEFAULT_REGION, KEY_PREFIX, PREPARE_BUDGET, PROVIDER, REGIONS, SLOW_BUDGET, SOURCE, TP_LIFE, TP_MODELS, UA, APP_VERSION } from './constants.js';
import { cookieHeader } from './cookies.js';
import { forgetKey, knownKey, planKey } from './platform.js';
import { appPath, planPath, planUrl, renamedBody, withAutoModel } from './request.js';
import { fresh, parseXiaomi, secretOf } from './session.js';
import { pollSlice, signedInWith, startSignIn } from './signin.js';
import { usageOf } from './usage.js';
import { Lapsed, tryJSON } from './util.js';

/** An account's credential (the host-held secret): { key, base }. */
export function parseSecret(text) {
  try {
    const v = JSON.parse(text);
    return typeof v?.key === 'string' && v.key.startsWith(KEY_PREFIX) && Object.values(REGIONS).includes(v.base) ? v : null;
  } catch {
    return null;
  }
}

// the accounts the app refused (membership_required), and when: their requests go to the Token Plan for TP_LIFE
const onPlan = new Map();

const mkUnavailable = (e) => new AstraError('unavailable', e?.message ?? String(e));

// a Xiaomi account's request: the app's /route with the session's cookies, or — for an account the app refused — its Token Plan
async function xiaomiRequest(req, account, x) {
  let s;
  try {
    s = await fresh(account, { budget: PREPARE_BUDGET });
  } catch (e) {
    throw mkUnavailable(e);
  }
  const who = String(s.creds.userId);
  const since = onPlan.get(who);
  if (since && Date.now() - since < TP_LIFE) {
    // what the app's /route was asked for, as the plan names it (a key not read yet is read in `refresh`, which has the time)
    const tp = knownKey(who) ?? (await planKey(s.creds, PREPARE_BUDGET));
    if (tp) {
      const body = withAutoModel(req.body, TP_MODELS);
      return { url: tp.base + planPath(req.path), headers: { authorization: 'Bearer ' + tp.key }, ...(body === req.body ? {} : { body }) };
    }
    onPlan.delete(who);
  }
  const body = withAutoModel(req.body);
  return {
    url: s.creds.base.replace(/\/+$/, '') + '/route' + appPath(req.path),
    headers: { cookie: cookieHeader(s.cookies), 'x-mimo-source': SOURCE, 'user-agent': UA, 'x-client-version': APP_VERSION },
    ...(body === req.body ? {} : { body }),
  };
}

const provider = {
  async prepare(req, account) {
    if (req.protocol !== 'chat') throw new AstraError('not_supported', `Xiaomi MiMo speaks Chat Completions, not ${req.protocol}`);
    const raw = account ? await account.secret() : null;
    if (raw && parseXiaomi(raw)) return xiaomiRequest(req, account);
    const secret = account ? parseSecret(raw) : null;
    if (!secret) throw new AstraError('unavailable', "this Xiaomi MiMo account has no sign-in or Token Plan key; add one (a Xiaomi account, or a key starting with 'tp-')");
    const body = renamedBody(req.body);
    return { url: planUrl(secret.base, req.path), headers: { authorization: 'Bearer ' + secret.key }, ...(body === req.body ? {} : { body }) };
  },

  /**
   * After a 401 / 403 (the host sends the request again once this answers, unless it says expired). A Token Plan key does not
   * renew: a key the plan turned away needs a new one. A Xiaomi account: the app saying `membership_required` sends its
   * requests to the account's own Token Plan from now on; a Token Plan key that was turned away is read again; anything else
   * signs the account on again.
   */
  async refresh(account, failed) {
    const s = parseXiaomi(await account.secret());
    if (!s) return 'expired';
    const who = String(s.creds.userId);
    const text = String(failed?.body ?? '');
    if (failed?.status === 403 && tryJSON(text)?.error?.code === 'membership_required') {
      const tp = await planKey(s.creds, SLOW_BUDGET);
      if (!tp) return undefined; // no plan to fall back to: the refusal stands
      onPlan.set(who, Date.now());
      return 'renewed';
    }
    if (failed?.status === 401 && onPlan.has(who)) {
      forgetKey(who); // the key was reset at the platform: read it again
      return 'renewed';
    }
    try {
      const got = await fresh(account, { force: true, budget: SLOW_BUDGET });
      return got.renewed ? 'renewed' : undefined;
    } catch (e) {
      return e instanceof Lapsed ? 'expired' : undefined;
    }
  },

  async usage(account) {
    const raw = await account.secret();
    if (!parseXiaomi(raw)) return { plan: 'Token Plan', windows: [] };
    return usageOf(account);
  },
};

// ---- the sign-in flow (ui.flows): a Token Plan key and its region

/** The key's last four characters, for the account's name (the key itself is never shown again). */
const tail = (key) => '…' + key.slice(-4);

export async function addAccount({ region, key }) {
  const base = REGIONS[region] ?? REGIONS[DEFAULT_REGION];
  const account = { key: crypto.sha256(key).slice(0, 12), displayName: `Token Plan ${tail(key)}`, plan: 'Token Plan', status: 'active', secret: JSON.stringify({ key, base }) };
  const existing = await providers.accounts.list(PROVIDER);
  if (existing.some((a) => a.key === account.key)) await providers.accounts.update(PROVIDER, account.key, account);
  else await providers.accounts.add(PROVIDER, account);
}

const regionOptions = () => [
  { value: 'cn', label: t('signIn.region.cn') },
  { value: 'sgp', label: t('signIn.region.sgp') },
  { value: 'ru', label: t('signIn.region.ru') },
  { value: 'in', label: t('signIn.region.in') },
];

/** Adds the Xiaomi account (or signs the one already there in again). */
export async function addXiaomiAccount({ creds, cookies }) {
  const key = 'xiaomi-' + creds.userId;
  const account = { key, displayName: `Xiaomi ${creds.userId}`, plan: null, status: 'active', secret: secretOf(creds, cookies, Date.now()) };
  const existing = await providers.accounts.list(PROVIDER);
  if (existing.some((a) => a.key === key)) await providers.accounts.update(PROVIDER, key, account);
  else await providers.accounts.add(PROVIDER, account);
}

// the Xiaomi sign-in page's long poll is asked in slices a view action can hold (it has a wall-clock limit)
const SLICE_MS = 35_000;

/** Polls one slice; on a sign-in, adds the account and closes. Changes `state` in place so the flush shows it. */
async function wait(state, ctx) {
  state.error = null;
  state.waiting = true;
  ctx.flush();
  try {
    const got = await pollSlice(state.ticket, SLICE_MS);
    state.waiting = false;
    if (!got) return state;
    await addXiaomiAccount(await signedInWith(got, state.ticket.device));
    state.ticket = null;
    ctx.toast({ message: t('signIn.done'), tone: 'success' });
    ctx.close({ ok: true });
  } catch (e) {
    state.waiting = false;
    state.ticket = null;
    state.error = e?.message ?? String(e);
  }
  return state;
}

export const signIn = ui.defineView({
  init: () => ({ ticket: null, waiting: false, error: null }),
  render: (s) => {
    const xiaomi = s.ticket
      ? [
          ui.Text({ value: t('signIn.xiaomi.confirm') }),
          ui.Link({ label: t('signIn.xiaomi.open'), href: s.ticket.url }),
          s.waiting ? ui.Spinner({ label: t('signIn.xiaomi.waiting') }) : ui.Button({ label: t('signIn.xiaomi.continue'), variant: 'primary', onPress: 'wait' }),
        ]
      : [ui.Button({ label: t('signIn.xiaomi.start'), variant: 'primary', onPress: 'start' })];
    return ui.Stack({ gap: '4' }, [
      ui.Heading({ value: t('signIn.title'), level: 2 }),
      ...(s.error ? [ui.Alert({ tone: 'danger', message: s.error })] : []),
      ui.Section({ title: t('signIn.xiaomi'), description: t('signIn.xiaomi.body') }, xiaomi),
      ui.Section({ title: t('signIn.keyTitle'), description: t('signIn.body'), collapsible: true, defaultOpen: false }, [
        ui.Form({ onSubmit: 'save' }, [
          ui.Stack({ gap: '4' }, [
            ui.Field({ label: t('signIn.region'), required: true }, [ui.Select({ name: 'region', value: DEFAULT_REGION, options: regionOptions() })]),
            ui.Field({ label: t('signIn.key'), hint: t('signIn.keyHint'), required: true }, [ui.PasswordField({ name: 'key', placeholder: 'tp-…' })]),
            ui.Button({ label: t('signIn.save'), variant: 'primary', submit: true }),
          ]),
        ]),
      ]),
    ]);
  },
  actions: {
    start: async (s, _a, ctx) => {
      try {
        s.ticket = await startSignIn();
      } catch (e) {
        s.error = e?.message ?? String(e);
        return s;
      }
      ctx.openExternal(s.ticket.url);
      return wait(s, ctx);
    },
    wait: (s, _a, ctx) => wait(s, ctx),
    save: async (_s, args, ctx) => {
      const key = String(args?.values?.key ?? '').trim();
      const region = String(args?.values?.region ?? DEFAULT_REGION);
      if (!key.startsWith(KEY_PREFIX) || key.length < 12) return void ctx.fail({ key: t('signIn.invalid') });
      if (!(region in REGIONS)) return void ctx.fail({ region: t('signIn.invalid') });
      await addAccount({ region, key });
      ctx.toast({ message: t('signIn.done'), tone: 'success' });
      ctx.close({ ok: true });
    },
  },
});

export default definePlugin({
  activate(ctx) {
    ctx.subscriptions.push(providers.register(PROVIDER, provider));
  },
});
