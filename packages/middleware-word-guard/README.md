# @astragate-community/middleware-word-guard

New API's **敏感词过滤** as [magpie](https://usemagpie.ai) gateway middleware. It keeps the words and patterns you list out of what agents send: a request with one is turned away, or has the word masked. It can mask them in replies too.

Install it from Astra's plugin market, or with `astra plugin add @astragate-community/middleware-word-guard`. Set its options under **Plugins › Installed › Options**, or with `magpie plugin options word-guard '<json>'`.

## Options

```json
{ "words": ["project-codename"],
  "patterns": ["\\b\\d{3}-\\d{4}\\b"],
  "action": "reject",
  "check": "last" }
```

- **`words`.** Words matched anywhere in the text, ignoring case.
- **`patterns`.** Regular expressions, also matched ignoring case.
- **`action`.** `reject` (the default) turns the request away with a 400 that names the word, in the agent's API's error shape. `mask` replaces each match with `mask` (default `***`) and sends the request on.
- **`check`.** `last` (the default) reads only the last user message that has text, which is the turn being sent. That is what New API reads. `all` reads every user message, so a word earlier in the conversation keeps turning requests away.
- **`replies`.** Set it to `true` to mask matches in the text that comes back as well, in every API magpie serves — Anthropic, Chat, Responses and Gemini, streamed or whole. A word split across two streamed events isn't caught.
- **`message`.** The error text to use in place of the default one.

The middleware reads only the user's own text. It doesn't read tool results, tool calls or the system prompt, so a file an agent reads that contains the word doesn't stop it.

magpie already redacts secrets (API keys and tokens) before a request leaves your computer, and puts them back in the reply. You don't need this middleware for secrets.

中文：New API 的「敏感词过滤」，作为 magpie 网关中间件。只检查用户自己写的文字，可拒绝请求或替换成 `***`，也可以替换回复里的词。

## Running in Astra and magpie

This package builds to one file, `dist/index.mjs`, which both hosts load as an ES module (Astra evaluates it in
its Jint-based middleware runner). Keep it loadable there:

- It exports only the hooks the middleware uses (`onRequest`, `onEvent` and `onResponse`); the helper modules under `src/` are bundled into the
  file, not exported.
- It imports nothing at run time: no package, no `node:` module, no kit helper that pulls one in. Astra resolves
  only relative files inside the plugin's folder.
- `package.json`'s `magpie.middleware` points at `./index.mjs` (upstream's was `./word-guard.middleware.js`), the file
  the build produces; its `magpie.options` example is unchanged.

---

Based on an MIT-licensed community plugin (see THIRD_PARTY_NOTICES.md).
