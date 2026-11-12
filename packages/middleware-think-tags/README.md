# Think Tags (Astra v2 plugin)

`astragate-community.think-tags` — a model's thinking, where its reply's text is, as Astra gateway hooks. It either takes thinking out of the text, or puts it in (New API's `thinking_to_content`).

It replaces the v1 package `@astragate-community/middleware-think-tags`; Astra offers the upgrade and carries the old option over.

## Settings

Plugins › Think Tags › Settings holds one choice, the mode:

**Take `<think>` out of the text** (`strip`, the default). Some models (open reasoning models served by vLLM, Ollama and many relays) write their thinking into the reply as `<think>…</think>`. This mode takes that block out, so an agent doesn't keep it in its history and send it back every turn.

- Only a block at the start of the text is taken out. A `<think>` the model writes later, in code for example, stays.
- A tag split across streamed chunks is still found.
- It works on Anthropic, Chat and Responses replies, streamed or whole.

**Put reasoning into the text** (`to_content`). A Chat reply's `reasoning_content` (or `reasoning`) is put into its text as `<think>…</think>`, for a client that shows only the text.

- This mode works on Chat replies only. An Anthropic thinking block carries a signature, and turned into text it would fail the next turn.
- It changes what the agent keeps and sends back, so it suits a chat client better than a coding agent.

Replies to a failed request (status 400 and up) are left alone.

## Permissions

`gateway.response:rewrite` (change the reply), `storage` (the mode), `ui` (the settings view). No network, and the plugin never touches a request.

## Development

```sh
npm install --workspaces=false --no-package-lock   # SDK is a file: dependency until it is on npm
npm test                  # vitest, on the SDK harness
npm run build             # astra-plugin build  -> dist/
npm run validate          # astra-plugin validate
npm run pack              # astra-plugin pack dist -> dist/astragate-community.think-tags-<version>.tgz (+ sha256 / sha512)
```

Layout: `astra.plugin.json`, `src/gateway.js` (the hooks), `src/think.js` / `src/strip.js` / `src/reasoning.js` (the tag matching, streamed and whole, per API — unchanged from v1), `src/main.js` (settings view, v1 options migration), `src/settings.js`, `locales/{en,zh}.json`, `assets/icon.svg`.

---

Based on an MIT-licensed community plugin (see THIRD_PARTY_NOTICES.md).
