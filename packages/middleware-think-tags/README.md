# @astragate-community/middleware-think-tags

A model's thinking, where its reply's text is, as [magpie](https://usemagpie.ai) gateway middleware. It either takes thinking out of the text, or puts it in (New API's `thinking_to_content`).

Install it from Astra's plugin market, or with `astra plugin add @astragate-community/middleware-think-tags`. Set its options under **Plugins › Installed › Options**, or with `magpie plugin options think-tags '<json>'`.

## Options

```json
{ "mode": "strip" }
```

**`strip`** (the default). Some models (open reasoning models served by vLLM, Ollama and many relays) write their thinking into the reply as `<think>…</think>`. This mode takes that block out, so an agent doesn't keep it in its history and send it back every turn.

- Only a block at the start of the text is taken out. A `<think>` the model writes later, in code for example, stays.
- A tag split across streamed chunks is still found.
- It works on Anthropic, Chat and Responses replies, streamed or whole.

**`to_content`**. A Chat reply's `reasoning_content` (or `reasoning`) is put into its text as `<think>…</think>`, for a client that shows only the text.

- This mode works on Chat replies only. An Anthropic thinking block carries a signature, and turned into text it would fail the next turn.
- It changes what the agent keeps and sends back, so it suits a chat client better than a coding agent.

中文：`strip` 去掉回复开头模型写出的 `<think>…</think>`；`to_content` 把 Chat 回复的 reasoning_content 放进正文（New API 的 thinking_to_content）。

## Running in Astra and magpie

This package builds to one file, `dist/index.mjs`, which both hosts load as an ES module (Astra evaluates it in
its Jint-based middleware runner). Keep it loadable there:

- It exports only the hooks the middleware uses (`onEvent` and `onResponse`); the helper modules under `src/` are bundled into the
  file, not exported.
- It imports nothing at run time: no package, no `node:` module, no kit helper that pulls one in. Astra resolves
  only relative files inside the plugin's folder.
- `package.json`'s `magpie.middleware` points at `./index.mjs` (upstream's was `./think-tags.middleware.js`), the file
  the build produces; its `magpie.options` example is unchanged.

---

Based on an MIT-licensed community plugin (see THIRD_PARTY_NOTICES.md).
