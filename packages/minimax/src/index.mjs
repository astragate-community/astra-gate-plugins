// OpenCode provider plugins for MiniMax Code (mcode) accounts: the credits
// a MiniMax Code account gets and its M Plan, on MiniMax Code's own models.
// Based on an MIT-licensed community plugin (see THIRD_PARTY_NOTICES.md).
//   - minimax-code:        the China site (account.minimax.cn, agent.minimax.cn)
//   - minimax-code-global: the international site (account.minimax.io, agent.minimax.io)
// An account signs in here, with MiniMax Code's device sign-in (OAuth 2
// device flow with PKCE, client mcode-public): nothing is read from or
// written to MiniMax Code's own sign-in (~/.minimax). Its chats are
// Anthropic messages at <agent>/mavis/api/v1/llm/v1/messages, sent with
// MiniMax Code's headers. No check-in is made for the account.
import { SITES } from "./constants.mjs"
import { makePlugin } from "./plugin.mjs"

export const MiniMaxCodeAuthPlugin = makePlugin(SITES["minimax-code"])
export const MiniMaxCodeGlobalAuthPlugin = makePlugin(SITES["minimax-code-global"])
