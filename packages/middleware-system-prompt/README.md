# System Prompt (Astra v2 plugin)

`astragate-community.system-prompt` — New API's **系统提示词** (a channel's `system_prompt` and its override switch) as an Astra gateway hook. It gives the requests agents send a system prompt of yours, in each API's own place for one:

| API | Where the prompt goes |
| --- | --- |
| Anthropic | `system` |
| Chat | the first `system` or `developer` message |
| Responses | `instructions` |
| Gemini | `systemInstruction` |

It replaces the v1 package `@astragate-community/middleware-system-prompt`; Astra offers the upgrade and carries the old options over.

## Settings

Plugins › System Prompt › Settings:

- **Prompt.** A request without a system prompt gets yours. While it is empty nothing is added.
- **Add it to prompts agents already have** (`override`). Off: a request that has its own prompt keeps it unchanged. On: yours goes in as well, placed by **Where it goes**.
  - *After the agent's prompt* (the default) keeps the agent's own prompt first, so the provider's prompt cache on it still hits.
  - *Before the agent's prompt* is New API's way. It makes the provider read the whole prompt again on every turn.
- **Agents.** When given, the prompt applies only to these Astra client ids (`claude-code`, `codex`, …).
- **Models.** When given, the prompt applies only to models whose names begin with one of these prefixes.

Codex sends its own model instructions, and changing them can change how its models behave. Use **Agents** to leave Codex out if you don't want that.

## Permissions

`gateway.request:rewrite` (add the prompt), `storage` (the settings), `ui` (the settings view). No network.

## Development

```sh
npm install --workspaces=false --no-package-lock   # SDK is a file: dependency until it is on npm
npm test                  # vitest, on the SDK harness
npm run build             # astra-plugin build  -> dist/
npm run validate          # astra-plugin validate
npm run pack              # astra-plugin pack dist -> dist/astragate-community.system-prompt-<version>.tgz (+ sha256 / sha512)
```

Layout: `astra.plugin.json`, `src/gateway.js` (the hook), `src/apis.js` (each API's place for a system prompt, unchanged from v1 apart from the agent filter), `src/main.js` (settings view, v1 options migration), `src/settings.js`, `locales/{en,zh}.json`, `assets/icon.svg`.

---

Based on an MIT-licensed community plugin (see THIRD_PARTY_NOTICES.md).
