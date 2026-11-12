// Qoder's subscriptions (qoder.com and Qoder CN, qoder.cn) as an Astra v2 provider plugin, one provider for each site.
//
// Qoder is signed in to the way its desktop client is: a PKCE device flow whose device token is traded for the job token the
// model calls use. Its models are served on the API its client talks to, agent_chat_generation's SSE, signed with the
// client's COSY envelope. `prepare` writes the gateway's chat completion as Qoder's request and signs it; `transformResponse`
// turns Qoder's SSE envelope back into a chat completion (streamed or whole), lifting the tool calls Qoder writes as XML in its
// text out as tool calls. The protocol (endpoints, COSY envelope, device flow) is ported from magpie's internal/qoder, which ported
// it from CLIProxyAPI's qoder support (https://github.com/ufec/CLIProxyAPI, MIT).
import { AstraError, definePlugin, providers } from 'astra';
import { CHAT_PATH, SITES } from './constants.js';
import { cosyHeaders } from './cosy.js';
import { builtinModel, hostModel, listingOf } from './models.js';
import { qoderBody } from './request.js';
import { end, frame, start } from './response.js';
import { creds } from './session.js';
import { signInView } from './signin.js';
import { hostJson } from './util.js';

export const signIn = signInView(SITES.qoder);
export const signInCn = signInView(SITES['qoder-cn']);

const gone = (e) => new AstraError(e?.gone ? 'permission_denied' : 'unavailable', String(e?.message ?? e));

function providerOf(site) {
  return {
    async prepare(req, account) {
      if (req.protocol !== 'chat' || !/\/chat\/completions$/.test(String(req.path ?? '').split('?')[0]))
        throw new AstraError('not_supported', `${site.name} answers chat completions only, not ${req.path}`);
      const chat = req.body && typeof req.body === 'object' ? req.body : null;
      if (!chat) throw new AstraError('invalid_argument', "a request that isn't JSON");
      let cred;
      try {
        cred = await creds(site, account);
      } catch (e) {
        throw gone(e);
      }
      const model = String(req.model ?? chat.model ?? '');
      let m;
      try {
        m = (await listingOf(site, cred)).find((x) => x.key === model) ?? (await listingOf(site, cred, true)).find((x) => x.key === model);
      } catch (e) {
        throw new AstraError('invalid_argument', String(e?.message ?? e));
      }
      if (!m) throw new AstraError('invalid_argument', `unknown or disabled model "${model}"`);
      const url = site.api + CHAT_PATH;
      // the host writes the body it is given as JSON; the signature covers those bytes
      const body = qoderBody({ ...chat, model }, m);
      return {
        url,
        method: 'POST',
        headers: { ...cosyHeaders(url, cred, hostJson(body)), Accept: 'text/event-stream', 'Cache-Control': 'no-cache', 'X-Model-Key': m.key, 'X-Model-Source': m.source },
        body,
      };
    },

    // the account's own list, as Qoder's client asks it
    async models(account) {
      if (!account) return site.models.map(builtinModel);
      try {
        const ms = await listingOf(site, await creds(site, account), true);
        return ms.length ? ms.map(hostModel) : site.models.map(builtinModel);
      } catch {
        return site.models.map(builtinModel);
      }
    },

    // a chat token Qoder turned down: renewed, or the sign-in is gone
    async refresh(account) {
      try {
        await creds(site, account, { force: true });
        return 'renewed';
      } catch (e) {
        return e?.expired ? 'expired' : undefined;
      }
    },

    transformResponse: { start, frame, end },
  };
}

export default definePlugin({
  activate(ctx) {
    for (const site of Object.values(SITES)) ctx.subscriptions.push(providers.register(site.id, providerOf(site)));
  },
});
