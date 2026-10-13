# astra-gate-plugins

Provider and middleware plugins for [Astra](https://github.com/astra-gate) (magpie-compatible: they also run in magpie
and OpenCode). Each plugin is a package under `packages/` that builds to one `dist/index.mjs`; a small shared
`kit/` holds the helpers more than one plugin needs and is bundled in at build time.

```
kit/                 @astragate-community/plugin-kit — shared helpers (private, never published)
packages/<name>/     one plugin: src/ (modules), test/, package.json, README.md
scripts/             build.mjs (esbuild → dist/), check.mjs (shape vs upstream), shape.mjs, split.mjs
```

```
npm install
npm run build        # packages/*/dist/index.mjs
npm test             # kit + every package
npx eslint packages kit scripts
npm run check        # each plugin's exported shape against its upstream npm package
```

Install a built plugin in Astra by adding the path of its `dist/` directory in the console's Plugins page.

## Plugins

| package dir | kind | version | upstream (`@magpie-community/…`) |
| --- | --- | --- | --- |
| `commandcode` | provider | 0.1.12 | `opencode-commandcode-auth` |
| `cursor` | provider | 0.2.11 | `opencode-cursor-auth` |
| `devin` | provider | 0.1.14 | `opencode-devin-auth` |
| `factory` | provider | 0.1.25 | `opencode-factory-auth` |
| `grok` | provider | 0.1.14 | `opencode-grok-auth` |
| `kiro` | provider | 0.1.9 | `opencode-kiro-auth` |
| `middleware-model-map` | middleware | 0.1.1 | `middleware-model-map` |
| `middleware-param-override` | middleware | 0.1.0 | `middleware-param-override` |
| `middleware-system-prompt` | middleware | 0.1.0 | `middleware-system-prompt` |
| `middleware-think-tags` | middleware | 0.1.0 | `middleware-think-tags` |
| `middleware-word-guard` | middleware | 0.1.1 | `middleware-word-guard` |
| `mimo` | provider | 0.1.9 | `opencode-mimo-auth` |
| `qoder` | provider | 0.2.14 | `opencode-qoder-auth` |
| `workbuddy` | provider | 0.2.0 | `opencode-workbuddy-auth` |
| `zcode` | provider | 0.1.17 | `opencode-zcode-auth` |
| `zed` | provider | 0.1.6 | `opencode-zed-auth` |
| `zen-free` | provider | 0.1.1 | `opencode-zen-free-auth` |

WorkBuddy covers both builds (China and international) and adds the daily check-in the upstream package lacks.

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

## Refactoring an upstream plugin

Behaviour stays; structure changes. Without live vendor accounts the guard is the exported **shape**:

1. `package.json`: name `@astragate-community/<name>`, `"upstream": { "package", "version" }`, and `"upstreamDiff"`
   listing the shape paths that differ on purpose (e.g. `._internal`, which tests-only exports used to leak).
2. `node scripts/split.mjs <upstream index.mjs> <plan.json> packages/<name>/src` splits by declaration; read its
   header for the plan format. Then review each module: names, comments, duplicated code folded into one function.
3. Replace local copies of kit helpers (`statusText`, `sleep`, `kept`, `errorResponse`, `resultPage`, `textOf`,
   `randomToken`/`challengeOf`, `listenOnFirstFree`) with the kit's. Only change a copy if the kit's differs in
   behaviour on purpose — then say so in the commit.
4. `npx eslint packages/<name>` clean (no undefined, no unused), `npm run build`, `node scripts/check.mjs <name>` ok.
5. Tests in `packages/<name>/test/*.test.mjs` (node:test, a faked `fetch`) for the logic you can exercise offline:
   request shaping, reply decoding, token merge/refresh decisions, usage maths.

Upstream is MIT (magpie-community); keep each plugin's README attribution.
