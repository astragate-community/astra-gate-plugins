// Factory (Droid) subscriptions as an Astra v2 provider. Based on an MIT-licensed community plugin (see
// THIRD_PARTY_NOTICES.md): the same requests, shaped as droid sends them, over the host's provider transport.
import { AstraError, definePlugin, providers } from "astra";
import { PROVIDER } from "./constants.js";
import { shaped } from "./request.js";
import { transformResponse } from "./reply.js";
import { fresh, repair } from "./session.js";
import { saveAccount, signIn } from "./signin.js";
import { readUsage } from "./usage.js";

export { signIn };

const provider = {
  async prepare(req, account) {
    if (!account) throw new AstraError("unavailable", "Factory: no account is signed in");
    const { url, headers, body } = shaped(await fresh(account), req);
    return body === req.body ? { url, headers } : { url, headers, body };
  },
  refresh: (account, failed) => repair(account, failed),
  transformResponse,
  usage: (account) => readUsage(account),
};

// what a v1 plugin-auth.json entry (OpenCode's auth.json shape) becomes: the secret of an account
function fromV1(entry) {
  if (entry?.type === "api" && typeof entry.key === "string" && entry.key.trim()) {
    const md = entry.metadata ?? {};
    return {
      type: "key", access: entry.key.trim(), refresh: "", expires: 0, email: md.email ?? "", userId: md.userId ?? "",
      activeOrganizationId: "", region: md.region ?? "", premBaseHost: md.premBaseHost ?? "", whoKnown: typeof md.region === "string",
    };
  }
  if (entry?.type === "oauth" && entry.access) {
    return {
      type: "oauth", access: entry.access, refresh: entry.refresh ?? "", expires: entry.expires ?? 0, orgId: entry.orgId ?? "",
      email: entry.email ?? "", userId: entry.userId ?? "", activeOrganizationId: entry.activeOrganizationId ?? "",
      region: entry.region ?? "", premBaseHost: entry.premBaseHost ?? "",
    };
  }
  return null;
}

export default definePlugin({
  async activate(ctx) {
    ctx.subscriptions.push(providers.register(PROVIDER, provider));
    // an upgrade from the v1 plugin hands its sign-ins over once
    const auth = ctx.upgrade?.from?.auth;
    if (auth && typeof auth === "object") {
      const have = await providers.accounts.list(PROVIDER);
      if (!have.length) {
        for (const entry of Object.values(auth)) {
          const c = fromV1(entry);
          if (c) await saveAccount({ ...c, email: c.email || (typeof entry.accountId === "string" ? entry.accountId : "") });
        }
      }
    }
  },
});
