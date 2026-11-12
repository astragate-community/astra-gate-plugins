# Aider (Astra v2 plugin)

`astragate-community.aider` — [Aider](https://aider.chat) as a client on Astra's Clients page. It replaces the v1 package `@astragate-community/aider`; Astra offers the upgrade and keeps the client's record and the keys already written.

Pick one of the gateway's models in Aider's row. Astra writes into `~/.aider.conf.yml`:

```yaml
model: openai/deepseek/deepseek-flash   # the gateway's model, through litellm's openai/ prefix
openai-api-base: http://127.0.0.1:17321/v1
openai-api-key: <the key kept for Aider>  # Aider's own key, so Usage names it
show-model-warnings: false
```

Your comments and other settings stay. Picking Aider's own model again, or switching it off, puts every key back as it was. Restart Aider after a change: it reads its settings when it starts.

## How it is built

The manifest's `contributes.clients` entry says what Aider is: its config file and format (`~/.aider.conf.yml`, yaml), the key path of the model (`model`), litellm's `openai/` prefix, the executable (`aider`) and the user agents that name it (`aider`, `litellm`). `src/main.js` registers `connect`, which returns the three keys above. Writing, backups, drift checks and `restore-all` stay with Astra's client layer.

## Permissions

`clients` only. No network, no storage, no UI.

## Development

```sh
npm install --workspaces=false --no-package-lock   # SDK is a file: dependency until it is on npm
npm test                  # vitest, on the SDK harness
npm run build             # astra-plugin build  -> dist/
npm run validate          # astra-plugin validate
npm run pack              # astra-plugin pack dist -> dist/astragate-community.aider-<version>.tgz (+ sha256 / sha512)
```

---

Based on an MIT-licensed community plugin (see THIRD_PARTY_NOTICES.md).
