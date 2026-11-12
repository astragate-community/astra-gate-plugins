// Kiro: ids, endpoints and timings.
import { crypto } from "astra"

export const ID = "kiro"

export const PORTAL = "https://app.kiro.dev"
export const AUTH_SERVICE = "https://prod.us-east-1.auth.desktop.kiro.dev"
export const oidc = (region) => `https://oidc.${region}.amazonaws.com`
export const runtime = (region) => `https://runtime.${region}.kiro.dev`
export const management = (region) => `https://management.${region}.kiro.dev`
export const refreshURL = (region) => `https://prod.${region}.auth.desktop.kiro.dev/refreshToken`
// The port Kiro's sign-in page is told to send the browser back to (one of the IDE's). Nothing listens there: the page
// it ends on fails to load, and its address is pasted back.
export const CALLBACK_PORT = 3128
// what the IDE asks AWS for
export const SCOPES = ["codewhisperer:completions", "codewhisperer:analysis", "codewhisperer:conversations",
  "codewhisperer:transformations", "codewhisperer:taskassist"]
// how the IDE names itself to Kiro's auth service, and when refreshing
export const IDE_UA = "KiroIDE-1.1.70-" + crypto.sha256("astra-gate:kiro")
export const DESKTOP_UA = "Kiro-Desktop/0.2.13 (darwin; arm64)"
// A Builder ID sign-in has no profile of its own, and Kiro won't list one
// for it (List-Available-Profiles is a 403, "AWS Builder ID is not supported
// for this operation"); the Kiro IDE and kiro-cli name this service profile
// for it instead, so its models, usage and chat are asked with it too.
export const BUILDER_ID_PROFILE = "arn:aws:codewhisperer:us-east-1:638616132270:profile/AAAACCCCXXXX"
export const isBuilderID = (provider) => String(provider ?? "").toLowerCase() === "builderid"

export const EARLY_MS = 2 * 60 * 1000 // a token this close to its end is refreshed before a request
