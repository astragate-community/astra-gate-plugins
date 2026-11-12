// Trae CN (trae.cn) and Trae international (trae.ai) as two Astra v2 providers: the account's browser sign-in (the
// IDE's own authorization page; the callback address is pasted back), its token renewal, its model list, its allowance
// card and Trae CN's daily check-in. Based on an MIT-licensed community plugin (see THIRD_PARTY_NOTICES.md).
//
// Chat: `prepare` shapes the request for the IDE agent (llm_utils_chat) and the manifest's `reply` block with
// `transformResponse` turns Trae's own SSE events into an OpenAI chat reply (reply.js, parts.js).
import { AstraError, config, crypto, definePlugin, jobs, log, providers, storage, t, ui } from 'astra';
import { checkIn } from './checkin.js';
import { Expired } from './errors.js';
import { catalog, chooseModels, fallbackModels, liveLists, modelsOf, remember } from './models.js';
import { ideHeaders } from './api.js';
import { chatBody, conversationID } from './request.js';
import { forgetRefusals, lastFn, refusedBy, rememberTools, transformResponse } from './reply.js';
import { fresh, keyOf, load, newDevice, renew, save } from './session.js';
import { authorizationUrl, CALLBACK, signedIn } from './signin.js';
import { MAX, SITES } from './sites.js';
import { readUsage } from './usage.js';
import { queryOf } from './values.js';

const markExpired = (site, key) => providers.accounts.update(site.id, key, { status: 'expired' }).catch(() => {});

// the account's model list, read live and remembered (which function lists each model, its __dev name, its Max)
const liveModels = async (site, a) => remember(site, chooseModels(await liveLists(a, site), site));

const provider = (site) => ({
  async prepare(req, account) {
    if (!account) throw new AstraError('auth_required', t('chat.noAccount', { name: site.name }));
    let a;
    try {
      a = await fresh(site, account.key);
    } catch (e) {
      if (e instanceof Expired) {
        await markExpired(site, account.key);
        throw new AstraError('auth_expired', e.message);
      }
      throw e;
    }
    const body = req.body ?? {};
    if (!Array.isArray(body.messages)) throw new AstraError('invalid_request', t('chat.only', { name: site.name }));
    const model = String(req.model ?? body.model ?? '');
    const { listedBy, modelNames } = catalog(site);
    // the function that lists the model first, then the one that served it last, then the rest; one a refusal named
    // ("this function doesn't take the model") is left for the later ones
    let named = modelNames.get(model);
    if (!named && model.endsWith(MAX)) {
      // a Max asked before the list was read here: read it
      await liveModels(site, a).catch(() => {});
      named = modelNames.get(model);
    }
    const tag = account.key + '|' + model;
    const all = [...new Set([named?.fn, listedBy.get(model), lastFn.get(tag), ...site.functions].filter(Boolean))];
    let fns = all.filter((f) => !refusedBy(account.key, model, f));
    if (!fns.length) {
      forgetRefusals(account.key, model);
      fns = all;
    }
    const fn = fns[0];
    const listed = named?.fn === fn || named?.max;
    const max = named?.max ?? null;
    const asked = { ...body, model };
    lastFn.set(tag, fn);
    rememberTools(account.key, model, Array.isArray(body.tools) ? body.tools : []);
    return {
      url: site.apiOf(a) + '/api/agent/v3/llm_utils_chat',
      headers: ideHeaders(a, site, { Accept: 'text/event-stream' }),
      body: chatBody(asked, fn, listed ? named.name : '', listed ? named.most : 0, max, conversationID(asked, '', a.uid || a.name)),
    };
  },
  transformResponse: transformResponse(site),
  async models(account) {
    if (account) {
      try {
        const live = modelsOf(await liveModels(site, await fresh(site, account.key)), site);
        if (live.length) return live;
      } catch (e) {
        if (e instanceof Expired) await markExpired(site, account.key);
        else log.warn(`${site.id}: the account's model list could not be read: ${e?.message ?? e}`);
      }
    }
    return fallbackModels(site);
  },
  async refresh(account) {
    const a = await load(site, account.key);
    if (!a?.refresh) return 'expired';
    try {
      await renew(site, account.key, a);
      return 'renewed';
    } catch (e) {
      return e instanceof Expired ? 'expired' : undefined;
    }
  },
  usage: (account) => readUsage(site, () => fresh(site, account.key), () => markExpired(site, account.key)),
});

async function addAccount(site, a) {
  const key = keyOf(a);
  await save(site, key, a);
  const row = { displayName: a.name || a.uid, status: 'active', secret: key };
  const known = await providers.accounts.list(site.id);
  if (known.some((x) => x.key === key)) await providers.accounts.update(site.id, key, row);
  else await providers.accounts.add(site.id, { key, ...row });
  return key;
}

// the sign-in flow (ui.flows): open the realm's authorization page, then paste back the address it ends on
const signInView = (site) =>
  ui.defineView({
    init: () => ({ device: newDevice(), trace: crypto.randomUUID() }),
    render: (s) =>
      ui.Stack({ gap: '4' }, [
        ui.Heading({ value: t('signIn.title', { name: site.name }), level: 2 }),
        ui.Text({ value: t('signIn.step1', { host: site.webHost }) }),
        ui.Button({ label: t('signIn.open', { name: site.name }), variant: 'primary', onPress: 'open' }),
        ui.Text({ value: t('signIn.step2', { callback: CALLBACK }) }),
        ui.Form({ onSubmit: 'submit' }, [
          ui.Field({ label: t('signIn.paste.label'), hint: t('signIn.paste.hint'), required: true }, ui.TextArea({ name: 'callback', rows: 4, mono: true, placeholder: CALLBACK + '?userJwt=…' })),
          ui.Button({ label: t('signIn.submit'), variant: 'primary', submit: true }),
        ]),
        ui.Text({ value: t('signIn.note', { id: s.device.deviceId }) }),
      ]),
    actions: {
      open: (s, _a, ctx) => ctx.openExternal(authorizationUrl(site, s.device, s.trace)),
      submit: async (s, args, ctx) => {
        const q = queryOf(args?.values?.callback);
        if (q.size === 0) return ctx.fail({ callback: t('signIn.nothing') });
        try {
          const a = await signedIn(q, s.device, site);
          await addAccount(site, a);
          ctx.toast({ message: t('signIn.done', { name: a.name || a.uid || site.name }), tone: 'success' });
          ctx.close({ ok: true });
        } catch (e) {
          ctx.fail({ callback: e?.message ?? String(e) });
        }
      },
    },
  });

export const signInCn = signInView(SITES['trae-cn']);
export const signInGlobal = signInView(SITES['trae-global']);

// Trae CN's daily check-in, once a day (Beijing time) for each account that is signed in
async function dailyCheckIn() {
  if (config.get().checkin !== true) return;
  const site = SITES['trae-cn'];
  const day = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
  for (const acc of await providers.accounts.list(site.id)) {
    if (acc.enabled === false || acc.status === 'expired') continue;
    if ((await storage.get('checkin.' + acc.key)) === day) continue;
    try {
      const r = await checkIn(site, await fresh(site, acc.key));
      if (r.state === 'expired') await markExpired(site, acc.key);
      else if (r.state === 'failed') log.warn(`trae-cn check-in: ${r.message || 'failed'}${r.code ? ` (code ${r.code})` : ''}`);
      else {
        await storage.set('checkin.' + acc.key, day);
        log.info(`trae-cn check-in: ${r.state}`);
      }
    } catch (e) {
      if (e instanceof Expired) await markExpired(site, acc.key);
      else log.warn(`trae-cn check-in: ${e?.message ?? e}`);
    }
  }
}

export default definePlugin({
  activate(ctx) {
    for (const site of Object.values(SITES)) ctx.subscriptions.push(providers.register(site.id, provider(site)));
    ctx.subscriptions.push(jobs.handle('checkin', dailyCheckIn));
  },
});

export { dailyCheckIn };
