# astra-gate-plugins

Source of the [Astra](https://github.com/astra-gate) **v2 plugins** (providers, gateway middleware, a client). This
repository only holds source: each plugin is packed into a tarball and uploaded to the plugin market service
(`astra-gate-web`), which owns all market metadata (listings, versions, hashes, search). There is no `registry.json`
and no GitHub Release step here.

```
packages/<name>/   one plugin: astra.plugin.json, src/ (bundled by astra-plugin build), locales/, assets/, test/, README.md
scripts/           build.mjs (test + build + validate + pack every v2 package → out/), upload.mjs (out/ → market)
kit/               legacy shared helpers of the v1 plugins (not used by v2 packages; the sandbox imports no packages)
```

Each package depends on `@astragate/plugin-sdk` (a `file:` path to the Astra checkout until it is on npm).

```
cd packages/<name> && npm install --workspaces=false --no-package-lock
npm test           # vitest on the SDK harness
npm run build      # astra-plugin build + validate
npm run pack       # → out/<id>-<version>.tgz (prints sha256 / sha512)
node scripts/build.mjs [name…]    # all v2 packages (or the named ones)
```

## Releasing

1. Bump `version` in the package's `astra.plugin.json` and `package.json` (a published version is immutable on the market).
2. `node scripts/build.mjs`
3. `PLUGIN_UPLOAD_TOKEN=… node scripts/upload.mjs [--dry-run]` — posts `out/*.tgz` to `$PLUGIN_MARKET_URL`
   (default `https://astra-gate.si`); an existing version answers 409 and is reported, not an error.

Plugin ids are `astragate-community.<name>`; each declares `replaces` for its v1 npm package so Astra offers the upgrade.
`qoder` is still v1 (its reply format needs a provider-level reply transform that v2 does not have yet), so the build skips it.

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
| `qoder` | provider (still v1) |
| `trae` | provider |
| `workbuddy` | provider |
| `zcode` | provider |
| `zed` | provider |
| `zen-free` | provider |


## License

See `THIRD_PARTY_NOTICES.md`: the published plugins are MIT (upstream's code, upstream's copyright line kept); `kit/` and `scripts/` are Apache-2.0 like the repository.
