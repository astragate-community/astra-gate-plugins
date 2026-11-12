# Claude Code Identity (Astra v2 plugin)

`astragate-community.claude-code` — for channels that serve only the official Claude Code CLI, the ones that answer `this channel only serves official Claude Code CLI requests; your request was not recognized as Claude Code`. It sends the requests that go to the channels you name as Claude Code would send them:

- **Headers**: `User-Agent: claude-cli/<version> (external, cli)`, `X-App: cli`, the Anthropic SDK's `X-Stainless-*` runtime headers (one host profile per channel, kept stable), and on the Anthropic API `anthropic-version` and Claude Code's `anthropic-beta` set (without the OAuth beta: a channel is called with an API key).
- **System prompt**, when the request has none of its own:
  - Anthropic: the `x-anthropic-billing-header` block (with the `cc_version` fingerprint the CLI computes) and the `You are Claude Code, Anthropic's official CLI for Claude.` block, in front of the caller's own system blocks, which are kept; and a CLI-shaped `metadata.user_id` (a stable device id per channel, one session id per conversation).
  - Chat: the identity line as the first system message.
- A request that already carries them (Claude Code itself) keeps its own.

The channel's API key is never touched: Astra refuses credential headers from a plugin and writes the key last.

It replaces the v1 package `@astragate-community/middleware-claude-code`; Astra offers the upgrade and carries the old options over. It runs as an `upstream` hook, after Astra has translated the request into the channel's API, so the identity is written in the API the channel reads.

## Settings

Plugins › Claude Code Identity › Settings:

- **Providers** (required): the channels, by provider id or by name. With none listed the plugin does nothing.
- **API it applies to**: `anthropic` (the default), `chat`, or any. A provider with several endpoints is matched only when the request goes out over this one.
- **CLI version**: `x.y.z` to present (default `2.1.281`).
- **anthropic-beta**: the value to send instead of the default set; empty keeps the default.

The values follow Astra's own `ClaudeCodeMimicry` (aligned with claude-cli 2.1.281); keep them in step when the CLI moves.

Whether a channel accepts this is the channel's decision, and presenting one client as another may break its terms; you take that risk for your own key.

## Permissions

`gateway.request:rewrite` (the system blocks and metadata), `gateway.upstream:headers` (the CLI's headers), `storage` (the settings), `ui` (the settings view). No network.

## Development

```sh
npm install --workspaces=false --no-package-lock   # SDK is a file: dependency until it is on npm
npm test                  # vitest, on the SDK harness
npm run build             # astra-plugin build  -> dist/
npm run validate          # astra-plugin validate
npm run pack              # astra-plugin pack dist -> dist/astragate-community.claude-code-<version>.tgz (+ sha256 / sha512)
```

Layout: `astra.plugin.json`, `src/gateway.js` (the hook), `src/identity.js` (headers, fingerprint, ids), `src/sha256.js` (a plain-JS SHA-256 over bytes, replacing v1's `ctx.sha256`), `src/main.js` (settings view, v1 options migration), `src/settings.js`, `locales/{en,zh}.json`, `assets/icon.svg`.

---

Based on an MIT-licensed community plugin (see THIRD_PARTY_NOTICES.md).
