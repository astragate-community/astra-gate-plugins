// Aider (aider.chat) as an agent plugin, based on an MIT-licensed community plugin (see THIRD_PARTY_NOTICES.md).
//
// Aider keeps its settings in ~/.aider.conf.yml and reaches any OpenAI-compatible endpoint through litellm's
// openai/ prefix, so the gateway's model goes in as openai/<provider>/<model>, beside the gateway's address and the
// key it keeps for Aider. The host reads `agent` (what the agent is) and calls `connect` (what to write).
const ICON = "https://aider.chat/assets/icons/apple-touch-icon.png"

export const agent = {
  id: "aider",
  name: "Aider",
  // aider.chat's own icon, on the Agents page and the plugin's row
  icon: ICON,
  bin: "aider",
  config: "~/.aider.conf.yml",
  model: "model",
  prefix: "openai/",
  ua: ["aider", "litellm"],
  notice: "Aider reads its settings when it starts: restart it to use the new model.",
}

/** The keys written into Aider's config for a gateway ({ v1: its OpenAI base address, key: Aider's own key }). */
export function connect({ gateway }) {
  return {
    "openai-api-base": gateway.v1,
    "openai-api-key": gateway.key,
    // the gateway's model ids aren't in litellm's list, so aider would warn on each
    "show-model-warnings": false,
  }
}
