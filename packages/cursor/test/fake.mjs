// A fetch that answers from a function and remembers what it was asked.
export function fakeFetch(answer) {
  const calls = []
  const real = globalThis.fetch
  globalThis.fetch = async (url, init = {}) => {
    const call = { url: String(url), method: init.method, headers: init.headers ?? {}, body: init.body }
    calls.push(call)
    const r = await answer(call)
    if (r instanceof Response) return r
    return new Response(JSON.stringify(r.body ?? {}), { status: r.status ?? 200 })
  }
  return { calls, restore: () => (globalThis.fetch = real) }
}

// a JWT that runs out at exp (seconds) and says sub
export const jwt = (claims) => `h.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.s`
