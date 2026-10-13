// Kiro's subscriptions (kiro.dev) as an OpenCode provider plugin.
//
// An account is signed in the way the Kiro IDE signs in: Kiro's sign-in
// page (app.kiro.dev) offers Google, GitHub, AWS Builder ID and IAM
// Identity Center, and sends the browser back to one of the ports the IDE
// listens on. Google and GitHub come back with a code Kiro's auth service
// trades for tokens; Builder ID and Identity Center come back with where to
// sign in at AWS, which is then done with a client registered for it.
// kiro-cli's or the IDE's own sign-in can be used instead: it is read where
// they keep it each time, refreshed by kiro-cli first, and a token
// refreshed here is written back, so they go on with it. A Kiro API key
// (ksk_…) signs in too.
//
// Kiro has no API OpenCode speaks: the models are declared on Anthropic's
// Messages, and the fetch here sends each request whole to Kiro's own API
// (runtime.<region>.kiro.dev/generateAssistantResponse, the one kiro-cli
// talks to) as a conversation, and turns the AWS event stream it answers
// with back into Messages' events. Based on @magpie-community/opencode-kiro-auth 0.1.9 (MIT).
export { KiroAuthPlugin } from "./plugin.mjs"
