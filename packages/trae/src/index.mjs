// Trae CN (trae.cn), ByteDance's AI IDE, and Trae international (trae.ai), as the IDE signs in to them and
// asks their models: the realm's authorization page sends the browser back to
// a callback on 127.0.0.1 with the account's Cloud-IDE-JWT and refresh
// token; the refresh token is exchanged for a new JWT at
// /cloudide/api/v3/trae/oauth/ExchangeToken (Trae CN's own clients renew it bound to the account's device);
// model requests go to the IDE agent's /api/agent/v3/llm_utils_chat, which answers in its own SSE
// events. Worked out from two open-source relays (wangqi233/trae2api and
// autumnsentiment/Trae2api-cn); not run against a real account here.
// The account's fetch also sends Trae CN's own pages on api.trae.cn
// (/trae/api/…) as the account, for magpie's daily check-in (每日签到:
// /trae/api/v2/ug/checkin_credits/status, then /claim).
// Based on an MIT-licensed community plugin (see THIRD_PARTY_NOTICES.md).
export { TraeCNAuthPlugin, TraeGlobalAuthPlugin } from "./plugin.mjs"
