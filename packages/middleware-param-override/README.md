# @astragate-community/middleware-param-override

New API's **参数覆盖** (a channel's `param_override`) as [magpie](https://usemagpie.ai) gateway middleware. It sets, deletes, moves and rewrites any field of the requests agents send through magpie, whichever provider serves them. The options are New API's JSON as it is, so you can paste a `param_override` from New API unchanged.

Install it from Astra's plugin market, or with `astra plugin add @astragate-community/middleware-param-override`. Then set its options under **Plugins › Installed › Options**, or with `magpie plugin options param-override '<json>'`.

## Options

There are two forms, as in New API:

```json
{ "temperature": 0.2, "max_tokens": 8000 }
```

Each key is set on the body as it is.

```json
{ "operations": [
  { "path": "max_tokens", "mode": "set", "value": 32000,
    "conditions": [{ "path": "max_tokens", "mode": "gt", "value": 32000 }] },
  { "path": "temperature", "mode": "delete",
    "conditions": [{ "path": "model", "mode": "contains", "value": "reasoner" }] },
  { "mode": "return_error", "value": { "message": "opus is not allowed here", "status_code": 403 },
    "conditions": [{ "path": "model", "mode": "contains", "value": "opus" }] }
] }
```

The operations run in order. Keys set beside `operations` are applied first.

| Field | |
| --- | --- |
| `path` | A gjson path: `a.b.0`. `messages.-1` counts from the end, `tools.*.name` matches every item, and `\.` is a dot inside a key. |
| `mode` | `set` (`keep_origin`: only when missing), `delete`, `move` / `copy` (`from`, `to`), `prepend` / `append` (arrays joined, strings joined, objects merged; `keep_origin` keeps keys already there), `trim_prefix`, `trim_suffix`, `ensure_prefix`, `ensure_suffix`, `trim_space`, `to_lower`, `to_upper`, `replace` / `regex_replace` (`from`, `to`; Go's `${1}` works), `return_error`, `prune_objects` |
| `value` | What to set, join or trim. For `return_error`, a message or `{message, status_code}`; the agent gets the error in its own API's shape. For `prune_objects`, a `type` or `{type, where, conditions, logic, recursive}`. |
| `conditions` | `[{path, mode, value, invert, pass_missing_key}]`, where `mode` is `full`, `prefix`, `suffix`, `contains`, `gt`, `gte`, `lt` or `lte`. A path is looked up in the body first, then in the request: `model`, `request_path`, `protocol` (`anthropic`, `chat`, `responses`, `gemini`), `agent`, `stream`. |
| `logic` | `OR` (New API's default) or `AND`. |

Some of New API's modes have nothing to act on here and are left out: the header modes (`set_header`, `pass_headers`…), `sync_fields`, and conditions on retries, users and groups. The middleware sees only the body.

Unlike New API, an operation that can't apply is skipped (a `move` from a missing path, `trim_prefix` on a number) and the request goes on. If the middleware itself fails, magpie sends the request as it came.

## Recipes

- Cap `max_tokens` for a provider with a lower limit: the first example above.
- Drop a parameter a provider refuses: `{"path": "tools.*.input_examples", "mode": "delete"}`.
- Strip a vendor prefix from model names: `{"path": "model", "mode": "trim_prefix", "value": "openai/"}`.
- Keep an agent off a model: `return_error` with a `model` condition.
- Remove old thinking blocks: `{"path": "messages", "mode": "prune_objects", "value": "thinking"}`.

中文：New API 的「参数覆盖」，作为 magpie 网关中间件。配置是 New API 的同一份 JSON，可以原样粘贴过来。

## Running in Astra and magpie

This package builds to one file, `dist/index.mjs`, which both hosts load as an ES module (Astra evaluates it in
its Jint-based middleware runner). Keep it loadable there:

- It exports only the hooks the middleware uses (`onRequest`); the helper modules under `src/` are bundled into the
  file, not exported.
- It imports nothing at run time: no package, no `node:` module, no kit helper that pulls one in. Astra resolves
  only relative files inside the plugin's folder.
- `package.json`'s `magpie.middleware` points at `./index.mjs` (upstream's was `./param-override.middleware.js`), the file
  the build produces; its `magpie.options` example is unchanged.

---

Based on an MIT-licensed community plugin (see THIRD_PARTY_NOTICES.md).
