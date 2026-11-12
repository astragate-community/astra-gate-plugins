// Cursor subscriptions as an Astra v2 provider: sign-in (the browser login cursor-agent does, or an API key), chat on the
// account's models, the model list and its usage card. Based on an MIT-licensed community plugin (see THIRD_PARTY_NOTICES.md).
//
// A chat is a Run on Cursor's agent API, a Connect stream both ways (protobuf frames in and out), run the way Cursor's clients
// run it over HTTP/1.1 (agent.js): prepare puts the run request up with a BidiAppend and hands the host the RunSSE request
// (a binary Connect body); the host reads the reply's Connect frames (reply.framing "connect") and transformResponse decodes
// each (decode.js), answering what the server asks for with more BidiAppends while the reply streams, and ends the reply once
// the answer is complete ({ $end: true }) although the Run stays open.
import { crypto, definePlugin, encoding, http, providers, storage, t, timers, ui } from 'astra';
import { API, WEBSITE } from './constants.js';
import { failure, maxRequired } from './errors.js';
import { conversation, toolsOf } from './conversation.js';
import { buildRun, conversationID, sessionOf } from './run.js';
import { request } from './variants.js';
import { Decoder } from './decode.js';
import { chunksOf, bodyOf } from './reply.js';
import { beat, close, first, open, runBody, runHeaders, runs, send } from './agent.js';
import { clientVersion, planName, whoIs } from './api.js';
import { expiry } from './jwt.js';
import { authOf, keyToken, tokenOf } from './session.js';
import { record, usable } from './models.js';
import { allowance, botUsage } from './usage.js';
import { b64urlBytes, unhex } from './util.js';

const PROVIDER = 'cursor';
const AUTO = { id: 'auto', name: 'Auto', protocol: 'chat', context: 200000, vision: true };

// how long prepare (5 s in all) gives the model list before the model goes by its name as it is (the list keeps loading)
const LIST_BUDGET = 2_000;
const MAX_ONLY = 'maxOnly'; // the ids Cursor said it serves in Max Mode only

const within = (p, ms) => Promise.race([p, timers.sleep(ms).then(() => null)]);

const provider = {
  // A chat: the Run's first message up (waited for), and the RunSSE request for the host to send.
  async prepare(req, account) {
    const began = Date.now();
    if (!account) throw Object.assign(new Error("Cursor isn't signed in"), { status: 401 });
    const tok = await tokenOf(await account.secret());
    const chat = req.body && typeof req.body === 'object' ? req.body : {};
    const model = String(chat.model ?? req.model ?? '');
    const raw = (await within(usable(tok, account.key).catch(() => null), LIST_BUDGET)) ?? [];
    // fast only when asked: a service_tier of priority or fast is on; any other tier, or none, is off
    const tier = chat.service_tier;
    const fast = tier === 'priority' || tier === 'fast' ? true : tier ? false : undefined;
    const picked = request(raw, model, chat.reasoning_effort ?? '', fast);
    const maxOnly = (await storage.get(MAX_ONLY)) ?? [];
    const maxMode = picked.maxMode || maxOnly.includes(picked.id);
    const tools = toolsOf(chat);
    const conv = conversation(chat, tools);
    const convID = conversationID(chat, sessionOf(chat, req.headers ?? {}));
    const { first: msg, blobs } = buildRun(conv.msgs, conv.last, tools, picked.id, convID, { maxMode, params: picked.params });
    const id = crypto.randomUUID();
    const run = open(id, tok, { blobs, tools, estimate: conv.estimate });
    try {
      await first(run, msg, Math.max(1_000, 4_500 - (Date.now() - began)));
    } catch (e) {
      close(id);
      throw e;
    }
    beat(run);
    return {
      url: API + '/agent.v1.AgentService/RunSSE',
      method: 'POST',
      headers: { ...runHeaders(tok, id), 'content-type': 'application/connect+proto' },
      body: runBody(id),
      state: { id, model: model || picked.id, cursorModel: picked.id },
    };
  },

  // The Run's reply, frame by frame, as a chat completion.
  transformResponse: {
    start(res, ctx) {
      const st = ctx.state;
      Object.assign(st, { cid: 'chatcmpl-' + encoding.hex.encode(crypto.randomBytes(12)), created: Math.floor(Date.now() / 1000), stream: !!ctx.request.stream });
      if (res.status < 200 || res.status > 299) {
        close(st.id);
        return { error: failure(res.status, res.body ?? '') };
      }
      const run = runs.get(st.id);
      if (!run) return { error: { status: 502, message: 'the Run was dropped before its reply came' } };
      st.dec = new Decoder({ send: (m) => send(run, m), blobs: run.blobs, tools: run.tools, estimate: run.estimate });
    },

    async frame(f, ctx) {
      const st = ctx.state;
      const failed = runs.get(st.id)?.failed;
      const events = failed && !st.dec.done ? [{ error: failed }] : f.end ? st.dec.end(f.json !== undefined ? JSON.stringify(f.json) : f.text ?? '') : st.dec.message(encoding.base64.decode(f.bytes));
      for (const e of events) if (e.error) await noteMaxOnly(st.cursorModel, e.error);
      const out = chunksOf(events, st);
      if (st.dec.done) {
        close(st.id);
        // the answer is complete; the Run would wait on the tool results: end the reply here
        if (!f.end && !out.some((o) => o.$error)) out.push({ $end: true });
      }
      return out;
    },

    end(ctx) {
      const st = ctx.state;
      const out = chunksOf(st.dec ? st.dec.eof() : [], st);
      close(st.id);
      if (!st.stream && !out.some((o) => o.$error)) out.push(bodyOf(st));
      return out;
    },

    dispose(ctx) {
      close(ctx.state.id);
    },
  },

  // the account's list: each picker model once for each context size, with that window
  async models(account) {
    if (!account) return [AUTO];
    const tok = await tokenOf(await account.secret()); // a list Cursor couldn't give is a failure: the host keeps the list it had
    return (await usable(tok, account.key)).map(record);
  },

  // Cursor has nothing to renew a browser sign-in with; an API key is exchanged for a new token
  async refresh(account) {
    const auth = authOf(await account.secret());
    if (auth?.type !== 'api' || !auth.key) return 'expired';
    await storage.delete('exchanged:' + crypto.sha256(auth.key));
    try {
      await keyToken(auth.key);
      return 'renewed';
    } catch {
      return 'expired';
    }
  },

  // how much of the plan's included usage is gone (the plan is the one the sign-in read)
  async usage(account) {
    let tok;
    try {
      tok = await tokenOf(await account.secret());
    } catch (e) {
      return { error: e.message, windows: [] };
    }
    const ids = await usable(tok, account.key).then((l) => l.map((m) => m.id), () => []);
    const [u, plan, bot] = await Promise.all([allowance(tok, ids), planName(tok).catch(() => ''), botUsage(tok)]);
    // Bot goes before Total for the three menu-bar rings
    const windows = [...u.windows.filter((w) => w.name !== 'Total'), ...bot, ...u.windows.filter((w) => w.name === 'Total')];
    return { ...u, windows, ...(plan ? { plan } : {}) };
  },
};

/** Adds the account, or — signing in again to one already there — replaces its credential. */
async function save(key, info, auth) {
  const secret = JSON.stringify(auth);
  const have = await providers.accounts.list(PROVIDER);
  if (have.some((a) => a.key === key)) await providers.accounts.update(PROVIDER, key, { ...info, status: 'active', secret });
  else await providers.accounts.add(PROVIDER, { key, ...info, secret });
}

const clean = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== ''));
const keyName = (key) => 'key-' + crypto.sha256(key).slice(0, 10);

/**
 * cursor-agent's `login`: the page signs in with a PKCE challenge, and /auth/poll hands the tokens over once it has.
 * Returns the tokens; throws with the words to show.
 */
export async function browserLogin({ open, wait = (ms) => timers.sleep(ms) }) {
  const verifier = b64urlBytes(crypto.randomBytes(32));
  const challenge = b64urlBytes(crypto.sha256(verifier, { encoding: "bytes" }));
  const uuid = crypto.randomUUID();
  open(`${WEBSITE}/loginDeepControl?challenge=${challenge}&uuid=${uuid}&mode=login&redirectTarget=cli`);
  const headers = { 'content-type': 'application/json', 'x-cursor-client-version': clientVersion(), 'x-cursor-client-type': 'cli' };
  let errors = 0;
  for (let r = 0; r < 150; r++) {
    const delay = Math.min(1000 * 1.2 ** r, 10_000);
    let res;
    try {
      res = await http.fetch(`${API}/auth/poll?uuid=${uuid}&verifier=${verifier}`, { headers, timeoutMs: 15_000 });
    } catch {
      if (++errors >= 3) throw new Error("couldn't reach Cursor");
      await wait(delay);
      continue;
    }
    if (res.status === 404) {
      errors = 0;
      await wait(delay);
      continue;
    }
    if (!res.ok) {
      if (res.status === 403 || ++errors >= 3) throw new Error(res.status === 403 ? 'Cursor refused the sign-in (403)' : `Cursor's sign-in answered HTTP ${res.status}`);
      await wait(delay);
      continue;
    }
    const j = await res.json().catch(() => null);
    if (!j?.accessToken || !('refreshToken' in j)) throw new Error('Cursor sent back no token');
    return j;
  }
  throw new Error('the sign-in timed out');
}

export const signIn = ui.defineView({
  state: { step: 'choose', error: '' },
  render: (s) => {
    const failed = s.error ? [ui.Alert({ tone: 'danger', message: s.error })] : [];
    if (s.step === 'waiting')
      return ui.Stack({ gap: '4' }, [
        ui.Heading({ value: t('signIn.waiting'), level: 2 }),
        ui.Text({ value: t('signIn.waiting.body') }),
        ui.Link({ label: t('signIn.open'), href: s.url }),
        ui.Spinner({ label: t('signIn.polling') }),
      ]);
    if (s.step === 'key')
      return ui.Form({ onSubmit: 'submitKey' }, [
        ui.Stack({ gap: '4' }, [
          ui.Heading({ value: t('signIn.key.title'), level: 2 }),
          ...failed,
          ui.Field({ label: t('signIn.key.label'), hint: t('signIn.key.hint'), required: true }, ui.PasswordField({ name: 'key', required: true })),
          ui.Stack({ direction: 'row', gap: '2' }, [
            ui.Button({ label: t('signIn.key.submit'), variant: 'primary', submit: true }),
            ui.Button({ label: t('signIn.back'), variant: 'ghost', onPress: 'back' }),
          ]),
        ]),
      ]);
    return ui.Stack({ gap: '4' }, [
      ui.Heading({ value: t('signIn.title'), level: 2 }),
      ui.Text({ value: t('signIn.body') }),
      ...failed,
      ui.Button({ label: t('signIn.browser'), variant: 'primary', onPress: 'browser' }),
      ui.Button({ label: t('signIn.key'), variant: 'secondary', onPress: 'key' }),
    ]);
  },
  actions: {
    back: (s) => void Object.assign(s, { step: 'choose', error: '' }),
    key: (s) => void Object.assign(s, { step: 'key', error: '' }),

    browser: async (s, _a, ctx) => {
      try {
        const j = await browserLogin({
          open: (url) => {
            Object.assign(s, { step: 'waiting', url, error: '' });
            ctx.openExternal(url);
            ctx.flush();
          },
        });
        const who = await whoIs(j.accessToken);
        const key = who.email || 'cursor-' + crypto.sha256(j.accessToken).slice(0, 8);
        const expires = expiry(j.accessToken) || Date.now() + 30 * 24 * 3600 * 1000;
        await save(key, clean({ displayName: key, email: who.email, plan: who.plan }), { type: 'oauth', access: j.accessToken, refresh: j.refreshToken || 'none', expires });
        ctx.toast({ message: t('signIn.done'), tone: 'success' });
        ctx.close({ ok: true, account: key });
      } catch (e) {
        Object.assign(s, { step: 'choose', error: e.message ?? String(e) });
      }
    },

    // a key from cursor.com/dashboard → Integrations, exchanged for a token as the CLI does with CURSOR_API_KEY
    submitKey: async (s, _a, ctx) => {
      const key = String(ctx.local.key ?? '').trim();
      if (!key) return void ctx.fail({ key: t('signIn.key.empty') });
      try {
        const tok = await keyToken(key);
        const who = await whoIs(tok);
        const name = who.email || keyName(key);
        await save(name, clean({ displayName: who.email || 'Cursor API key', email: who.email, plan: who.plan }), { type: 'api', key });
        ctx.toast({ message: t('signIn.done'), tone: 'success' });
        ctx.close({ ok: true, account: name });
      } catch (e) {
        ctx.fail({ key: e.message ?? String(e) });
      }
    },
  },
});

/**
 * A model Cursor serves only in Max Mode that neither list said so of: the next request asks for it in Max Mode, as the CLI
 * turns it on for such a model (v1 asked again at once; a reply can't, so this one fails saying so).
 */
async function noteMaxOnly(id, error) {
  if (!id || !maxRequired(error.message)) return;
  const have = (await storage.get(MAX_ONLY)) ?? [];
  if (!have.includes(id)) await storage.set(MAX_ONLY, [...have, id]);
  error.message += ' — the next request for this model goes in Max Mode; try again';
}

export default definePlugin({
  activate(ctx) {
    ctx.subscriptions.push(providers.register(PROVIDER, provider));
  },
});
