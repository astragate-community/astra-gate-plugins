// Qoder: calling the account API (openapi).
import { http } from 'astra';
import { tryJSON } from './util.js';

export const API_TIMEOUT = 4_000; // ms; the host's own limits are tight in a request's path and in an action

export async function openapi(site, path, { method = 'GET', token, body, query } = {}) {
  const url = new URL(site.openapi + path);
  for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, v);
  const headers = { Accept: 'application/json' };
  if (body) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await http.fetch(url.toString(), { method, headers, body: body ? JSON.stringify(body) : undefined, timeoutMs: API_TIMEOUT });
  const text = await res.text();
  return { status: res.status, json: tryJSON(text), text };
}
