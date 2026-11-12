// Factory: an account's tokens, renewed and kept in the right org. An account is one JSON secret the host keeps:
//   { type: "oauth", access, refresh, expires, orgId, activeOrganizationId, region, premBaseHost, email, userId }
//   { type: "key",   access (the fk-… key), region, email, userId }
import { AstraError, providers } from "astra";
import { ASK_AGAIN, PROVIDER, REFRESH_LEAD } from "./constants.js";
import { FactoryStatus, lapsed, orgRefused, refused } from "./errors.js";
import { firstOrg, renew, whoami } from "./api.js";
import { expiry } from "./jwt.js";

/** Puts the access token (and its expiry) of a WorkOS answer on c; the refresh token too when it rotated. */
export function applyTokens(c, t) {
  c.access = t.access_token;
  c.expires = expiry(t.access_token);
  if (t.refresh_token) c.refresh = t.refresh_token;
}

/** Keeps where Factory serves the org whoami names: its region and its own host, if any. */
export function adoptPlace(c, who) {
  c.region = who.region ?? "";
  c.premBaseHost = who.premBaseHostV2 ?? "";
}

/** Fills in whose account it is, from whoami, where the sign-in didn't say. */
export function adoptIdentity(c, who) {
  c.email ||= who.email ?? "";
  c.userId ||= who.userId ?? "";
}

// reconcile asks whoami, as droid does for each token it holds, and keeps the org, region and host it names: true
// when any changed. An active org whoami refuses is left off and whoami asked again without it.
export async function reconcile(c) {
  let who;
  try {
    who = await whoami(c);
  } catch (e) {
    if (!(c.activeOrganizationId && e instanceof FactoryStatus && e.code === 403)) return false;
    try {
      who = await whoami({ ...c, activeOrganizationId: "" });
    } catch {
      return false;
    }
  }
  if (!who?.orgId) return false;
  const changed = c.activeOrganizationId !== who.orgId || (c.region ?? "") !== (who.region ?? "") || (c.premBaseHost ?? "") !== (who.premBaseHostV2 ?? "");
  c.activeOrganizationId = who.orgId;
  adoptPlace(c, who);
  return changed;
}

// serializes checking, rotating and saving tokens: WorkOS rotates the refresh token, so two refreshes would spend
// it twice. (A module variable is only a cache — 01 §3 — but this one only orders calls inside one engine.)
let lock = Promise.resolve();
const locked = (fn) => {
  const run = lock.then(fn, fn);
  lock = run.catch(() => {});
  return run;
};
// when each account last asked whoami for its org, and when its token was last renewed (caches)
const asked = new Map();
const renewedAt = new Map();

/** Forgets what the caches know (tests). */
export function resetCaches() {
  asked.clear();
  renewedAt.clear();
}

export async function read(account) {
  const raw = await account.secret();
  try {
    const c = JSON.parse(raw);
    if (c && typeof c.access === "string") return c;
  } catch {}
  throw new AstraError("unavailable", "Factory: this account has no readable sign-in; sign in again");
}

export const save = (account, c) => providers.accounts.update(PROVIDER, account.key, { secret: JSON.stringify(c) });

// the account row says it needs signing in again
const expire = (account) => providers.accounts.update(PROVIDER, account.key, { status: "expired" }).catch(() => {});

/**
 * A live credential for a request: the token renewed first when it is near its end. `prepare` has five seconds, so
 * this does the renewal only; the org and region are kept right by `repair` (the host calls `refresh` after a
 * refusal).
 */
export const fresh = (account) =>
  locked(async () => {
    const c = await read(account);
    if (c.type === "key" || !c.refresh) return c;
    if (c.expires > 0 && Date.now() < c.expires - REFRESH_LEAD) return c;
    try {
      applyTokens(c, await renew(c.refresh, "", 4_000));
    } catch (e) {
      if (refused(e)) {
        await expire(account);
        throw new AstraError("unavailable", lapsed(c, e).message);
      }
      // a hiccup while the token still runs: go on with it
      if (c.expires > 0 && Date.now() < c.expires) return c;
      throw e;
    }
    renewedAt.set(account.key, Date.now());
    await save(account, c);
    return c;
  });

/**
 * What the host's `refresh` does after Factory refused a request: renews a token that was not just renewed, asks
 * whoami again so an org the account can no longer reach is dropped, and puts a token that names no org in the first
 * one /api/cli/org lists. 'renewed' when anything changed, 'expired' when WorkOS refused the refresh token for good.
 */
export const repair = (account, failed) =>
  locked(async () => {
    const c = await read(account);
    let changed = false;
    const status = failed?.status ?? 0;
    const isOrg = orgRefused(status, String(failed?.body ?? ""));
    if (c.type === "key") {
      if (c.whoKnown || Date.now() - (asked.get(account.key) ?? 0) < ASK_AGAIN) return undefined;
      asked.set(account.key, Date.now());
      try {
        const who = await whoami({ ...c, activeOrganizationId: "" });
        adoptPlace(c, who);
        adoptIdentity(c, who);
        c.whoKnown = true;
        await save(account, c);
        return "renewed";
      } catch {
        return undefined;
      }
    }
    if (status === 403) {
      // Factory refused the request itself (v1's mendOrg). An org that was sent and is not what the refusal is about: leave it.
      if (c.activeOrganizationId) {
        if (!isOrg) return undefined;
        const was = c.activeOrganizationId;
        c.activeOrganizationId = "";
        if ((await reconcile(c)) && c.activeOrganizationId === was) c.activeOrganizationId = ""; // whoami names the org refused: send none
        asked.set(account.key, Date.now());
        await save(account, c);
        return "renewed";
      }
      if (!isOrg) {
        asked.set(account.key, Date.now());
        if ((await reconcile(c)) && c.activeOrganizationId) {
          await save(account, c);
          return "renewed";
        }
        return undefined;
      }
      // no org was sent and Factory still refuses one: put the token in the first org it lists
    } else if (c.refresh && Date.now() - (renewedAt.get(account.key) ?? 0) > 60_000) {
      try {
        applyTokens(c, await renew(c.refresh, ""));
        renewedAt.set(account.key, Date.now());
        changed = true;
      } catch (e) {
        if (refused(e)) {
          await expire(account);
          return "expired";
        }
      }
    }
    asked.set(account.key, Date.now());
    if (await reconcile(c)) changed = true;
    if (!c.activeOrganizationId && c.refresh) {
      let org = "";
      try {
        org = await firstOrg(c);
      } catch {}
      if (org) {
        try {
          applyTokens(c, await renew(c.refresh, org));
          c.orgId = org;
          changed = true;
        } catch {}
      }
    }
    if (!changed) return undefined;
    await save(account, c);
    return "renewed";
  });
