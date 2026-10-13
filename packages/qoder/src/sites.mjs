// Qoder: its two sites, and the enterprise VPC instances of Qoder CN that serve from hosts of their own.
//
// Qoder CN speaks the same protocol on its own hosts, as Qoder CN's CLI
// (@qodercn-ai/qoderclicn 1.1.65) builds them in for its "cn" build: the
// sign-in page on qoder.cn, accounts on openapi.qoder.com.cn and models on
// gateway.qoder.com.cn, with the device-flow client id that CLI sends in
// production and no redirect_uri. That CLI chats on the device token itself;
// if qoder.cn won't trade it for a job token, the account does the same.
//
// A Qoder CN enterprise VPC account (yetone/magpie#312) is signed in to with
// its own method, which asks for the enterprise's instance name. Its calls go
// to the same paths on the instance's own hosts, as Qoder CN's CLI 1.1.64
// rewrites them once a VPC instance is set: qoder.cn becomes
// <instance>.vpc.qoder.com.cn, openapi.qoder.com.cn becomes
// <instance>-openapi.vpc.qoder.com.cn, and gateway.qoder.com.cn becomes
// <instance>-gateway.vpc.qoder.com.cn. The instance is kept on the account,
// and an account with none is served as before.
import { CN_MODELS, MODELS } from "./constants.mjs"
import { SignInGone } from "./errors.mjs"

// SITES are Qoder's two sites, each a subscription of its own.
export const SITES = {
  qoder: {
    id: "qoder",
    name: "Qoder",
    clientId: "732aef47-9cf2-46a2-95fe-4cebb5d0d1fa",
    web: "https://qoder.com",
    openapi: "https://openapi.qoder.sh",
    api: "https://api3.qoder.sh",
    redirect: "qoder-app://",
    models: MODELS,
  },
  "qoder-cn": {
    id: "qoder-cn",
    name: "Qoder CN",
    // the production client id of Qoder CN's CLI (@qodercn-ai/qoderclicn)
    clientId: "e883ade2-e6e3-4d6d-adf7-f92ceff5fdcb",
    web: "https://qoder.cn",
    openapi: "https://openapi.qoder.com.cn",
    api: "https://gateway.qoder.com.cn",
    redirect: "", // Qoder CN's CLI sends none
    deviceChat: true, // a refused job token falls back to the CLI's device-token chat
    // an enterprise's own instance, <instance>.vpc.qoder.com.cn and its
    // -openapi and -gateway hosts, as Qoder CN's CLI builds it in
    vpcDomain: "vpc.qoder.com.cn",
    models: CN_MODELS,
  },
}

const VPC_NAME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/i

// vpcInstance is the instance named by what the user entered, as Qoder CN's
// CLI reads its VPC endpoint: a bare name ("acme"), or one of the instance's
// hosts (acme.vpc.qoder.com.cn, acme-openapi.…, acme-gateway.…), here also as
// an https:// address with no path. Anything else (http://, an IP, another
// domain, a path or query) names none: undefined.
export function vpcInstance(input, domain) {
  let e = String(input ?? "").trim().toLowerCase()
  if (!e || !domain) return undefined
  if (/^[a-z][a-z\d+.-]*:\/\//.test(e)) {
    let u
    try {
      u = new URL(e)
    } catch {
      return undefined
    }
    if (u.protocol !== "https:" || u.username || u.password || u.port || u.search || u.hash || (u.pathname !== "" && u.pathname !== "/")) return undefined
    if (e.endsWith("/")) e = e.slice(0, -1)
    if (u.hostname + "" !== e.slice("https://".length)) return undefined
    e = u.hostname
  }
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(e)) return undefined
  let name = e
  if (e.endsWith("." + domain)) {
    name = e.slice(0, e.length - domain.length - 1)
    if (name.endsWith("-openapi") || name.endsWith("-gateway")) name = name.slice(0, -8)
  } else if (e.includes(".")) return undefined
  return VPC_NAME.test(name) ? name : undefined
}

// vpcSite is site served from a VPC instance's own hosts, the paths
// unchanged; undefined when the site has no VPC or instance names none.
export function vpcSite(site, instance) {
  const name = vpcInstance(instance, site.vpcDomain)
  if (!name) return undefined
  const d = site.vpcDomain
  return { ...site, web: `https://${name}.${d}`, openapi: `https://${name}-openapi.${d}`, api: `https://${name}-gateway.${d}`, vpc: name }
}

// siteOf is the site an account is served from: its VPC instance's when it
// was signed in to one, else site. An instance on record that names none
// is not read as "no VPC", which would send the enterprise's tokens to the
// public hosts: the account has to be signed in to again.
export function siteOf(site, a) {
  if (a?.vpc === undefined || a?.vpc === null || a?.vpc === "") return site
  const s = vpcSite(site, a.vpc)
  if (!s) throw new SignInGone(`${site.name}: the account's VPC instance "${a.vpc}" isn't one; sign in again`)
  return s
}
