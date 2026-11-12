// Factory: what an access token says about itself. The engine has no atob/Buffer, so base64url is decoded here.
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

export function base64urlToText(input) {
  const s = String(input).replace(/-/g, "+").replace(/_/g, "/").replace(/=+$/, "");
  let bits = 0;
  let acc = 0;
  let escaped = "";
  for (const ch of s) {
    const v = ALPHABET.indexOf(ch);
    if (v < 0) throw new Error("not base64");
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      escaped += "%" + ((acc >> bits) & 255).toString(16).padStart(2, "0");
      acc &= (1 << bits) - 1;
    }
  }
  return decodeURIComponent(escaped);
}

export function claims(jwt) {
  try {
    const part = String(jwt ?? "").split(".")[1];
    return JSON.parse(base64urlToText(part)) ?? {};
  } catch {
    return {};
  }
}

export const claim = (c, k) => (typeof c[k] === "string" ? c[k] : "");

// expiry is when an access token lapses, from its exp; 0 when it doesn't say.
export function expiry(access) {
  const exp = claims(access).exp;
  return typeof exp === "number" && exp > 0 ? Math.floor(exp) * 1000 : 0;
}
