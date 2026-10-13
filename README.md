# astra-gate-plugins

Provider and middleware plugins for [Astra](https://github.com/astra-gate) (magpie-compatible: they also run in magpie
and OpenCode). Each plugin is a package under `packages/` that builds to one `dist/index.mjs`; a small shared
`kit/` holds the helpers more than one plugin needs and is bundled in at build time.

```
kit/                 @astragate-community/plugin-kit — shared helpers (private, never published)
packages/<name>/     one plugin: src/ (modules), test/, package.json, README.md
scripts/             build.mjs (esbuild → dist/), check.mjs (shape vs shape.json), shape.mjs, split.mjs
```

```
npm install
npm run build        # packages/*/dist/index.mjs
npm test             # kit + every package
npx eslint packages kit scripts
npm run check        # each plugin's exported shape against its committed shape.json (--update to accept a change)
```

Install from Astra's plugin market (`astra plugin add @astragate-community/<name>`, or the console's Plugins page), or
add the path of a built `dist/` directory to try a change locally.

## Releasing

Astra's market reads `registry.json` from this repository's `main` branch and downloads each plugin's tarball from the
GitHub Release it lists, checking the sha256 — no npm account is involved.

1. Bump `version` in the package's `package.json` (a released tarball is never replaced: a changed tarball is a new version).
2. `npm run registry` — builds, packs every package (deterministic, so an unchanged package keeps its hash) and rewrites
   `registry.json` with the Release URLs and hashes. Commit it and push.
3. `GH_TOKEN=… npm run release` — creates the `<dir>-v<version>` Release, with the tarball, for each version that has none.
4. Copy `registry.json` over Astra's two built-in copies (`src/Astra.Plugins/Market/market.json` and
   `docs/lib/plugin-market/upstream-fallback.json` in the Astra repository).

The `astra` block of a package's `package.json` (name, icon, summary, `replaces`) is registry metadata and is left out of
the published tarball; `magpie.icon` is what an installed plugin shows for its providers.

## License

See `THIRD_PARTY_NOTICES.md`: the published plugins are MIT (upstream's code, upstream's copyright line kept); `kit/` and
`scripts/` are Apache-2.0 like the repository.

## Plugins

| package dir | kind |
| --- | --- |
| `aider` | agent |
| `cline` | provider |
| `commandcode` | provider |
| `cursor` | provider |
| `devin` | provider |
| `factory` | provider |
| `grok` | provider |
| `kiro` | provider |
| `middleware-model-map` | middleware |
| `middleware-param-override` | middleware |
| `middleware-system-prompt` | middleware |
| `middleware-think-tags` | middleware |
| `middleware-word-guard` | middleware |
| `mimo` | provider |
| `minimax` | provider |
| `qoder` | provider |
| `trae` | provider |
| `workbuddy` | provider |
| `zcode` | provider |
| `zed` | provider |
| `zen-free` | provider |

WorkBuddy covers both builds (China and international) and adds the daily check-in.

## Plugin layout

A provider plugin is split by what changes together, not by size. `index.mjs` only exports the plugins; the rest
are modules with one reason to exist (names vary with the vendor):

| module | holds |
| --- | --- |
| `constants` / `sites` | versions, timings, endpoints, the built-in model list |
| `api` | calling the vendor, signing a request |
| `session` | an account's tokens: merging, refreshing, keeping fresh |
| `signin` | browser / CLI / desktop sign-in flows |
| `request`, `tools` | shaping the chat request for the vendor |
| `response`, `refusals` | turning the vendor's reply or refusal back |
| `usage`, `checkin`, `models` | the allowance card, the daily check-in, the model list |
| `plugin` | the hook object OpenCode / magpie load |

No module-level `let` (state that several modules mutate); shared `Map`s/`Set`s are `const` and live in the module
that owns them. A helper two plugins both need goes in `kit/` (with a test), not copied.

## Working on a plugin

Behaviour stays unless a change is meant; without live vendor accounts the guard is the exported **shape**.

1. `npx eslint packages/<name>` clean (no undefined, no unused names), `npm run build`, `npm run check` ok.
2. Tests in `packages/<name>/test/*.test.mjs` (node:test, a faked `fetch`) for the logic you can exercise offline:
   request shaping, reply decoding, token merge/refresh decisions, usage maths.
3. A helper two plugins both need goes in `kit/` (with a test), not copied.
4. `node scripts/split.mjs <single-file plugin> <plan.json> packages/<name>/src` splits a one-file plugin by declaration
   (read its header for the plan format) when bringing a new one in.
