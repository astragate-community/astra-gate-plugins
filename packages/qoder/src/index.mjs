// Qoder's subscriptions as OpenCode provider plugins, one for each of its sites: qoder (qoder.com) and qoder-cn
// (Qoder CN, qoder.cn). Based on an MIT-licensed community plugin (see THIRD_PARTY_NOTICES.md); the hooks are in plugin.mjs.
import { SITES } from "./sites.mjs"
import { makePlugin } from "./plugin.mjs"

export const QoderAuthPlugin = makePlugin(SITES.qoder)
export const QoderCNAuthPlugin = makePlugin(SITES["qoder-cn"])
