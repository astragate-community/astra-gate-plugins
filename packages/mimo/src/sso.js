// Xiaomi MiMo: signing the account on at a MiMo server.
import { accountJar, follow } from './cookies.js';
import { appHeaders } from './constants.js';
import { Lapsed, statusLine, tryJSON } from './util.js';

export { Lapsed };

/**
 * Signs the account on at a MiMo server as the app's window does: the server's /user/xiaomi/me, asked with no session,
 * sends the browser to account.xiaomi.com's serviceLogin, which (holding the passToken) sends it back through the server's
 * /sts, where the session cookies are set, to /user/xiaomi/me again. The server's cookies are the session.
 */
export async function session(creds, base, budget) {
  const jar = accountJar(creds);
  const { res } = await follow(jar, base.replace(/\/+$/, '') + '/user/xiaomi/me', {
    headers: appHeaders(),
    budget,
    home: base,
    tooMany: 'Xiaomi MiMo sign-in: too many redirects',
    failed: (e) => new Error('Xiaomi MiMo sign-in: ' + (e?.message ?? e)),
  });
  // a server error is a hiccup, not a passToken that stopped working
  if (res.status >= 500) throw new Error(`Xiaomi MiMo sign-in: ${statusLine(res.status)}`);
  const me = tryJSON(await res.text());
  // Xiaomi's sign-in page, not the server's answer: the passToken no longer signs the account on
  if (me === undefined) throw new Lapsed('Xiaomi MiMo: the Xiaomi sign-in has lapsed; sign in again');
  if (res.status === 403 || me?.code === 403 || me?.code === 46109) {
    throw new Error("Xiaomi MiMo doesn't serve this Xiaomi account (its region isn't served here)");
  }
  if (me?.code !== 0 || !String(me?.data?.userId ?? '')) throw new Lapsed('Xiaomi MiMo: the Xiaomi sign-in has lapsed; sign in again');
  const cookies = {};
  for (const c of jar.for(new URL(base).href)) cookies[c.name] = c.value;
  if (!Object.keys(cookies).length) throw new Error('Xiaomi MiMo sign-in: the server set no session');
  return { cookies, me: me.data };
}
