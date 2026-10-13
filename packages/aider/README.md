# @astragate-community/aider

[Aider](https://aider.chat) as an agent plugin. Based on an MIT-licensed community plugin (see
`THIRD_PARTY_NOTICES.md`); the same behaviour.

```sh
astra plugin add @astragate-community/aider
```

Then pick one of the gateway's models in Aider's row. The gateway writes into `~/.aider.conf.yml`:

```yaml
model: openai/deepseek/deepseek-flash   # the gateway's model, through litellm's openai/ prefix
openai-api-base: http://127.0.0.1:17321/v1
openai-api-key: <the key kept for Aider>  # Aider's own key, so Usage names it
show-model-warnings: false
```

Your comments and other settings stay. Picking Aider's own model again, or switching it off, puts every key back as it
was. Restart Aider after a change: it reads its settings when it starts.
