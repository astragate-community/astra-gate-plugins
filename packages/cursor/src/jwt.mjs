// A JWT's payload: what a token says of when it runs out and whose it is.
// jwtClaims is a JWT's payload; it throws when the token isn't one.
export const jwtClaims = (tok) => JSON.parse(Buffer.from(tok.split(".")[1], "base64url").toString("utf8"))

// expiry is when a JWT runs out, in ms; 0 when it doesn't say.
export function expiry(tok) {
  if (String(tok ?? "").split(".").length !== 3) return 0
  try {
    const exp = jwtClaims(String(tok)).exp
    return typeof exp === "number" && exp > 0 ? exp * 1000 : 0
  } catch {
    return 0
  }
}
