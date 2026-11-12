// Signing in: the devin CLI's own round (PKCE through app.devin.ai), with the callback pasted back because a v2 plugin cannot
// listen on 127.0.0.1; or the session token itself (`windsurf_api_key` in the CLI's credentials.toml, or `devin auth token`).
import { crypto, encoding, providers, t, ui } from 'astra';
import { AUTHORIZE, PROVIDER, REDIRECT } from './constants.js';
import { exchange } from './api.js';
import { accountOf } from './identity.js';

/** Unpadded base64url of bytes. */
export const base64url = (bytes) => encoding.base64url.encode(bytes);
export const randomToken = (n) => base64url(crypto.randomBytes(n));
export const challengeOf = (verifier) => base64url(crypto.sha256(verifier, { encoding: 'bytes' }));

/** The sign-in page's address, and the verifier / state to keep until the callback is pasted. */
export function begin() {
  const verifier = randomToken(48);
  const state = randomToken(24);
  const q = new URLSearchParams({ redirect_uri: REDIRECT, state, prompt: 'select_account', code_challenge: challengeOf(verifier), code_challenge_method: 'S256', cli_pkce_marker: '1' });
  return { verifier, state, url: `${AUTHORIZE}?${q}` };
}

/** The code (and state) in what the user pasted: the whole callback URL, or the bare code. */
export function codeOf(text) {
  const s = String(text ?? '').trim();
  if (!s) return {};
  try {
    const u = new URL(s);
    return { code: u.searchParams.get('code') ?? undefined, state: u.searchParams.get('state') ?? undefined, error: u.searchParams.get('error_description') || u.searchParams.get('error') || undefined };
  } catch {
    return { code: s };
  }
}

async function save(key) {
  const account = await accountOf(key);
  const { key: id, ...rest } = account;
  const exists = (await providers.accounts.list(PROVIDER)).some((a) => a.key === id);
  if (exists) await providers.accounts.update(PROVIDER, id, { ...rest, status: 'active', secret: key });
  else await providers.accounts.add(PROVIDER, { key: id, ...rest, secret: key });
  return account;
}

export const signIn = ui.defineView({
  init: () => ({ step: 'choose', begun: null, error: '' }),
  render: (s) => {
    const kids = [ui.Heading({ value: t('signIn.title'), level: 2 }), ui.Alert({ tone: 'warning', message: t('signIn.limit') })];
    if (s.error) kids.push(ui.Alert({ tone: 'danger', message: s.error }));
    if (s.step === 'browser') {
      kids.push(
        ui.Text({ value: t('signIn.browser.body') }),
        ui.Link({ label: t('signIn.browser.open'), href: s.begun.url }),
        ui.Form({ onSubmit: 'finish' }, [
          ui.Field({ label: t('signIn.browser.label'), hint: t('signIn.browser.hint'), required: true }, ui.TextField({ name: 'callback', placeholder: REDIRECT + '?code=…&state=…' })),
          ui.Button({ label: t('signIn.finish'), variant: 'primary', submit: true }),
        ]),
        ui.Button({ label: t('signIn.back'), variant: 'ghost', onPress: 'back' }),
      );
    } else if (s.step === 'token') {
      kids.push(
        ui.Text({ value: t('signIn.token.body') }),
        ui.Form({ onSubmit: 'useToken' }, [
          ui.Field({ label: t('signIn.token.label'), required: true }, ui.PasswordField({ name: 'token', placeholder: 'devin-session-token$…' })),
          ui.Button({ label: t('signIn.finish'), variant: 'primary', submit: true }),
        ]),
        ui.Button({ label: t('signIn.back'), variant: 'ghost', onPress: 'back' }),
      );
    } else {
      kids.push(
        ui.Stack({ direction: 'row', gap: '2' }, [
          ui.Button({ label: t('signIn.browser.title'), variant: 'primary', onPress: 'browser' }),
          ui.Button({ label: t('signIn.token.title'), variant: 'secondary', onPress: 'token' }),
        ]),
      );
    }
    return ui.Stack({ gap: '4' }, kids);
  },
  actions: {
    browser: (s, _a, ctx) => {
      s.begun = begin();
      s.step = 'browser';
      s.error = '';
      ctx.openExternal(s.begun.url);
    },
    token: (s) => void ((s.step = 'token'), (s.error = '')),
    back: (s) => void ((s.step = 'choose'), (s.error = '')),
    finish: async (s, _a, ctx) => {
      const got = codeOf(ctx.local.callback);
      if (got.error) return void (s.error = got.error);
      if (!got.code) return void ctx.fail({ callback: t('signIn.browser.empty') });
      if (got.state !== undefined && got.state !== s.begun.state) return void (s.error = t('signIn.browser.state'));
      try {
        const account = await save(await exchange(got.code, s.begun.verifier, REDIRECT));
        ctx.toast({ message: t('signIn.done', { name: account.displayName }), tone: 'success' });
        ctx.close({ ok: true });
      } catch (e) {
        s.error = e?.message ?? String(e);
      }
    },
    useToken: async (s, _a, ctx) => {
      const key = String(ctx.local.token ?? '').trim();
      if (!key) return void ctx.fail({ token: t('signIn.token.empty') });
      try {
        const account = await save(key);
        ctx.toast({ message: t('signIn.done', { name: account.displayName }), tone: 'success' });
        ctx.close({ ok: true });
      } catch (e) {
        s.error = e?.message ?? String(e);
      }
    },
  },
});
