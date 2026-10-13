// Kiro: ids, endpoints and timings.
import { createHash } from "node:crypto"
import { hostname } from "node:os"

export const ID = "kiro"
export const MESSAGES = "@ai-sdk/anthropic"
export const BASE = "https://runtime.us-east-1.kiro.dev" // what OpenCode is given; the fetch sends each request to the account's region

export const PORTAL = "https://app.kiro.dev"
export const AUTH_SERVICE = "https://prod.us-east-1.auth.desktop.kiro.dev"
export const oidc = (region) => `https://oidc.${region}.amazonaws.com`
export const runtime = (region) => `https://runtime.${region}.kiro.dev`
export const management = (region) => `https://management.${region}.kiro.dev`
export const refreshURL = (region) => `https://prod.${region}.auth.desktop.kiro.dev/refreshToken`
// the ports Kiro's sign-in page sends the browser back to, the IDE's
export const CALLBACK_PORTS = [3128, 4649, 6588, 8008, 9091, 49153, 50153, 51153, 52153, 53153]
// what the IDE asks AWS for
export const SCOPES = ["codewhisperer:completions", "codewhisperer:analysis", "codewhisperer:conversations",
  "codewhisperer:transformations", "codewhisperer:taskassist"]
// how the IDE names itself to Kiro's auth service, and when refreshing
export const IDE_UA = "KiroIDE-1.1.70-" + createHash("sha256").update("magpie:" + hostname()).digest("hex")
export const DESKTOP_UA = "Kiro-Desktop/0.2.13 (darwin; arm64)"
export const SIGN_IN_TIMEOUT = 10 * 60 * 1000
// A Builder ID sign-in has no profile of its own, and Kiro won't list one
// for it (List-Available-Profiles is a 403, "AWS Builder ID is not supported
// for this operation"); the Kiro IDE and kiro-cli name this service profile
// for it instead, so its models, usage and chat are asked with it too.
export const BUILDER_ID_START = "https://view.awsapps.com/start"
export const BUILDER_ID_PROFILE = "arn:aws:codewhisperer:us-east-1:638616132270:profile/AAAACCCCXXXX"
export const isBuilderID = (provider) => String(provider ?? "").toLowerCase() === "builderid"

export const EARLY_MS = 2 * 60 * 1000 // a token this close to its end is refreshed before a request
export const LEAD_MS = 10 * 60 * 1000 // and this close, magpie renews it ahead of time (auth.refresh)
