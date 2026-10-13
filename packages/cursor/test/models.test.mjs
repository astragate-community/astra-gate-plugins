import test from "node:test"
import assert from "node:assert/strict"
import { modelsOf, tokensOf, runtimeModel, usable } from "../src/models.mjs"
import { request, splitID, fitEffort } from "../src/variants.mjs"
import { fakeFetch } from "./fake.mjs"

const values = (...vs) => ({ enumParameter: { values: vs.map((value) => ({ value })) } })
const variant = (legacySlug, effort, context, extra = {}) => ({ legacySlug, parameterValues: [{ id: "effort", value: effort }, { id: "context", value: context }], ...extra })
const claude = {
  name: "claude-x",
  clientDisplayName: "Claude X",
  contextTokenLimit: 200000,
  parameterDefinitions: [{ id: "context", parameterType: values("200k", "1m") }, { id: "effort", parameterType: values("low", "high") }],
  variants: [
    variant("claude-x-low", "low", "200k", { isDefaultNonMaxConfig: true }),
    variant("claude-x-high", "high", "200k"),
    variant("claude-x-low-1m", "low", "1m", { isMaxMode: true }),
    variant("claude-x-high-1m", "high", "1m", { isMaxMode: true }),
  ],
}

test("tokensOf reads k and m", () => {
  assert.equal(tokensOf("300k"), 300000)
  assert.equal(tokensOf("1m"), 1000000)
  assert.equal(tokensOf("1.5M"), 1500000)
  assert.equal(tokensOf("huge"), 0)
})

test("a model is offered once for each context size, with that window and its efforts", () => {
  const list = modelsOf([claude, { name: "gemini-2.5-pro" }, { name: "hidden", isHidden: true }, { name: "chat", isChatOnly: true }], null)
  assert.deepEqual(list.map((m) => [m.id, m.name, m.context]), [["claude-x@200k", "Claude X @ 200k", 200000], ["claude-x@1m", "Claude X @ 1m", 1000000]])
  assert.deepEqual(list[0].levels, { low: "low", high: "high" })
  const rt = runtimeModel(list[1])
  assert.equal(rt.providerID, "cursor")
  assert.equal(rt.limit.context, 1000000)
  assert.equal(rt.capabilities.reasoning, true)
  assert.deepEqual(Object.keys(rt.variants), ["low", "high"])
})

test("a model with no sizes is offered once, and the default model is auto", () => {
  const list = modelsOf([{ name: "default", contextTokenLimit: 123000 }, { name: "plain" }], null)
  assert.deepEqual(list.map((m) => [m.id, m.context]), [["auto", 123000], ["plain", 200000]])
})

test("the usable list takes out the variants the account hasn't got", () => {
  const list = modelsOf([claude], new Set(["claude-x-low", "claude-x-low-1m"]))
  assert.deepEqual(list[0].levels, { low: "low" })
})

test("request: the effort and context asked for pick Cursor's variant, in Max Mode where it needs it", () => {
  const raw = modelsOf([claude], null)
  assert.deepEqual(request(raw, "claude-x@200k", "high", undefined), { id: "claude-x-high", params: [{ id: "effort", value: "high" }, { id: "context", value: "200k" }], maxMode: false })
  const big = request(raw, "claude-x@1m", "low", undefined)
  assert.equal(big.id, "claude-x-low-1m")
  assert.equal(big.maxMode, true)
})

test("request: an id of Cursor's own that the list lacks runs as the variant it names; an unknown one as it is", () => {
  const raw = modelsOf([claude], null)
  assert.equal(request(raw, "claude-x-high", "", undefined).id, "claude-x-high")
  assert.deepEqual(request(raw, "mystery", "", undefined), { id: "mystery", params: [], maxMode: false })
  assert.equal(request(raw, "auto", "", undefined).id, "default")
})

test("fitEffort goes to the nearest level; splitID takes an id apart", () => {
  assert.equal(fitEffort("xhigh", ["low", "medium", "high"]), "high")
  assert.equal(fitEffort("ultra", ["low", "max"]), "max")
  assert.equal(fitEffort("none", ["low", "high"]), "low")
  assert.deepEqual(splitID("claude-opus-5-5-high-thinking-fast"), ["claude-opus-5-5-thinking-fast", "high"])
  assert.deepEqual(splitID("cursor-grok-4.6"), ["cursor-grok-4.6", ""])
})

test("usable: the picker, less what the usable list lacks, kept per token", async () => {
  const f = fakeFetch((c) =>
    c.url.endsWith("AvailableModels") ? { body: { models: [claude] } } : { body: { models: [{ modelId: "claude-x-low" }, { displayModelId: "claude-x-low-1m" }] } },
  )
  try {
    const raw = await usable("models-tok")
    assert.deepEqual(raw.map((m) => m.id), ["claude-x@200k", "claude-x@1m"])
    assert.deepEqual(raw[0].levels, { low: "low" })
    await usable("models-tok")
    assert.equal(f.calls.length, 2)
  } finally {
    f.restore()
  }
})

test("usable: a picker with no models is a failure", async () => {
  const f = fakeFetch(() => ({ body: { models: [] } }))
  try {
    await assert.rejects(usable("empty-tok"), /listed no models/)
  } finally {
    f.restore()
  }
})
