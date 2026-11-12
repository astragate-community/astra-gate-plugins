// Antigravity's own OAuth client, an installed app's: its "secret" ships inside the app and is no secret.
// The values themselves stay out of git (the org's push protection blocks them). The packed plugin carries them in
// BAKED, which the release step fills from ANTIGRAVITY_CLIENT_ID / ANTIGRAVITY_CLIENT_SECRET; the plugin's settings
// (clientId / clientSecret) override them, so a user can also say them without rebuilding.
import { config } from "astra"

export const BAKED = { id: "", secret: "" }

export function oauthClient() {
  const c = config.get() ?? {}
  return { id: String(c.clientId || BAKED.id || ""), secret: String(c.clientSecret || BAKED.secret || "") }
}

export const needsClient = (c) => !c.id || !c.secret
