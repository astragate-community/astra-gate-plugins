# Word Guard (Astra v2 plugin)

`astragate-community.word-guard` — New API's **敏感词过滤** as Astra gateway hooks. It keeps the words and patterns you list out of what agents send: a request with one is turned away, or has the word masked. It can mask them in replies too.

It replaces the v1 package `@astragate-community/middleware-word-guard`; Astra offers the upgrade and carries the old options over.

## Settings

Plugins › Word Guard › Settings:

- **Words.** Matched anywhere in the text, ignoring case.
- **Patterns.** Regular expressions, also matched ignoring case. A pattern that does not compile is refused when saved, so a typo can't make the hook fail on every request.
- **Action.** *Turn away* (the default) answers with a 400 that names the word, in the agent's API's error shape. *Mask* replaces each match with **Mask** (default `***`) and sends the request on.
- **Error text.** Used in place of the default message when a request is turned away.
- **Which messages.** *Last user message* (the default) reads only the last user message that has text, which is the turn being sent. That is what New API reads. *Every user message* reads them all, so a word earlier in the conversation keeps turning requests away.
- **Mask replies too.** With the Mask action, matches in the text that comes back are masked as well, in every API — Anthropic, Chat, Responses and Gemini, streamed or whole. A word split across two streamed events isn't caught.

The plugin reads only the user's own text. It doesn't read tool results, tool calls or the system prompt, so a file an agent reads that contains a word doesn't stop it. Astra's privacy guard already redacts secrets (API keys and tokens) before a request leaves your computer; you don't need this plugin for secrets.

## Permissions

`gateway.request:rewrite` (mask), `gateway.request:reject` (turn away), `gateway.response:rewrite` (mask replies), `storage` (the settings), `ui` (the settings view). No network.

## Development

```sh
npm install --workspaces=false --no-package-lock   # SDK is a file: dependency until it is on npm
npm test                  # vitest, on the SDK harness
npm run build             # astra-plugin build  -> dist/
npm run validate          # astra-plugin validate
npm run pack              # astra-plugin pack dist -> dist/astragate-community.word-guard-<version>.tgz (+ sha256 / sha512)
```

Layout: `astra.plugin.json`, `src/gateway.js` (the hooks), `src/matcher.js` / `src/request.js` / `src/replies.js` (matching, the user's text per API, the reply's text slots — unchanged from v1), `src/main.js` (settings view, v1 options migration), `src/settings.js`, `locales/{en,zh}.json`, `assets/icon.svg`.

---

Based on an MIT-licensed community plugin (see THIRD_PARTY_NOTICES.md).
