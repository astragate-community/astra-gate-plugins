import test from "node:test"
import assert from "node:assert/strict"
import { TraeCNAuthPlugin, TraeGlobalAuthPlugin } from "../src/index.mjs"
import { NOW, auth, chatRequest, ev, fake, json, jwt, readAll, restoreFetch, sseBody } from "./fake.mjs"

test.afterEach(restoreFetch)

const start = async (Plugin = TraeCNAuthPlugin, stored = auth()) => {
  const saved = []
  const hooks = await Plugin({ client: { auth: { set: async (x) => saved.push(x) } } })
  const loaded = await hooks.auth.loader(async () => stored)
  return { hooks, loaded, saved }
}
const ask = (loaded, req, init = {}) => loaded.fetch("https://x/v1/chat/completions", { method: "POST", body: JSON.stringify(req), ...init })
const answer = () => sseBody(ev("output", { content: "Hi" }), ev("token_usage", { usage: { prompt_tokens: 1, completion_tokens: 1 } }), ev("done", {}))

test("the two plugins: provider ids, the config's models and api, one browser sign-in method each", async () => {
  for (const [Plugin, id, name, api] of [[TraeCNAuthPlugin, "trae-cn", "Trae CN", "https://trae-api-cn.mchost.guru/v1"], [TraeGlobalAuthPlugin, "trae-global", "Trae Global", "https://coresg-normal.trae.ai/v1"]]) {
    const hooks = await Plugin({})
    assert.equal(hooks.auth.provider, id)
    assert.equal(hooks.provider.id, id)
    assert.equal(hooks.auth.refreshLead, 600_000)
    assert.deepEqual(hooks.auth.methods.map((m) => [m.type, m.label]), [["oauth", `${name} account (browser)`]])
    const config = { provider: { [id]: { models: { mine: { name: "Mine" } } } } }
    await hooks.config(config)
    assert.equal(config.provider[id].name, name)
    assert.equal(config.provider[id].api, api)
    assert.equal(config.provider[id].models.mine.name, "Mine")
    assert.ok(Object.keys(config.provider[id].models).length > 1)
  }
})

test("chat.headers: the session rides a header, for this provider only", async () => {
  const { hooks } = await start()
  const out = { headers: {} }
  await hooks["chat.headers"]({ model: { providerID: "trae-cn" }, sessionID: "s-1" }, out)
  assert.equal(out.headers["x-magpie-trae-session"], "s-1")
  const other = { headers: {} }
  await hooks["chat.headers"]({ model: { providerID: "other" }, sessionID: "s-1" }, other)
  assert.deepEqual(other.headers, {})
})

test("loader: no sign-in loads nothing; a sign-in names the host and a placeholder key", async () => {
  const hooks = await TraeCNAuthPlugin({})
  assert.deepEqual(await hooks.auth.loader(async () => ({ type: "api" })), {})
  const { loaded } = await start(TraeGlobalAuthPlugin, auth({ region: "US" }))
  assert.equal(loaded.baseURL, "https://coreva-normal.trae.ai/v1")
  assert.equal(loaded.apiKey, "trae")
})

test("a chat: the request goes to llm_utils_chat with the JWT, and comes back as a completion", async () => {
  const calls = fake(() => answer())
  const { loaded } = await start()
  const res = await ask(loaded, chatRequest({ max_tokens: 10, stream: true }))
  const out = await readAll(res)
  assert.equal(out.status, 200)
  assert.equal(out.headers["x-magpie-sign-in"], "kept")
  assert.equal(calls[0].url, "https://trae-api-cn.mchost.guru/api/agent/v3/llm_utils_chat")
  assert.equal(calls[0].init.headers.Authorization, `Cloud-IDE-JWT ${auth().access}`)
  assert.equal(calls[0].init.headers.Accept, "text/event-stream")
  const sent = JSON.parse(calls[0].body)
  assert.equal(sent.function, "chat_v3")
  assert.equal(sent.max_tokens, 10)
  assert.deepEqual(sent.messages, [{ role: "user", content: [{ type: "text", text: "hello" }] }])
  const body = JSON.parse(out.text.split("\n\n").filter(Boolean)[0].slice(6))
  assert.equal(body.object, "chat.completion.chunk")
})

test("a chat, not streamed: one body with the usage; a request that is not a chat is refused", async () => {
  fake(() => answer())
  const { loaded } = await start()
  const body = JSON.parse((await readAll(await ask(loaded, chatRequest({ stream: false })))).text)
  assert.equal(body.choices[0].message.content, "Hi")
  assert.equal(body.usage.total_tokens, 2)
  const refused = await readAll(await ask(loaded, { model: "m" }))
  assert.equal(refused.status, 400)
  assert.match(JSON.parse(refused.text).error.message, /^Trae CN: only chat completions are served$/)
})

test("the session names the conversation: the same id across a conversation's requests, a header or the first message", async () => {
  const calls = fake(() => answer())
  const { loaded } = await start()
  await ask(loaded, chatRequest({ stream: false }), { headers: { "x-magpie-trae-session": "S" } })
  await ask(loaded, chatRequest({ stream: false }), { headers: { "x-magpie-trae-session": "S" } })
  await ask(loaded, chatRequest({ stream: false, messages: [{ role: "user", content: "hello" }, { role: "assistant", content: "x" }, { role: "user", content: "more" }] }))
  await ask(loaded, chatRequest({ stream: false }))
  const ids = calls.map((c) => JSON.parse(c.body).session_id)
  assert.equal(ids[0], ids[1])
  assert.notEqual(ids[0], ids[2])
  assert.equal(ids[2], ids[3]) // the first user message, repeated by each turn
  assert.equal(new Set(calls.map((c) => JSON.parse(c.body).request_id)).size, 4) // a request's own
})

test("a function that does not take the model (4001) is skipped, the next tried, and remembered", async () => {
  const calls = fake((url, init, seen) => (seen.length === 1 ? json({ code: 4001, message: "no such model" }, 400) : answer()))
  const { loaded } = await start()
  const res = await ask(loaded, chatRequest({ stream: false }))
  assert.equal(res.status, 200)
  assert.deepEqual(calls.map((c) => JSON.parse(c.body).function), ["chat_v3", "solo_work_lite"])
  const again = fake(() => answer())
  await ask(loaded, chatRequest({ stream: false }))
  assert.equal(JSON.parse(again[0].body).function, "solo_work_lite") // the one that served this account last goes first
})

test("an error event naming a wrong function is retried; any other error is the refusal, with the sign-in kept", async () => {
  const calls = fake((url, init, seen) => (seen.length === 1 ? sseBody(ev("error", { code: 4023, message: "wrong" })) : sseBody(ev("error", { code: 4008, message: "quota used up" }))))
  const { loaded } = await start()
  const res = await readAll(await ask(loaded, chatRequest({ stream: false })))
  assert.equal(calls.length, 2)
  assert.equal(res.status, 429)
  assert.equal(res.headers["x-magpie-sign-in"], "kept")
})

test("a refusal: 401 marks the sign-in expired; a JSON 200 is an error; others keep their status", async () => {
  const { loaded } = await start()
  fake(() => json({ code: 1001, message: "not logged in" }, 401))
  const lapsed = await readAll(await ask(loaded, chatRequest()))
  assert.equal(lapsed.status, 401)
  assert.equal(lapsed.headers["x-magpie-sign-in"], "expired")
  fake(() => json({ code: 4008, message: "quota" }))
  assert.equal((await readAll(await ask(loaded, chatRequest()))).status, 429)
  fake(() => json({ message: "teapot" }, 418))
  const other = await readAll(await ask(loaded, chatRequest()))
  assert.equal(other.status, 418)
  assert.equal(other.headers["x-magpie-sign-in"], "kept")
})

test("a token near its end is renewed before the request, saved, and the answer says so", async () => {
  const calls = fake((url) => (url.includes("ExchangeToken") ? json({ Result: { Token: jwt(7200), RefreshToken: "R2" } }) : answer()))
  const { loaded, saved } = await start(TraeGlobalAuthPlugin, auth({ expires: NOW + 30_000 }))
  const res = await readAll(await ask(loaded, chatRequest({ stream: false })))
  assert.equal(res.headers["x-magpie-sign-in"], "renewed")
  assert.equal(calls[0].url, "https://growsg-normal.trae.ai/cloudide/api/v3/trae/oauth/ExchangeToken")
  assert.equal(saved[0].body.refresh, "R2")
  assert.match(calls[1].init.headers.Authorization, /^Cloud-IDE-JWT h\./)
})

test("a refused refresh token answers 401 expired", async () => {
  fake(() => json({ message: "refresh token expired" }, 400))
  const { loaded } = await start(TraeGlobalAuthPlugin, auth({ expires: NOW + 30_000 }))
  const res = await readAll(await ask(loaded, chatRequest()))
  assert.equal(res.status, 401)
  assert.equal(res.headers["x-magpie-sign-in"], "expired")
  assert.match(JSON.parse(res.text).error.message, /^alice: Trae Global's sign-in has expired/)
})

test("a Max model asked before the list was read: the list is read, then the base model asked through its function", async () => {
  const withMax = { config_name: "m", display_name: "M", model_detail_list: [{ model_name: "m__dev", max_tokens: 4000 }, { model_name: "m__max", max_tokens: 64000 }], context_window_tokens: { dev: 100_000, max: 500_000 } }
  const calls = fake((url) => (url.includes("batch_get") ? json({ function_configs: [{ function: "solo_agent", config_info_list: [withMax] }] }) : answer()))
  const { loaded } = await start()
  await ask(loaded, chatRequest({ model: "m-max", stream: false, max_tokens: 100_000 }))
  const sent = JSON.parse(calls[1].body)
  assert.equal(sent.function, "solo_agent")
  assert.equal(sent.config_name, "m")
  assert.equal(sent.model_name, "m__max")
  assert.equal(sent.max_tokens, 64000)
  assert.equal(sent.user_message_context.model_info.prompt_max_tokens, 436000)
})

test("a cancelled request aborts Trae's fetch", async () => {
  let signal
  fake((url, init) => {
    signal = init.signal
    return answer()
  })
  const { loaded } = await start()
  const ctl = new AbortController()
  const res = await ask(loaded, chatRequest(), { signal: ctl.signal })
  ctl.abort()
  assert.equal(signal.aborted, true)
  await res.body?.cancel()
})

test("provider.models: the account's list replaces the fallback; no list or an error keeps it; an expired sign-in throws", async () => {
  const { hooks } = await start()
  const provider = { models: { fallback: { name: "Fallback" } } }
  assert.equal(await hooks.provider.models(provider, { auth: { type: "api" } }), provider.models)
  fake(() => json({ function_configs: [{ function: "chat_v3", config_info_list: [{ config_name: "live", display_name: "Live" }] }] }))
  const live = await hooks.provider.models(provider, { auth: auth() })
  assert.deepEqual(Object.keys(live), ["live"])
  fake(() => json({}, 500))
  assert.equal(await hooks.provider.models(provider, { auth: auth() }), provider.models)
  fake(() => json({ code: 1001 }))
  await assert.rejects(hooks.provider.models(provider, { auth: auth() }), /sign-in has expired/)
})

test("usage and refresh hooks", async () => {
  const { hooks } = await start(TraeGlobalAuthPlugin)
  fake(() => json({ user_entitlement_pack_list: [{ display_desc: "Free", entitlement_base_info: { quota: { basic_usage_limit: 4 } }, usage: { basic_usage_amount: 1 } }] }))
  const card = await hooks.auth.usage(async () => auth())
  assert.equal(card.plan, "Free")
  assert.equal(card.windows[0].used, 25)
  fake(() => json({ Result: { Token: jwt(7200), RefreshToken: "R2" } }))
  assert.equal((await hooks.auth.refresh(auth())).refresh, "R2")
})

test("Trae CN's own pages go as the account: growth pages with the IDE's headers and {req_source:1} for an empty body", async () => {
  const calls = fake(() => json({ code: 0 }))
  const { loaded } = await start()
  const res = await loaded.fetch("https://api.trae.cn/trae/api/v2/ug/checkin_credits/status", { method: "POST", body: "{}" })
  assert.equal(res.status, 200)
  assert.equal(res.headers.get("x-magpie-sign-in"), "kept")
  assert.equal(calls[0].body, '{"req_source":1}')
  assert.match(calls[0].init.headers["User-Agent"], /TRAE-SOLO-CN/)
  assert.equal("x-ide-token" in calls[0].init.headers, false)
  await loaded.fetch("https://api.trae.cn/trae/api/v2/pay/ide_user_ent_usage", { method: "GET" })
  assert.equal(calls[1].body, null)
  assert.equal(calls[1].init.headers["x-ide-token"], auth().access) // the chat's headers for other pages
  fake(() => json({ code: 1001 }, 200))
  assert.equal((await loaded.fetch("https://api.trae.cn/trae/api/v2/ug/checkin_credits/claim", { method: "POST" })).headers.get("x-magpie-sign-in"), "expired")
})

test("Trae Global has no own pages: a URL that is not a chat is refused", async () => {
  fake(() => json({}))
  const { loaded } = await start(TraeGlobalAuthPlugin)
  const res = await loaded.fetch("https://growsg-normal.trae.ai/trae/api/v2/ug/checkin_credits/status", { method: "POST", body: "{}" })
  assert.equal(res.status, 400)
})

test("the browser sign-in: the page, the callback, a signed-in result; a denial; nothing else served", async () => {
  const realFetch = globalThis.fetch
  const calls = fake(() => json({}, 500)) // the device-bound renewal is turned away: the page's token is kept
  const hooks = await TraeCNAuthPlugin({})
  const flow = await hooks.auth.methods[0].authorize()
  assert.equal(flow.method, "auto")
  assert.match(flow.instructions, /^Sign in to Trae CN \(trae\.cn\) in the browser/)
  const url = new URL(flow.url)
  assert.equal(url.origin + url.pathname, "https://www.trae.cn/authorization")
  const callback = new URL(url.searchParams.get("auth_callback_url"))
  assert.equal(callback.hostname, "127.0.0.1")
  const q = new URLSearchParams({ userJwt: JSON.stringify({ Token: jwt(3600), RefreshToken: "R0" }), userInfo: JSON.stringify({ ScreenName: "bob", UserID: "42", Host: "https://trae-api-cn.mchost.guru" }) })
  const empty = await (await realFetch(`${callback.origin}/authorize`)).text()
  assert.match(empty, /Nothing to sign in with/)
  assert.equal((await realFetch(`${callback.origin}/other`)).status, 404)
  assert.equal((await realFetch(`${callback.origin}/authorize`, { method: "OPTIONS" })).status, 204)
  const page = await (await realFetch(`${callback.origin}/authorize?${q}`)).text()
  assert.match(page, /You&#39;re signed in|You're signed in/)
  assert.match(page, /bob is signed in/)
  const result = await flow.callback()
  assert.equal(result.type, "success")
  assert.equal(result.accountId, "bob")
  assert.equal(result.uid, "42")
  assert.equal(result.api, "https://trae-api-cn.mchost.guru")
  assert.match(result.deviceId, /^\d{19}$/)
  assert.equal(calls.length, 2) // the two device-bound clients were tried
  const over = await (await realFetch(`${callback.origin}/authorize?error=denied`)).text()
  assert.match(over, /This sign-in is over/)
})

test("the browser sign-in: a denial in the callback fails it", async () => {
  const realFetch = globalThis.fetch
  const hooks = await TraeGlobalAuthPlugin({})
  const flow = await hooks.auth.methods[0].authorize()
  const callback = new URL(new URL(flow.url).searchParams.get("auth_callback_url"))
  const page = await (await realFetch(`${callback.origin}/authorize?error=access_denied&error_description=No+thanks`)).text()
  assert.match(page, /Sign-in didn(&#39;|')t finish/)
  assert.deepEqual(await flow.callback(), { type: "failed", error: "No thanks" })
})
