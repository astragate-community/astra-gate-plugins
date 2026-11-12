# Model Map (Astra v2 plugin)

`astragate-community.model-map` — New API's **模型重定向** (a channel's `model_mapping`) as an Astra gateway hook. The model an agent asks for is sent upstream as another model. Replies then name the model the agent asked for, so an agent that reads its model's name back (Claude Code does, to size its context window) sees the name it asked for.

It replaces the v1 package `@astragate-community/middleware-model-map`; Astra offers the upgrade and carries the old options over.

## Settings

Plugins › Model Map › Settings holds the rules and one switch:

- **Rules** (asked model → sent as). Exact names are tried first, then patterns in list order. Names chain (`a → b → c`) until nothing more maps, at most 16 steps, and a cycle stops before it repeats.
- **Patterns.** An asked model written `/like this/` (flags allowed, `g` is ignored) is a regular expression, and its target can use `$1`. A pattern that does not compile is refused when saved.
- **Keep the upstream model's name in replies.** Off (the default) puts the asked name back in replies and stream events; replies to a failed request (status 400 and up) are left alone.

The target has to be a model Astra can route: a model of one of your providers.

**Gemini.** A Gemini request names its model in the URL; Astra moves it into the body before hooks run, so it is mapped like any other API, and the reply's `modelVersion` names the model asked for again.

## Permissions

`gateway.request:rewrite` (change `model`), `gateway.response:rewrite` (put the asked name back), `storage` (the rules), `ui` (the settings view). No network.

## Development

```sh
npm install --workspaces=false --no-package-lock   # SDK is a file: dependency until it is on npm
npm test                  # vitest, on the SDK harness
npm run build             # astra-plugin build  -> dist/
npm run validate          # astra-plugin validate
npm run pack              # astra-plugin pack dist -> dist/astragate-community.model-map-<version>.tgz (+ sha256 / sha512)
```

Layout: `astra.plugin.json`, `src/gateway.js` (hooks), `src/main.js` (settings view, v1 options migration), `src/rules.js` / `src/rename.js` (the mapping and reply renaming, unchanged from v1), `locales/{en,zh}.json`, `assets/icon.svg`.

---

Based on an MIT-licensed community plugin (see THIRD_PARTY_NOTICES.md).
