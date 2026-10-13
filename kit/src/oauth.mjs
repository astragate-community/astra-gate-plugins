import { createServer } from "node:http"
import { createHash, randomBytes } from "node:crypto"

/** A URL-safe random string: a state, or a PKCE verifier. */
export const randomToken = (bytes = 24) => randomBytes(bytes).toString("base64url")

/** The S256 PKCE challenge of a verifier. */
export const challengeOf = (verifier) => createHash("sha256").update(verifier).digest("base64url")

/**
 * Listens on the first of `ports` that is free, on 127.0.0.1, for a browser sign-in to come back to; throws
 * `busy` when none is. The caller adds its own "request" handler and closes the server.
 */
export async function listenOnFirstFree(ports, busy = "all the ports the sign-in comes back to are busy") {
  for (const port of ports) {
    const server = createServer()
    const ok = await new Promise((resolve) => {
      server.once("error", () => resolve(false))
      server.listen(port, "127.0.0.1", () => resolve(true))
    })
    if (ok) return { server, port }
  }
  throw new Error(busy)
}
