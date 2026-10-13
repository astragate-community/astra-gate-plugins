# @astragate-community/middleware-model-map

New API's **模型重定向** (a channel's `model_mapping`) as [magpie](https://usemagpie.ai) gateway middleware. The model an agent asks for is sent upstream as another model. Replies then name the model the agent asked for, so an agent that reads its model's name back (Claude Code does, to size its context window) sees the name it asked for.

Install it from Astra's plugin market, or with `astra plugin add @astragate-community/middleware-model-map`. Set its options under **Plugins › Installed › Options**, or with `magpie plugin options model-map '<json>'`.

## Options

```json
{ "mapping": {
    "fast": "deepseek-chat",
    "/^claude-(.*)$/": "glm-$1"
} }
```

- **Mapping.** A name maps to its target. Names chain (`a → b → c`) until there is nothing more to map, and a cycle stops before it repeats.
- **Patterns.** A key written `/like this/` is a regular expression, and its target can use `$1` for the first group.
- **Flat form.** New API's flat form, `{"fast": "deepseek-chat"}`, works as well.
- **`keep_upstream_name`.** Set it to `true` to leave the upstream model's name in replies.

The target has to be a model magpie can route: a model of one of your providers, or one of magpie's own ids (`deepseek/deepseek-chat`, for example).

**Gemini.** A Gemini request names its model in the URL; magpie moves it into the body before the middleware runs, so it is mapped like any other API, and the reply's `modelVersion` names the model asked for again.

中文：New API 的「模型重定向」，作为 magpie 网关中间件。回复里的模型名会还原成 agent 请求时用的名字。

## Running in Astra and magpie

This package builds to one file, `dist/index.mjs`, which both hosts load as an ES module (Astra evaluates it in
its Jint-based middleware runner). Keep it loadable there:

- It exports only the hooks the middleware uses (`onRequest`, `onEvent` and `onResponse`); the helper modules under `src/` are bundled into the
  file, not exported.
- It imports nothing at run time: no package, no `node:` module, no kit helper that pulls one in. Astra resolves
  only relative files inside the plugin's folder.
- `package.json`'s `magpie.middleware` points at `./index.mjs` (upstream's was `./model-map.middleware.js`), the file
  the build produces; its `magpie.options` example is unchanged.

---

Based on an MIT-licensed community plugin (see THIRD_PARTY_NOTICES.md).
