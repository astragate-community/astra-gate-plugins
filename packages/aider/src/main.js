// Aider (aider.chat) as a v2 client plugin, a rewrite of the v1 agent plugin. Aider keeps its settings in
// ~/.aider.conf.yml and reaches any OpenAI-compatible endpoint through litellm's openai/ prefix, so the gateway's model
// goes in as openai/<provider>/<model>, beside the gateway's address and the key kept for Aider. What Aider is (its
// config file, the model's key path, the prefix, the user agents that name it) is the manifest's `clients` entry; this
// file is the `connect` half: which keys to write.

import { definePlugin, clients } from "astra"

/** The keys written into Aider's config for a gateway ({ v1: its OpenAI base address, key: Aider's own key }). */
export function connect({ gateway }) {
  return {
    "openai-api-base": gateway.v1,
    "openai-api-key": gateway.key,
    // the gateway's model ids aren't in litellm's list, so aider would warn on each
    "show-model-warnings": false,
  }
}

export default definePlugin({
  activate(ctx) {
    ctx.subscriptions.push(clients.register("aider", { connect }))
  },
})
