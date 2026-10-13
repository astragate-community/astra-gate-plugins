// The two sites a ZCode account signs in to, and where their APIs are.
import { BIGMODEL_API, BIGMODEL_BASE, ZAI_API, ZAI_BASE } from "./constants.mjs"

export const SITES = {
  zai: { name: "Z.ai", api: ZAI_API, base: ZAI_BASE, subscribe: "z.ai/subscribe" },
  bigmodel: { name: "BigModel", api: BIGMODEL_API, base: BIGMODEL_BASE, subscribe: "bigmodel.cn/glm-coding" },
}
export const siteOf = (s) => (s === "bigmodel" ? "bigmodel" : "zai")

/** Whether a plan's base URL is BigModel's. */
export const isBigModel = (base) => base.includes("bigmodel.cn")

/** The scheme and host of a base URL (Z.ai's API when it doesn't parse). */
export const rootOf = (base) => {
  try {
    const u = new URL(base)
    return `${u.protocol}//${u.host}`
  } catch {
    return ZAI_API
  }
}

/** bizRoot is the business API of the site a plan is served from. */
export function bizRoot(base) {
  let h = ""
  try {
    h = new URL(base).host.toLowerCase()
  } catch {}
  return h === new URL(BIGMODEL_BASE).host || h.endsWith("bigmodel.cn") ? BIGMODEL_API : rootOf(base)
}
