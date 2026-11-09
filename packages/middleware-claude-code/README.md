# @astragate-community/middleware-claude-code

Astra gateway middleware for channels that serve only the official Claude Code CLI — the ones that answer
`this channel only serves official Claude Code CLI requests; your request was not recognized as Claude Code`.
It sends the requests that go to the channels you name as Claude Code would send them:

- **Headers**: `User-Agent: claude-cli/<version> (external, cli)`, `X-App: cli`, the Anthropic SDK's `X-Stainless-*`
  runtime headers (one host profile per channel, kept stable), and on the Anthropic API `anthropic-version` and
  Claude Code's `anthropic-beta` set (without the OAuth beta: a channel is called with an API key).
- **System prompt**, when the request has none of its own:
  - Anthropic: the `x-anthropic-billing-header` block (with the `cc_version` fingerprint the CLI computes) and the
    `You are Claude Code, Anthropic's official CLI for Claude.` block, in front of the caller's own system blocks, which
    are kept; and a CLI-shaped `metadata.user_id` (a stable device id per channel, one session id per conversation).
  - Chat: the identity line as the first system message.
- A request that already carries them (Claude Code itself) keeps its own.

The channel's API key is never touched: Astra refuses credential headers from a plugin and writes the key last.

Requires Astra with the `onUpstream` hook (it runs after Astra has translated the request into the channel's API, so
the identity is written in the API the channel reads). magpie does not call `onUpstream`.

## Options

```json
{ "providers": ["prov_01JABC…", "My relay"], "protocol": "anthropic" }
```

- **`providers`** (required): the channels, by provider id or by name. With none listed the plugin does nothing.
- **`protocol`**: the channel API it applies to — `anthropic` (the default), `chat`, or `any`. A provider with
  several endpoints is matched only when the request goes out over this one.
- **`version`**: the CLI version to present, `x.y.z` (default `2.1.281`).
- **`betas`**: the `anthropic-beta` value to send instead of the default set.

中文：给只接受官方 Claude Code CLI 的渠道用。在 `providers` 里写上渠道（提供商 ID 或名称），`protocol` 选渠道的协议（默认 `anthropic`）。
发往这些渠道的请求会带上 Claude Code 的请求头；请求里没有 Claude Code 的系统提示词时补上（保留原有的系统提示词），并补上 `metadata.user_id`。

Whether a channel accepts this is the channel's decision, and impersonating a client may break its terms; you take that
risk for your own key.

## Running in Astra

This package builds to one file, `dist/index.mjs`, which Astra evaluates in its Jint-based middleware runner. It exports
only `onUpstream`, imports nothing at run time, and uses `ctx.sha256` for its digests.
