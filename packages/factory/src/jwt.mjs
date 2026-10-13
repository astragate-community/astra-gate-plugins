// Factory: what an access token says about itself.

export function claims(jwt) {
  try {
    const part = String(jwt ?? "").split(".")[1]
    return JSON.parse(Buffer.from(part.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8")) ?? {}
  } catch {
    return {}
  }
}

export const claim = (c, k) => (typeof c[k] === "string" ? c[k] : "")

// expiry is when an access token lapses, from its exp; 0 when it doesn't say.
export function expiry(access) {
  const exp = claims(access).exp
  return typeof exp === "number" && exp > 0 ? Math.floor(exp) * 1000 : 0
}