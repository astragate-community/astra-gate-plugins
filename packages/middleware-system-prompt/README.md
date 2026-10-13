# @magpie-community/middleware-system-prompt

New API's **系统提示词** (a channel's `system_prompt` and its override switch) as [magpie](https://usemagpie.ai) gateway middleware. It gives the requests agents send a system prompt of yours, in each API's own place for one:

| API | Where the prompt goes |
| --- | --- |
| Anthropic | `system` |
| Chat | the first `system` or `developer` message |
| Responses | `instructions` |
| Gemini | `systemInstruction` |

Install it from magpie's **Plugins › Discover**, or with `magpie plugin add @magpie-community/middleware-system-prompt`. Set its options under **Plugins › Installed › Options**, or with `magpie plugin options system-prompt '<json>'`.

## Options

```json
{ "system_prompt": "Reply in the language the user writes in.",
  "override": true, "position": "append",
  "agents": ["claude"], "models": ["deepseek"] }
```

- **No system prompt yet.** A request without one gets yours.
- **`override`.** A request that has its own prompt keeps it unchanged, unless `override` is `true`. Then yours goes in as well, placed by `position`:
  - `"append"` (the default) puts yours after it. Agents cache their own prompt, so adding after it keeps that cache.
  - `"prepend"` puts yours before it, as New API does. This makes the provider read the whole prompt again on every turn.
- **`agents`.** When given, the prompt applies only to these agents, by magpie's agent ids: `claude`, `codex`, `opencode`, and so on.
- **`models`.** When given, the prompt applies only to models whose names begin with one of these prefixes.

Codex sends its own model instructions, and changing them can change how its models behave. Use `agents` to leave Codex out if you don't want that.

中文：New API 的「系统提示词」，作为 magpie 网关中间件。默认把你的提示词加在 agent 自己的提示词之后，这样不会破坏提示缓存。

## Running in Astra and magpie

This package builds to one file, `dist/index.mjs`, which both hosts load as an ES module (Astra evaluates it in
its Jint-based middleware runner). Keep it loadable there:

- It exports only the hooks the middleware uses (`onRequest`); the helper modules under `src/` are bundled into the
  file, not exported.
- It imports nothing at run time: no package, no `node:` module, no kit helper that pulls one in. Astra resolves
  only relative files inside the plugin's folder.
- `package.json`'s `magpie.middleware` points at `./index.mjs` (upstream's was `./system-prompt.middleware.js`), the file
  the build produces; its `magpie.options` example is unchanged.

---

Based on @magpie-community/middleware-system-prompt 0.1.0 (MIT).
