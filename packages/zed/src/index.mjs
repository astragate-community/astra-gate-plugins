// Zed subscriptions (Zed Pro, its trial, a student or business plan) for
// OpenCode and magpie: the models Zed hosts — Anthropic's, OpenAI's,
// Google's and xAI's — asked through cloud.zed.dev, as the Zed editor asks
// them. Based on an MIT-licensed community plugin (see THIRD_PARTY_NOTICES.md), ported from
// magpie's built-in Zed account (internal/zed, internal/provider/zed*.go,
// internal/gateway/zed.go), which was read from Zed's source
// (github.com/zed-industries/zed, 1.23.0):
//
//   - Sign-in (signin.mjs): an RSA-2048 key is made, a port of 127.0.0.1
//     listened on, and zed.dev/native_app_signin opened with the port and the
//     key's public half. The browser comes back to the port with user_id and
//     an access_token encrypted to the key. The pair is sent as
//     "Authorization: <user_id> <access_token>" to cloud.zed.dev/client/*
//     and lasts until a 401.
//   - POST /client/llm_tokens trades the pair for a short-lived model token
//     (token.mjs), minted again on a 401 or an x-zed-expired-token /
//     x-zed-outdated-token reply.
//   - GET /models lists what the account may call (models.mjs); POST
//     /completions (complete.mjs) takes {provider, model, provider_request} —
//     the provider's own request — and streams newline-delimited JSON, each
//     line {"event": <the provider's own stream event>} or a status.
//
// Each model is declared on the AI SDK package of its own provider, so the
// request the SDK writes is already the provider_request Zed wants; the
// fetch wraps it (request.mjs), and turns Zed's lines back into that
// provider's own server-sent events (response.mjs).


export { ZedAuthPlugin } from "./plugin.mjs"
