// Factory: the sign-in flow (ui.flows) — WorkOS's device flow under droid's client, or a Factory API key — and what
// a finished sign-in becomes: an account whose secret is the token set (session.js).
import { providers, timers, ui, t } from "astra";
import { claim, claims, expiry } from "./jwt.js";
import { authenticate, firstOrg, renew, whoami, workos } from "./api.js";
import { CLIENT_ID, PROVIDER } from "./constants.js";
import { signInFailure } from "./errors.js";
import { adoptIdentity, adoptPlace, applyTokens } from "./session.js";

// signedInWith is the account WorkOS just signed in, as droid keeps it: a token that names no org (the JWT's
// external_org_id or org_id) is put in the first org /api/cli/org lists, and whoami, asked without an org header,
// gives Factory's own id for the org the token is in (the active org droid then sends as X-Factory-Org-Id) and where
// Factory serves it from. droid carries on without either when they fail.
export async function signedInWith(tokens) {
  const cl = claims(tokens.access_token);
  const c = {
    type: "oauth",
    access: tokens.access_token,
    refresh: tokens.refresh_token ?? "",
    expires: expiry(tokens.access_token),
    orgId: tokens.organization_id || claim(cl, "org_id"),
    email: tokens.user?.email || claim(cl, "email"),
    userId: tokens.user?.id || claim(cl, "sub"),
    activeOrganizationId: "",
    region: "",
    premBaseHost: "",
  };
  if (!c.orgId && !claim(cl, "external_org_id")) {
    let org = "";
    try {
      org = await firstOrg(c);
    } catch {}
    if (org) {
      applyTokens(c, await renew(c.refresh, org));
      c.orgId = org;
    }
  }
  try {
    const who = await whoami(c);
    c.activeOrganizationId = who.orgId ?? "";
    adoptPlace(c, who);
    adoptIdentity(c, who);
  } catch (e) {
    if (!c.email && !c.userId) throw e;
  }
  if (!(c.email || c.userId)) throw new Error("signed in, but Factory didn't say whose account it is; try again");
  return c;
}

// the account an API key is: whoami, asked with the key and no org (droid's st() is null for a key), says whose it is
// and where its organization is served; a whoami that fails leaves the key as it is and repair asks again later.
export async function keyAccount(key) {
  const c = { type: "key", access: key.trim(), refresh: "", expires: 0, email: "", userId: "", activeOrganizationId: "", region: "", premBaseHost: "", whoKnown: false };
  try {
    const who = await whoami(c);
    adoptPlace(c, who);
    adoptIdentity(c, who);
    c.whoKnown = true;
  } catch {}
  return c;
}

/** Puts a signed-in account in the provider: a new row, or the secret of the one the same person already has. */
export async function saveAccount(c) {
  const name = c.email || c.userId || "Factory key";
  const key = c.email || c.userId || "key-" + c.access.slice(-8);
  const existing = await providers.accounts.list(PROVIDER);
  const info = { displayName: name, email: c.email || null, secret: JSON.stringify(c), status: "active" };
  if (existing.some((a) => a.key === key)) await providers.accounts.update(PROVIDER, key, info);
  else await providers.accounts.add(PROVIDER, { key, ...info });
  return key;
}

// polls WorkOS until the code is confirmed: the sign-in's tokens
async function pollDevice(dc, shouldStop) {
  let interval = Math.max(dc.interval ?? 0, 1) * 1000;
  // WorkOS answers expired_token once the code lapses; stop a little after that regardless, so a lost poll can't run forever
  const until = Date.now() + (Math.max(dc.expires_in ?? 0, 300) + 30) * 1000;
  for (;;) {
    await timers.sleep(interval);
    if (shouldStop()) throw new Error(t("signIn.cancelled"));
    if (Date.now() > until) throw new Error(t("signIn.expired"));
    let tokens;
    try {
      tokens = await authenticate({ grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: dc.device_code, client_id: CLIENT_ID });
    } catch {
      continue; // a hiccup: ask again
    }
    if (tokens.error === "authorization_pending") continue;
    if (tokens.error === "slow_down") {
      interval += 1000;
      continue;
    }
    if (tokens.error === "expired_token") throw new Error(t("signIn.expired"));
    if (tokens.error === "access_denied") throw new Error(t("signIn.denied"));
    if (tokens.error || !tokens.access_token) throw new Error("Factory: " + (`${tokens.error ?? ""} ${tokens.error_description ?? ""}`.trim() || "no token came back"));
    return tokens;
  }
}

let stopped = false;

export const signIn = ui.defineView({
  state: { step: "choose", code: "", url: "", error: "" },
  render: (s) => {
    if (s.step === "device")
      return ui.Stack({ gap: "4" }, [
        ui.Heading({ value: t("signIn.title"), level: 2 }),
        ui.Text({ value: t("signIn.confirm") }),
        ui.Code({ value: s.code }),
        ui.Stack({ direction: "row", gap: "2", align: "center" }, [
          ui.Link({ label: t("signIn.open"), href: s.url }),
          ui.CopyButton({ value: s.code, label: t("signIn.copy") }),
        ]),
        ui.Stack({ direction: "row", gap: "2", align: "center" }, [ui.Spinner({}), ui.Text({ value: t("signIn.waiting") })]),
        s.error ? ui.Alert({ tone: "danger", title: s.error }) : null,
        ui.Button({ label: t("signIn.cancel"), onPress: "cancel" }),
      ].filter(Boolean));
    if (s.step === "key")
      return ui.Stack({ gap: "4" }, [
        ui.Heading({ value: t("signIn.title"), level: 2 }),
        ui.Field({ label: t("signIn.key.label"), hint: t("signIn.key.hint") }, ui.PasswordField({ name: "key", placeholder: "fk-…" })),
        s.error ? ui.Alert({ tone: "danger", title: s.error }) : null,
        ui.Stack({ direction: "row", gap: "2", align: "center" }, [
          ui.Button({ label: t("signIn.key.save"), variant: "primary", onPress: "saveKey" }),
          ui.Button({ label: t("signIn.back"), onPress: "back" }),
        ]),
      ].filter(Boolean));
    return ui.Stack({ gap: "4" }, [
      ui.Heading({ value: t("signIn.title"), level: 2 }),
      ui.Text({ value: t("signIn.body") }),
      s.error ? ui.Alert({ tone: "danger", title: s.error }) : null,
      ui.Button({ label: t("signIn.device"), variant: "primary", onPress: "device" }),
      ui.Button({ label: t("signIn.key"), onPress: "key" }),
    ].filter(Boolean));
  },
  actions: {
    key: (s) => void Object.assign(s, { step: "key", error: "" }),
    back: (s) => void Object.assign(s, { step: "choose", error: "" }),
    cancel: (s) => {
      stopped = true;
      Object.assign(s, { step: "choose", error: "" });
    },
    saveKey: async (s, _a, ctx) => {
      const key = String(ctx.local.key ?? "").trim();
      if (!key) return void ctx.fail({ key: t("signIn.key.empty") });
      await saveAccount(await keyAccount(key));
      ctx.toast({ message: t("signIn.done"), tone: "success" });
      ctx.close({ ok: true });
    },
    device: async (s, _a, ctx) => {
      stopped = false;
      s.error = "";
      try {
        const { text, status } = await workos("/authorize/device", { client_id: CLIENT_ID });
        if (status !== 200) throw signInFailure(status, text);
        const dc = JSON.parse(text);
        if (!dc.device_code || !dc.user_code) throw new Error("Factory's sign-in gave no device code");
        Object.assign(s, { step: "device", code: dc.user_code, url: dc.verification_uri_complete || dc.verification_uri });
        ctx.openExternal(s.url);
        ctx.flush();
        const account = await signedInWith(await pollDevice(dc, () => stopped));
        await saveAccount(account);
      } catch (e) {
        if (stopped) return;
        Object.assign(s, { step: "choose", error: e?.message ?? String(e) });
        return;
      }
      ctx.toast({ message: t("signIn.done"), tone: "success" });
      ctx.close({ ok: true });
    },
  },
});
