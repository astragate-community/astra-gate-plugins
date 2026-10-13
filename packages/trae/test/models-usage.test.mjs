import test from "node:test"
import assert from "node:assert/strict"
import { SITES } from "../src/sites.mjs"
import { chatModel, chooseModels, createCatalog, devModel, maxModel, modelOf } from "../src/models.mjs"
import { batchLists, listOf } from "../src/api.mjs"
import { Expired } from "../src/errors.mjs"
import { createSessions, fromAuth } from "../src/session.mjs"
import { credits, dollarUsageOf, readUsage, round, usageCard } from "../src/usage.mjs"
import { auth, fake, json, restoreFetch } from "./fake.mjs"

const cn = SITES["trae-cn"]
const global = SITES["trae-global"]
test.afterEach(restoreFetch)

const entry = (id, o = {}) => ({ config_name: id, display_name: id.toUpperCase(), model_detail_list: [{ model_name: id + "__dev", max_tokens: 8000 }], context_window_tokens: { dev: 100_000 }, ...o })

test("chatModel: chat models only — not helpers, switched-off configs, custom slots, or (Global) hidden channels", () => {
  assert.equal(chatModel(entry("a"), cn), true)
  assert.equal(chatModel(entry("a", { usage: "summary" }), cn), false)
  assert.equal(chatModel(entry("a", { usage: "chat_completion" }), cn), true)
  assert.equal(chatModel(entry("a", { config_switch: false }), cn), false)
  assert.equal(chatModel(entry("custom_model_3"), cn), false)
  assert.equal(chatModel(entry("a", { is_custom_model: true }), cn), false)
  assert.equal(chatModel(entry("a", { display_config: { is_custom_model: true } }), cn), false)
  assert.equal(chatModel(entry("a", { is_invisible_to_user: true }), cn), true) // Trae CN's lists are served whole
  assert.equal(chatModel(entry("a", { is_invisible_to_user: true }), global), false)
  assert.equal(chatModel({}, cn), false)
})

test("devModel / maxModel: the __dev model, and a Max only when its window is bigger", () => {
  const e = entry("m", { model_detail_list: [{ model_name: "m__dev", max_tokens: 4000 }, { model_name: "m__max", max_tokens: 64000 }], context_window_tokens: { dev: 100_000, max: 500_000 } })
  assert.equal(devModel(e).model_name, "m__dev")
  assert.deepEqual(maxModel(e), { name: "m__max", most: 64000, window: 500_000, entry: e })
  assert.equal(maxModel(entry("m", { model_detail_list: e.model_detail_list, context_window_tokens: { dev: 100_000, max: 100_000 } })), null)
  assert.equal(maxModel(entry("plain")), null)
  // the __max model from one entry, the window from another's
  const named = entry("m", { model_detail_list: e.model_detail_list, context_window_tokens: undefined })
  assert.equal(maxModel(named, e).window, 500_000)
})

test("chooseModels: a model several functions list is asked through the entry that names a __dev model", () => {
  const lists = {
    chat_v3: [entry("a", { model_detail_list: [] }), entry("b")],
    solo_agent: [entry("a"), entry("c")],
  }
  const chosen = chooseModels(lists, cn)
  assert.deepEqual(chosen.map((c) => [c.id, c.fn]), [["a", "solo_agent"], ["b", "chat_v3"], ["c", "solo_agent"]])
  assert.equal(chosen[0].dev.model_name, "a__dev")
  assert.equal(chosen[0].max, null)
})

test("chooseModels: an entry carrying another model's name loses to the one the lists agree on", () => {
  const lists = {
    chat_v3: [entry("flash", { display_name: "Other Name" }), entry("other", { display_name: "Other Name" })],
    solo_agent: [entry("flash", { display_name: "Flash" })],
    solo_work_lite: [entry("flash", { display_name: "Flash" })],
  }
  assert.equal(chooseModels(lists, cn).find((c) => c.id === "flash").fn, "solo_work_lite")
})

test("chooseModels: a Max is found across the functions' entries and asked through the one naming it", () => {
  const withMax = entry("m", { model_detail_list: [{ model_name: "m__dev", max_tokens: 4000 }, { model_name: "m__max", max_tokens: 64000 }], context_window_tokens: { dev: 100_000, max: 500_000 } })
  const [c] = chooseModels({ chat_v3: [entry("m")], solo_agent: [withMax] }, cn)
  assert.equal(c.max.window, 500_000)
  assert.equal(c.maxFn, "solo_agent")
  // a list with its own "-max" entry is left to it
  const own = chooseModels({ chat_v3: [withMax, entry("m-max")] }, cn)
  assert.equal("max" in own.find((x) => x.id === "m"), false)
})

test("modelOf: the list's context and output over the fallback's, capabilities filled in", () => {
  const m = modelOf(cn, { models: { x: { name: "Fallback", limit: { context: 5, output: 6 }, capabilities: { reasoning: false } } } }, entry("x", { context_window_tokens: undefined }))
  assert.equal(m.id, "x")
  assert.equal(m.providerID, "trae-cn")
  assert.equal(m.name, "X") // the list's display name
  assert.deepEqual(m.limit, { context: 5, output: 8000 })
  assert.equal(m.capabilities.reasoning, false) // the fallback stays the authority where it has an entry
  assert.equal(m.capabilities.toolcall, true)
  assert.deepEqual(m.capabilities.input, { text: true, image: false, audio: false, video: false, pdf: false })
  assert.deepEqual(m.variants, {})
  const fresh = modelOf(cn, { models: {} }, entry("y"))
  assert.equal(fresh.capabilities.reasoning, true)
  assert.equal(fresh.limit.context, 100_000)
  assert.equal(fresh.api.id, "y")
})

test("batchLists / listOf: the answer's groups, a lapsed token Expired, a failure an error", async () => {
  const a = fromAuth(auth(), cn)
  const calls = fake(() => json({ function_configs: [{ function: "chat_v3", config_info_list: [entry("a"), {}] }, { function: "solo_agent", config_info_list: [entry("b")] }, { function: "unknown", config_info_list: [entry("z")] }, { function: "chat_v3", config_info_list: [entry("c")] }] }))
  const lists = await batchLists(a, cn)
  assert.equal(calls[0].url, "https://trae-api-cn.mchost.guru/api/ide/v1/batch_get_detail_param")
  assert.deepEqual(JSON.parse(calls[0].body).functions, cn.functions)
  assert.deepEqual(Object.keys(lists), ["chat_v3", "solo_agent"])
  assert.deepEqual(lists.chat_v3.map((m) => m.config_name), ["a", "c"])
  fake(() => json({}))
  assert.equal(await batchLists(a, cn), null)
  fake(() => json({ code: 1001 }))
  await assert.rejects(batchLists(a, cn), Expired)
  fake(() => json({}, 500))
  await assert.rejects(listOf(a, cn, "chat_v3"), /Trae CN models: 500 Internal Server Error/)
  const one = fake(() => json({ data: { config_info_list: [entry("a")] } }))
  assert.equal((await listOf(a, cn, "solo_agent")).length, 1)
  assert.equal(JSON.parse(one[0].body).function, "solo_agent")
})

test("catalog.live / models: the lists are read, a Max listed as a model of its own", async () => {
  const withMax = entry("m", { model_detail_list: [{ model_name: "m__dev", max_tokens: 4000 }, { model_name: "m__max", max_tokens: 64000 }], context_window_tokens: { dev: 100_000, max: 500_000 } })
  fake(() => json({ function_configs: [{ function: "chat_v3", config_info_list: [entry("p")] }, { function: "solo_agent", config_info_list: [withMax] }] }))
  const catalog = createCatalog(cn)
  const ms = await catalog.live(fromAuth(auth(), cn))
  assert.deepEqual(ms.map((m) => m.config_name), ["p", "m"])
  assert.equal(catalog.listedBy.get("m"), "solo_agent")
  assert.equal(catalog.listedBy.get("m-max"), "solo_agent")
  assert.deepEqual(catalog.modelNames.get("m-max"), { fn: "solo_agent", name: "m__max", most: 64000, max: { base: "m", window: 500_000 } })
  assert.deepEqual(catalog.modelNames.get("p"), { fn: "chat_v3", name: "p__dev", most: 8000 })
  const out = catalog.models({ models: {} }, ms)
  assert.deepEqual(Object.keys(out), ["p", "m", "m-max"])
  assert.equal(out["m-max"].name, "M (Max)")
  assert.deepEqual(out["m-max"].limit, { context: 500_000, output: 64000 })
  assert.equal(out["m-max"].api.id, "m-max")
})

test("catalog.live: with no batch, each function is asked; one failing leaves the others, all failing is the error", async () => {
  const lists = { chat_v3: [entry("a")], solo_agent: [entry("b")] }
  const calls = fake((url, init) => {
    if (url.includes("batch_")) return json({})
    const fn = JSON.parse(init.body).function
    return lists[fn] ? json({ config_info_list: lists[fn] }) : json({}, 500)
  })
  const ms = await createCatalog(cn).live(fromAuth(auth(), cn))
  assert.deepEqual(ms.map((m) => m.config_name), ["a", "b"])
  assert.equal(calls.length, 1 + cn.functions.length)
  fake(() => json({}, 500))
  await assert.rejects(createCatalog(cn).live(fromAuth(auth(), cn)), /Trae CN models: 500/)
  fake((url) => (url.includes("batch_") ? json({}) : json({ code: 1001 })))
  await assert.rejects(createCatalog(cn).live(fromAuth(auth(), cn)), Expired)
})

test("credits: packs added up, -1 unlimited, the soonest end", () => {
  const pack = (limit, used, end) => ({ entitlement_base_info: { quota: { credits_limit: limit }, end_time: end }, usage: { credits_amount: used } })
  assert.deepEqual(credits({ user_entitlement_pack_list: [pack(100, 30, 1_900_000_000), pack(50, 5, 1_800_000_000), { entitlement_base_info: {} }] }), { limit: 150, used: 35, unlimited: false, until: 1_800_000_000_000 })
  assert.equal(credits({ user_entitlement_pack_list: [pack(-1, 0)] }).unlimited, true)
  assert.deepEqual(credits({}), { limit: 0, used: 0, unlimited: false, until: 0 })
})

test("dollarUsageOf: the allowance and what was used of each part; null with no pack", () => {
  const v = { user_entitlement_pack_list: [{ display_desc: "Free", entitlement_base_info: { quota: { basic_usage_limit: 3, bonus_usage_limit: 1 }, end_time: 1_900_000_000 }, usage: { basic_usage_amount: 1, bonus_usage_amount: 0.5 } }] }
  assert.deepEqual(dollarUsageOf(v), { plan: "Free", basic: 3, bonus: 1, used: 1, usedBonus: 0.5, end: 1_900_000_000_000 })
  assert.equal(dollarUsageOf({}), null)
  assert.equal(round(1.2345), 1.23)
})

test("usageCard: CN's window is the credits, Global's the dollars; unlimited and no-pack answers", () => {
  const a = { name: "bob", uid: "u" }
  const v = { is_credits_billing: true, user_entitlement_pack_list: [{ entitlement_base_info: { quota: { credits_limit: 200 }, end_time: 1_900_000_000 }, usage: { credits_amount: 50 } }] }
  assert.deepEqual(usageCard(cn, v, a, "kept"), {
    plan: "Credits", user: "bob", signIn: "kept",
    windows: [{ name: "Credits", used: 25, amount: 50, limit: 200, unit: "credits", resetsAt: new Date(1_900_000_000_000).toISOString() }],
  })
  assert.equal(usageCard(cn, { user_entitlement_pack_list: [{ entitlement_base_info: { quota: { credits_limit: -1 } } }] }, a, "kept").balance, "unlimited")
  assert.equal(usageCard(cn, {}, a, "kept").plan, "Free")
  const d = { user_entitlement_pack_list: [{ display_desc: "Pro", entitlement_base_info: { quota: { basic_usage_limit: 3, bonus_usage_limit: 1 } }, usage: { basic_usage_amount: 1 } }] }
  assert.deepEqual(usageCard(global, d, a, "renewed"), { plan: "Pro", user: "bob", signIn: "renewed", windows: [{ name: "Dollar Usage", used: 25, amount: 1, limit: 4, unit: "usd" }] })
  assert.deepEqual(usageCard(global, {}, a, "kept"), { error: "Trae Global usage: no entitlement pack in the answer", signIn: "kept", user: "bob" })
})

test("readUsage: the page by realm and region, the card, and the errors", async () => {
  const sessions = createSessions(global, null)
  const calls = fake(() => json({ user_entitlement_pack_list: [{ entitlement_base_info: { quota: { basic_usage_limit: 2 } }, usage: {} }] }))
  const card = await readUsage(global, sessions, async () => auth({ region: "US" }))
  assert.equal(calls[0].url, "https://api-us-east.trae.ai/trae/api/v1/pay/user_current_entitlement_list")
  assert.equal(card.windows[0].limit, 2)
  await readUsage(global, sessions, async () => auth())
  assert.equal(calls[1].url, "https://api-sg-central.trae.ai/trae/api/v1/pay/user_current_entitlement_list")
  const cnCalls = fake(() => json({}))
  await readUsage(cn, createSessions(cn, null), async () => auth())
  assert.equal(cnCalls[0].url, "https://api.trae.cn/trae/api/v2/pay/ide_user_ent_usage")
  assert.deepEqual(JSON.parse(cnCalls[0].body), { require_usage: true, req_source: 0 })
  fake(() => json({ code: 1001 }))
  assert.deepEqual(await readUsage(cn, createSessions(cn, null), async () => auth()), { error: "alice: Trae CN's sign-in has expired — sign in again", signIn: "expired" })
  fake(() => json({ code: 9, message: "busy" }))
  assert.deepEqual(await readUsage(cn, createSessions(cn, null), async () => auth()), { error: "Trae CN credits: busy", signIn: "kept", user: "alice" })
  fake(() => json({}, 503))
  assert.equal((await readUsage(cn, createSessions(cn, null), async () => auth())).error, "Trae CN credits: 503 Service Unavailable")
  assert.deepEqual(await readUsage(cn, createSessions(cn, null), async () => ({ type: "api" })), { error: "Trae CN: not signed in", signIn: "expired" })
})
