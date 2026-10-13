// Xiaomi MiMo: ids, endpoints, the app's identity and the timings its sign-in keeps.
import { randomBytes } from "node:crypto"

export const ID = "mimo-app"
export const HOSTS = {
  SGP: "https://mimo-server-sgp.xiaomimimo.com/api",
  RU: "https://mimo-server-ru.xiaomimimo.com/api",
  IN: "https://mimo-server-in.xiaomimimo.com/api",
}
export const REGION = "SGP"
export const ACCOUNT = "https://account.xiaomi.com"
// The open platform (platform.xiaomimimo.com) sells the Token Plan, a plan
// of its own spent with its tp- API key at token-plan-<region>.xiaomimimo.com,
// not through the app's /route.
export const PLATFORM = "https://platform.xiaomimimo.com"
export const APP_VERSION = "26.929.292248"
export const SOURCE = "mimocode-cli-free"
export const UA = "miNative PC/Normal Windows_NT/10.0.26100 SDKV/1.0.0 DEVT/PC DEVS/Windows APP/miaccount_desktop APPV/0.1.0"
export const RENEW_AFTER = 24 * 60 * 60 * 1000 // the app signs on again after a day
export const LEAD_MS = 10 * 60 * 1000 // this close to it, magpie signs on again ahead of time (auth.refresh)
export const SIGN_IN_LIFE = 10 * 60 * 1000

const MODEL = { release_date: "2026-07-01", attachment: true, tool_call: true, limit: { context: 1_000_000, output: 128_000 }, modalities: { input: ["text", "image"], output: ["text"] } }
export const MODELS = {
  "mimo-pro": { name: "MiMo Pro", ...MODEL },
  "mimo-flash": { name: "MiMo Flash", ...MODEL },
}

// mimo-auto, the app's default, is asked as the model it stands for
export const AUTO_MODELS = { "mimo-auto": "mimo-pro" }
// the Token Plan's names for the app's models; any other passes as it is
export const TP_MODELS = { "mimo-pro": "mimo-v2.6-pro", "mimo-flash": "mimo-v2.6-flash" }
export const TP_LIFE = 60 * 60 * 1000 // this long, an account the app refused is asked at its Token Plan

export const baseOf = (region) => HOSTS[String(region ?? "").trim().toUpperCase()] ?? ""
export const deviceId = () => "pc_" + randomBytes(16).toString("hex")
export const appHeaders = () => ({ "User-Agent": UA, "X-Client-Version": APP_VERSION })
