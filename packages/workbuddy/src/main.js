// WorkBuddy as an Astra v2 provider plugin: two providers (the China build `workbuddy` and the international build
// `workbuddy-ai`, the ids v1 used), a browser sign-in flow, the credits card, and the daily check-in as a page and a job.
// Based on an MIT-licensed community plugin (see THIRD_PARTY_NOTICES.md).
import { AstraError, config, crypto, definePlugin, jobs, log, providers, secrets, storage, t, ui } from 'astra';
import { meter, sign } from './api.js';
import { checkinOf } from './checkin.js';
import { PREPARE_TIMEOUT_MS } from './constants.js';
import { liveModels } from './models.js';
import { attend, normalizeToolChoice, sessionOf, withOwnSystem, withSystem } from './request.js';
import { current, mirrorName, refreshed } from './session.js';
import { saveAccount, signIn } from './signin.js';
import { SITES, anthropicApi, api, staticModels } from './sites.js';
import { fitted } from './tools.js';
import { enterpriseUsageOf, packagesOf, runsOutOf, usageOf } from './usage.js';

export { signIn };

// the plugin's own random salt for the ids a chat is named by (storage, not module state: an engine may be replaced)
async function saltOf() {
  let salt = await storage.get('salt');
  if (typeof salt !== 'string' || !salt) await storage.set('salt', (salt = crypto.randomUUID() + crypto.randomUUID()));
  return salt;
}

function providerOf(site) {
  return {
    async prepare(req, account) {
      if (!account) throw new AstraError('unavailable', `${site.name}: no account to send this request with`);
      let url;
      if (req.protocol === 'chat') url = api(site) + '/chat/completions';
      else if (req.protocol === 'anthropic' && site.anthropic) url = anthropicApi(site) + '/messages' + (req.path.includes('?') ? req.path.slice(req.path.indexOf('?')) : '');
      else throw new AstraError('not_supported', `${site.name} has no ${req.protocol} endpoint`);
      let a;
      try {
        a = await current(site, account, PREPARE_TIMEOUT_MS);
      } catch (e) {
        throw new AstraError('unavailable', e?.message ?? String(e));
      }
      const had = req.headers ?? {};
      const session = sessionOf(had);
      const salt = await saltOf();
      let body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? structuredClone(req.body) : req.body;
      if (req.protocol === 'anthropic') {
        // a model on WorkBuddy's own Anthropic route goes there as it is: the chat route's mending (a system message, tools
        // of OpenAI's shape, tool_choice's string) would break this body; Claude Code's system prompt is the one thing mended
        body = withOwnSystem(body);
      } else {
        body = normalizeToolChoice(fitted(withSystem(body)).body);
      }
      const headers = sign(site, a);
      attend(headers, had, body, session, salt);
      return { url, headers, body };
    },

    // the account's own list, as WorkBuddy's config gives it; the manifest's list when it can't
    async models(account) {
      if (!account) return staticModels(site);
      try {
        const a = await current(site, account, 10000);
        const list = await liveModels(site, a);
        return list.length ? list : staticModels(site);
      } catch (e) {
        log.warn(`${site.name}: model list from config failed: ${e?.message ?? e}`);
        return staticModels(site);
      }
    },

    refresh: (account) => refreshed(site, account),

    // the account's credits, as magpie's built-in showed them
    async usage(account) {
      const a = await current(site, account, 10000);
      // the meter has no /v2 prefix, on either site
      const sum = await meter(site, a, '/billing/meter/get-user-resource-summary');
      const out = usageOf(sum);
      // an enterprise account's summary has no packages: its credits are the enterprise meter's. A personal account's
      // refusal of it (10001 "uid or enterpriseID is empty") leaves the card as the summary said.
      if (!out.windows.length) {
        let ent = null;
        try {
          ent = enterpriseUsageOf(await meter(site, a, '/billing/meter/get-enterprise-user-usage'));
        } catch {
          // a personal account
        }
        if (ent) return { plan: 'Enterprise', windows: [ent] };
      }
      // when the credits left run out, for routing to spend them first; a list that can't be read leaves it unknown
      const credits = out.windows.find((w) => w.name === 'Credits');
      if (credits) {
        try {
          Object.assign(credits, runsOutOf(sum, await packagesOf(site, a)) ?? {});
        } catch {
          // the card stands
        }
      }
      return out;
    },
  };
}

// ---- the daily check-in (签到) ------------------------------------------------------------------------------------

const beijingDay = (now = Date.now()) => new Date(now + 8 * 3600_000).toISOString().slice(0, 10);
const RETRY_MS = 30 * 60 * 1000;

// every account of both builds, each with the means to read its sign-in: the host hands a provider's own calls the
// account's secret and nothing else does, so each sign-in is mirrored in the plugin's own `secrets` (see session saves)
async function accountsOf() {
  const out = [];
  for (const site of Object.values(SITES)) {
    for (const a of await providers.accounts.list(site.id)) {
      out.push({ site, info: a, shim: { key: a.key, secret: () => secrets.get(mirrorName(site, a.key)) } });
    }
  }
  return out;
}

const checkinKey = (site, key) => `${site.id}|${key}`;

/** Presses the check-in for one account; remembers what came of it. Returns the outcome record. */
export async function checkin(site, shim) {
  let r;
  try {
    r = await checkinOf(site, await current(site, shim, 15000));
  } catch (e) {
    r = { outcome: 'failed', message: e?.message ?? String(e) };
  }
  const rec = { ...r, at: Date.now(), day: beijingDay() };
  await storage.update('checkin', (all) => ({ ...(all ?? {}), [checkinKey(site, shim.key)]: rec }));
  return rec;
}

/** What the job does: every account not yet checked in today (or whose failure is 30 minutes old). Returns how many it pressed. */
export async function checkinDue() {
  const all = (await storage.get('checkin')) ?? {};
  const today = beijingDay();
  let n = 0;
  for (const { site, shim } of await accountsOf()) {
    const last = all[checkinKey(site, shim.key)];
    if (last && (last.outcome === 'claimed' || last.outcome === 'done') && last.day === today) continue;
    if (last && last.outcome !== 'claimed' && last.outcome !== 'done' && Date.now() - last.at < RETRY_MS) continue;
    if (!(await shim.secret())) continue;
    await checkin(site, shim);
    n++;
  }
  return n;
}

const outcomeText = (r) => {
  if (!r) return t('checkin.never');
  const p = { credit: r.credit ?? 0, streak: r.streak ?? 0, message: r.message ?? '' };
  const base = r.outcome === 'claimed' ? t('checkin.outcome.claimed', p) : r.outcome === 'done' ? t('checkin.outcome.done', p) : r.outcome === 'captcha' ? t('checkin.outcome.captcha', p) : t('checkin.outcome.failed', p);
  return `${base} · ${new Date(r.at).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
};

export const checkinPage = ui.defineView({
  init: async () => ({ rows: await rowsOf() }),
  render: (s) =>
    ui.Stack({ gap: '4' }, [
      ui.Section({ title: t('checkin.title'), description: t('checkin.description') }, [
        s.rows.length
          ? ui.Stack({ gap: '2' }, s.rows.map((r) => ui.Row({ key: r.id, label: `${r.site} · ${r.name}`, detail: r.detail }, [ui.Button({ label: t('checkin.press'), variant: 'secondary', onPress: { action: 'press', args: { id: r.id } } })])))
          : ui.EmptyState({ title: t('checkin.empty') }),
      ]),
      s.rows.length ? ui.Button({ label: t('checkin.all'), variant: 'primary', onPress: 'all' }) : ui.Spacer({}),
    ]),
  actions: {
    press: async (s, args, ctx) => {
      const hit = (await accountsOf()).find((x) => checkinKey(x.site, x.shim.key) === args.id);
      if (!hit) return;
      const r = await checkin(hit.site, hit.shim);
      ctx.toast({ message: outcomeText(r), tone: r.outcome === 'failed' || r.outcome === 'captcha' ? 'danger' : 'success' });
      s.rows = await rowsOf();
    },
    all: async (s, _a, ctx) => {
      for (const { site, shim } of await accountsOf()) await checkin(site, shim);
      ctx.toast({ message: t('checkin.allDone'), tone: 'success' });
      s.rows = await rowsOf();
    },
  },
});

async function rowsOf() {
  const all = (await storage.get('checkin')) ?? {};
  return (await accountsOf()).map(({ site, info }) => ({
    id: checkinKey(site, info.key),
    site: site.name,
    name: info.displayName || info.key,
    detail: outcomeText(all[checkinKey(site, info.key)]),
  }));
}

// ---- upgrade from the v1 package -----------------------------------------------------------------------------------

// v1's plugin-auth.json entries for this package, keyed `<provider>` or `<provider>#<account>`: a browser sign-in is
// carried over (its tokens are the same ones), one that used WorkBuddy desktop's own file (`source: "desktop"`) is not
// (a v2 plugin can't read that file; sign in with the browser)
export async function importV1(auth) {
  let n = 0;
  for (const [key, entry] of Object.entries(auth ?? {})) {
    const site = SITES[key.split('#')[0]];
    if (!site || entry?.type !== 'oauth' || entry.source === 'desktop' || !entry.access) continue;
    const a = {
      access: entry.access,
      refresh: entry.refresh ?? '',
      expires: entry.expires ?? 0,
      uid: entry.uid ?? '',
      ...(entry.domain ? { domain: entry.domain } : {}),
      ...(entry.enterpriseId ? { enterpriseId: entry.enterpriseId } : {}),
      ...(entry.refreshExpiresAt ? { refreshExpiresAt: entry.refreshExpiresAt } : {}),
      ...(entry.tokenType ? { tokenType: entry.tokenType } : {}),
    };
    await saveAccount(site, a, entry.accountId || site.name);
    n++;
  }
  return n;
}

export default definePlugin({
  async activate(ctx) {
    for (const site of Object.values(SITES)) ctx.subscriptions.push(providers.register(site.id, providerOf(site)));
    ctx.subscriptions.push(
      jobs.handle('checkin', async () => {
        if (config.get().autoCheckin === false) return;
        await checkinDue();
      }),
    );
    if (ctx.reason === 'upgrade' && ctx.upgrade?.from?.auth) {
      try {
        const n = await importV1(ctx.upgrade.from.auth);
        if (n) log.info(`took over ${n} WorkBuddy sign-in(s) from the v1 plugin`);
      } catch (e) {
        log.warn(`could not take over the v1 sign-ins: ${e?.message ?? e}`);
      }
    }
  },
});
