// An account's key and server: where its requests go, and the CLI's sign-in read again.
import { readFile } from "node:fs/promises"
import { SERVER } from "./constants.mjs"
import { cliCredentialsPath, readCredentials } from "./cli.mjs"

// serverUrl is the first of the candidate API servers that is set, without trailing slashes.
export const serverUrl = (...candidates) => candidates.find(Boolean).replace(/\/+$/, "")

// serverOf is the API server an account's requests go to:
// WINDSURF_API_SERVER_URL moves it, as it does the CLI's.
export const serverOf = (auth) => serverUrl(process.env.WINDSURF_API_SERVER_URL, auth?.metadata?.server, SERVER)

// live is the key and server an account has now: one taken from the CLI's
// sign-in reads credentials.toml again, as a `devin auth login` since may
// have changed it, and keeps the ones it was saved with while the CLI has
// none.
export async function live(auth) {
  if (auth?.metadata?.cli) {
    try {
      const c = readCredentials(await readFile(cliCredentialsPath(), "utf8"))
      if (c.windsurf_api_key) return { key: c.windsurf_api_key, server: serverUrl(process.env.WINDSURF_API_SERVER_URL, c.api_server_url, SERVER) }
    } catch {}
  }
  return { key: auth?.key, server: serverOf(auth) }
}
