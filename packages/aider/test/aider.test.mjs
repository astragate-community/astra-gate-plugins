import test from "node:test"
import assert from "node:assert/strict"
import { agent, connect } from "../src/index.mjs"

test("the agent describes Aider and where its model goes", () => {
  assert.equal(agent.id, "aider")
  assert.equal(agent.bin, "aider")
  assert.equal(agent.config, "~/.aider.conf.yml")
  assert.equal(agent.model, "model")
  assert.equal(agent.prefix, "openai/") // litellm's route to an OpenAI-compatible endpoint
  assert.deepEqual(agent.ua, ["aider", "litellm"])
  assert.match(agent.icon, /^https:\/\//)
})

test("connect writes the gateway's address and key, and silences litellm's model warnings", () => {
  assert.deepEqual(connect({ gateway: { v1: "http://127.0.0.1:17321/v1", key: "k-aider" } }), {
    "openai-api-base": "http://127.0.0.1:17321/v1",
    "openai-api-key": "k-aider",
    "show-model-warnings": false,
  })
})
