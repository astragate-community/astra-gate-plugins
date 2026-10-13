// Factory: API keys (fk-…) as accounts.

// API keys
//
// A Factory API key (fk-…), as droid takes one from FACTORY_API_KEY: its
// om() hands the key on as the token, sent as "Authorization: Bearer fk-…"
// with the headers every request carries, and never renewed. droid's active
// org (st(), X-Factory-Org-Id) is what a sign-in stored, so a key alone
// sends none. As the built-in's factory_key.go keeps one.

export const isKey = (a) => a?.type === "api" && typeof a.key === "string" && a.key.trim() !== ""

// keyAccount is a key as the account the requests are signed with.
export function keyAccount(a) {
  const md = a.metadata ?? {}
  const key = a.key.trim()
  return {
    key: true,
    access: key,
    refresh: "",
    expires: 0,
    accountId: md.email || md.userId || "",
    email: md.email ?? "",
    userId: md.userId ?? "",
    activeOrganizationId: "",
    region: md.region ?? "",
    premBaseHost: md.premBaseHost ?? "",
    whoKnown: typeof md.region === "string",
  }
}