// Qoder: calling the account API (openapi) and the headers a device-token call carries.

// The call timeout of the account API, in ms.
export const API_TIMEOUT = 20_000

export async function openapi(site, path, { method = "GET", token, body, query } = {}) {
  const url = new URL(site.openapi + path)
  for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, v)
  const headers = { Accept: "application/json" }
  if (body) headers["Content-Type"] = "application/json"
  if (token) headers.Authorization = `Bearer ${token}`
  const res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(API_TIMEOUT) })
  const text = await res.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {}
  return { status: res.status, json, text }
}

// deviceHeaders is what a call on the device token (the account pages: usage, campaigns) sends, as Qoder's client does.
export const deviceHeaders = (deviceToken) => ({
  Accept: "application/json",
  Authorization: `Bearer ${deviceToken}`,
  "Cosy-ClientType": "10",
  "User-Agent": "Qoder",
})
