// Devin subscriptions for OpenCode and magpie: the devin CLI's own sign-in, and each chat completion sent
// whole to the API the CLI talks to, Windsurf's GetChatMessage (a Connect RPC in protobuf), its reply
// streamed back as chat completion chunks. Based on @magpie-community/opencode-devin-auth 0.1.14 (MIT),
// ported from magpie's built-in Devin account (internal/provider/devin*.go, internal/gateway/devin.go).
export { DevinAuthPlugin } from "./plugin.mjs"
