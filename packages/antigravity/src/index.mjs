// Antigravity (Google's agentic IDE) on your own Google account, as an OpenCode provider plugin.
//
// An account is signed in the way Antigravity signs in: Google's page, with Antigravity's own OAuth client (PKCE, a
// loopback redirect, or the address pasted back where the browser isn't on this machine). Antigravity has no API
// OpenCode speaks: it talks to Google's Code Assist (cloudcode-pa.googleapis.com), which takes a Gemini request wrapped
// in an envelope of its own — the account's project, the app's name — and streams the answer wrapped the same way.
//
// The models are declared on Gemini's API (@ai-sdk/google), the Claude and GPT-OSS ones among them (Antigravity
// serves them in Gemini's shape too), and the fetch here shapes each request for Antigravity, wraps it, sends it to
// Code Assist and gives the answer back as Gemini's. The account's models and their allowances are asked of Code
// Assist, and refreshed with the sign-in as it nears its end.
//
// Google may suspend an account it sees used outside Antigravity: see the README.
export { AntigravityAuthPlugin } from "./plugin.mjs"
