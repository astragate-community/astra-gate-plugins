// MiniMax Code: the upstream's answer as magpie reads it.

// QUOTA says a refusal is about the account's credits or plan running out.
export const QUOTA = /insufficient|balance|credit|quota|exhaust|limit|余额|积分|额度|不足|用完|上限/i

// answer is the upstream's answer as magpie reads it: a refusal for running
// out of credits a 429 (so another account can take over), the sign-in
// noted as kept, or renewed when this request refreshed it.
// (Kept local: the kit's kept() always says "kept" and drops content-length
// on every answer, this one passes a good answer's body through untouched.)
export async function answer(res, renewed) {
  const headers = new Headers(res.headers)
  headers.set("X-Magpie-Sign-In", renewed && res.ok ? "renewed" : "kept")
  if (res.status !== 402 && res.status !== 403 && res.status !== 429) return new Response(res.body, { status: res.status, statusText: res.statusText, headers })
  const text = await res.text()
  headers.delete("content-length")
  headers.delete("content-encoding")
  if (res.status === 429 || !QUOTA.test(text)) return new Response(text, { status: res.status, statusText: res.statusText, headers })
  let msg = text.trim()
  try {
    const v = JSON.parse(text)
    msg = v?.error?.message ?? v?.message ?? v?.msg ?? v?.base_resp?.status_msg ?? msg
  } catch {}
  headers.set("content-type", "application/json")
  return new Response(JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "usage limit reached: " + msg } }), { status: 429, statusText: "Too Many Requests", headers })
}
