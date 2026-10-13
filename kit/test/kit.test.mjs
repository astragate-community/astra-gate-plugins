import test from "node:test"
import assert from "node:assert/strict"
import { statusText, sleep, kept, errorResponse, resultPage, textOf, randomToken, challengeOf, listenOnFirstFree } from "../src/index.mjs"

test("statusText uses Go's words and never comes back empty", () => {
  assert.equal(statusText(404), "Not Found")
  assert.equal(statusText(413), "Request Entity Too Large")
  assert.equal(statusText(509), "HTTP 509")
  assert.equal(statusText(599), "HTTP 599")
})

test("sleep waits", async () => {
  const t = Date.now()
  await sleep(20)
  assert.ok(Date.now() - t >= 15)
})

test("kept marks the sign-in and drops the headers a re-read body would break", async () => {
  const res = kept(new Response("hi", { status: 201, headers: { "content-length": "2", "content-encoding": "gzip", x: "1" } }))
  assert.equal(res.status, 201)
  assert.equal(res.headers.get("x-magpie-sign-in"), "kept")
  assert.equal(res.headers.get("content-length"), null)
  assert.equal(res.headers.get("x"), "1")
  assert.equal(await kept(new Response("a"), "b").text(), "b")
})

test("errorResponse is OpenAI-shaped and keeps the sign-in by default", async () => {
  const res = errorResponse({ status: 502, message: "down", type: "devin_error" })
  assert.equal(res.status, 502)
  assert.equal(res.headers.get("x-magpie-sign-in"), "kept")
  assert.deepEqual(await res.json(), { error: { message: "down", type: "devin_error", code: 502 } })
  assert.equal(errorResponse({ status: 401, message: "x", signIn: "expired" }).headers.get("x-magpie-sign-in"), "expired")
  assert.equal(errorResponse({ status: 401, message: "x", signIn: null }).headers.get("x-magpie-sign-in"), null)
  assert.equal((await errorResponse({ status: 429 }).json()).error.message, "Too Many Requests")
})

test("resultPage escapes what it shows", () => {
  const html = resultPage(false, "<b>", 'a "q" & b')
  assert.ok(html.includes("&lt;b&gt;") && html.includes("&quot;q&quot; &amp; b"))
  assert.ok(html.includes("✕") && !resultPage(true, "t", "x").includes("✕"))
})

test("textOf reads a string or the text parts", () => {
  assert.equal(textOf("a"), "a")
  assert.equal(textOf([{ type: "text", text: "a" }, { type: "image_url" }, { type: "text", text: "b" }]), "ab")
  assert.equal(textOf(null), "")
})

test("PKCE challenge is S256 of the verifier", () => {
  assert.equal(challengeOf("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"), "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM")
  assert.notEqual(randomToken(), randomToken())
})

test("listenOnFirstFree skips a busy port and throws when all are busy", async () => {
  const first = await listenOnFirstFree([0])
  const taken = first.server.address().port
  const second = await listenOnFirstFree([taken, 0])
  assert.notEqual(second.port, taken)
  await assert.rejects(listenOnFirstFree([taken], "busy!"), /busy!/)
  first.server.close()
  second.server.close()
})
