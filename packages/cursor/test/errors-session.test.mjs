import test from "node:test"
import assert from "node:assert/strict"
import { failure, maxRequired, cursorError, regional } from "../src/errors.mjs"
import { expiry } from "../src/jwt.mjs"
import { tokenOf, keyToken } from "../src/session.mjs"
import { fakeFetch, jwt } from "./fake.mjs"

test("failure: Connect's details say it best, and the code picks the status", () => {
  const body = JSON.stringify({ code: "resource_exhausted", message: "Error", details: [{ debug: { details: { title: "Usage", detail: "limit hit" } } }] })
  assert.deepEqual(failure(429, body), { status: 429, message: "usage limit reached: Usage: limit hit" })
  assert.deepEqual(failure(200, JSON.stringify({ error: { code: "unavailable", message: "later" } })), { status: 503, message: "later" })
  assert.deepEqual(failure(400, JSON.stringify({ code: "invalid_argument", message: "bad" })), { status: 400, message: "bad" })
})

test("failure: a stream that ended well keeps its 2xx; a non-JSON body is the text", () => {
  assert.deepEqual(failure(200, "{}"), { status: 200, message: "" })
  assert.deepEqual(failure(502, "bad gateway\n"), { status: 502, message: "bad gateway" })
})

test("failure: an expired sign-in is a 401 told to sign in again; a region is a 403", () => {
  assert.equal(failure(500, JSON.stringify({ code: "internal", message: "token expired" })).status, 401)
  const r = failure(500, JSON.stringify({ code: "internal", message: "not served in your region" }))
  assert.equal(r.status, 403)
  assert.ok(regional(r.message))
})

test("maxRequired knows Cursor's Max Mode refusal", () => {
  assert.ok(maxRequired('Max Mode Required: The model "x" requires Max Mode to be enabled.'))
  assert.ok(!maxRequired("rate limit"))
})

test("cursorError is OpenAI's error shape and keeps the sign-in", async () => {
  const res = cursorError({ status: 401, message: "no" })
  assert.equal(res.status, 401)
  assert.equal(res.headers.get("x-magpie-sign-in"), "kept")
  assert.deepEqual(await res.json(), { error: { message: "no", type: "cursor_error", code: 401 } })
})

test("expiry reads a JWT's exp in ms, and 0 for anything else", () => {
  assert.equal(expiry(jwt({ exp: 1000 })), 1_000_000)
  assert.equal(expiry(jwt({})), 0)
  assert.equal(expiry("not a jwt"), 0)
  assert.equal(expiry(undefined), 0)
})

test("tokenOf: a live token is used as it is; a lapsed one asks to sign in again", async () => {
  const live = jwt({ exp: Date.now() / 1000 + 3600 })
  assert.equal(await tokenOf({ type: "oauth", access: live, refresh: "none", expires: 0 }), live)
  await assert.rejects(tokenOf({ type: "oauth", access: "x", refresh: "none", expires: Date.now() - 1 }), (e) => e.status === 401 && /run out/.test(e.message))
  await assert.rejects(tokenOf({ type: "oauth", access: "", refresh: "none" }), /isn't signed in/)
  await assert.rejects(tokenOf(undefined), /isn't signed in/)
})

test("an API key is exchanged once and the token kept while it lasts", async () => {
  const tok = jwt({ exp: Date.now() / 1000 + 3600 })
  const f = fakeFetch(() => ({ body: { accessToken: tok } }))
  try {
    assert.equal(await keyToken("key-1"), tok)
    assert.equal(await tokenOf({ type: "api", key: "key-1" }), tok)
    assert.equal(f.calls.length, 1)
    assert.match(f.calls[0].url, /\/auth\/exchange_user_api_key$/)
    assert.equal(f.calls[0].headers.Authorization, "Bearer key-1")
  } finally {
    f.restore()
  }
})

test("an API key Cursor refuses is a 401, a server error a 502", async () => {
  let status = 401
  const f = fakeFetch(() => ({ status, body: {} }))
  try {
    await assert.rejects(keyToken("key-2"), (e) => e.status === 401 && /didn't take/.test(e.message))
    status = 503
    await assert.rejects(keyToken("key-3"), (e) => e.status === 502 && /HTTP 503/.test(e.message))
  } finally {
    f.restore()
  }
})
