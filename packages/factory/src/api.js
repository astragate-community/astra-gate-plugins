// Factory: calling WorkOS and Factory's API with the headers droid sends. Everything goes through the host's
// http.fetch, so only the origins in the manifest's net: permissions are reachable.
import { http } from "astra";
import { API, API_EU, CLIENT_ID, VERSION, WORKOS } from "./constants.js";
import { FactoryStatus, signInFailure, statusLine, vendorError } from "./errors.js";

const form = (fields) => Object.entries(fields).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&");

// workos posts a form to WorkOS: the answer and its status.
export async function workos(path, fields, timeoutMs = 30_000) {
  const res = await http.fetch(WORKOS + path, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: form(fields),
    timeoutMs,
  });
  return { text: await res.text(), status: res.status };
}

// authenticate asks WorkOS for tokens. A 400 carrying an OAuth error is an answer, not a failure: the device
// flow's polls are told to wait so.
export async function authenticate(fields, timeoutMs) {
  const { text, status } = await workos("/authenticate", fields, timeoutMs);
  let t = {};
  try {
    t = JSON.parse(text) ?? {};
  } catch {}
  t.status = status;
  if (status !== 200 && !t.error) throw signInFailure(status, text);
  return t;
}

// renew trades a refresh token for a new pair, in the WorkOS org when one is named (droid's way of putting a token
// that names no org in one); droid's routine refresh names none, and WorkOS keeps the org.
export async function renew(refresh, org, timeoutMs = 20_000) {
  const fields = { grant_type: "refresh_token", refresh_token: refresh, client_id: CLIENT_ID };
  if (org) fields.organization_id = org;
  const t = await authenticate(fields, timeoutMs);
  if (t.error) throw new FactoryStatus(t.status, "Factory: " + `${t.error} ${t.error_description ?? ""}`.trim());
  if (!t.access_token) throw new Error("Factory: the refresh gave no access token");
  return t;
}

// base is the Factory API the account's org is served from. An org with a host of its own (premBaseHost) is not
// reachable: the manifest's net: permissions name Factory's two public origins only.
export const base = (c) => (c.region === "eu" ? API_EU : API);

// factoryHeaders are what droid sends on every call to Factory's API.
export function factoryHeaders(c) {
  const h = {
    authorization: "Bearer " + c.access,
    "x-factory-client": "cli",
    "x-client-version": VERSION,
    "user-agent": "factory-cli/" + VERSION,
  };
  if (c.activeOrganizationId) h["x-factory-org-id"] = c.activeOrganizationId;
  return h;
}

// the text of an answer of Factory's; anything but a 200 is a FactoryStatus carrying the body
async function okText(res) {
  const text = await res.text();
  if (res.status !== 200) throw new FactoryStatus(res.status, "Factory: " + vendorError(text, statusLine(res.status)), text);
  return text;
}

// factoryGet reads a JSON answer of Factory's API, asked with the headers droid sends on every call.
export async function factoryGet(c, path, timeoutMs = 30_000) {
  const res = await http.fetch(base(c) + path, { headers: { accept: "application/json", ...factoryHeaders(c) }, timeoutMs });
  return JSON.parse(await okText(res));
}

// firstOrg is the first WorkOS org /api/cli/org says the account is in, "" for none. droid asks it with the bearer
// token alone.
export async function firstOrg(c) {
  const r = await factoryGet({ ...c, activeOrganizationId: "" }, "/api/cli/org");
  return r?.workosOrgIds?.[0] ?? "";
}

// whoami asks Factory whose the token is with the headers droid's whoami sends: the token, X-Factory-Whoami-Extended,
// and the active org when there is one — nothing else.
export async function whoami(c, timeoutMs = 10_000) {
  const h = { authorization: "Bearer " + c.access, "x-factory-whoami-extended": "true" };
  if (c.activeOrganizationId) h["x-factory-org-id"] = c.activeOrganizationId;
  const res = await http.fetch(base(c) + "/api/cli/whoami", { headers: h, timeoutMs });
  return JSON.parse(await okText(res)) ?? {};
}
