// Xiaomi MiMo as an OpenCode provider plugin, based on @magpie-community/opencode-mimo-auth 0.1.9 (MIT).
// Xiaomi MiMo, as the MiMo desktop app signs in to it: a Xiaomi account
// signed in on account.xiaomi.com's long-poll page (a QR code for the
// Xiaomi phone app, or the password), whose passToken signs it on at the
// MiMo server, which answers with session cookies. Model requests are
// chat completions at the server's /route, carrying those cookies. An
// account with no app membership but a Token Plan at the open platform
// (the server answers membership_required) is asked at the Token Plan's
// endpoint instead, with the plan's tp- key, which the same passToken
// reads from the platform.
export { MimoAuthPlugin } from "./plugin.mjs"
