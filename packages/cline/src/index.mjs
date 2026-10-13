// Cline (cline.bot) as a magpie / OpenCode provider plugin.
//
// The same sign-in Cline's own client runs — a WorkOS device code the browser
// approves, traded at Cline's register endpoint for the account's token pair —
// or a plain API key from app.cline.bot. Chat completions go to Cline's
// gateway in OpenAI's format; the model list comes from its recommended-models
// and cloud-models feeds; usage reads the account's credit balance and, on
// ClinePass, the plan's 5-hour, weekly and monthly limits.
// Based on an MIT-licensed community plugin (see THIRD_PARTY_NOTICES.md).
import { ClinePlugin } from "./plugin.mjs"
import { PROVIDER } from "./constants.mjs"

export { ClinePlugin }

// The shape the plugin host looks for: default {id, server}. The host takes
// this over the named exports, so also exporting ClinePlugin by name changes
// nothing the host does.
export default { id: PROVIDER, server: ClinePlugin }
