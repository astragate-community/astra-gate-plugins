// The model list: the one built in, and what Grok's backend lists for an account.
import { http } from 'astra';
import { BASE } from './constants.js';
import { signHeaders } from './request.js';

// the model the built-in list offers before Grok's own list can be read
export const DEFAULT_MODELS = [{ id: 'grok-4.7', name: 'Grok 4.7', protocol: 'responses', vision: true, reasoning: true }];

/**
 * What the account can use, as the backend lists it: Responses models only, each with its context window(s). A listing
 * that can't be had throws (the caller keeps the list it had).
 */
export async function listModels(key) {
  const res = await http.fetch(`${BASE}/models`, { headers: signHeaders(key), timeoutMs: 15000, redirect: 'error' });
  if (res.status === 401) throw Object.assign(new Error("Grok's sign-in has expired; sign in again"), { code: 'sign_in' });
  if (!res.ok) throw new Error(`Grok models: ${res.status} ${(await res.text()).slice(0, 200)}`);
  const out = [];
  for (const d of (await res.json())?.data ?? []) {
    if (!d?.id || (d.api_backend && d.api_backend !== 'responses')) continue;
    out.push(...windowsOf(d, (d.reasoning_efforts ?? []).map((e) => e?.value).filter(Boolean)));
  }
  if (!out.length) throw new Error('Grok listed no models');
  return out;
}

// a window as the picker shows it: 500000 is "500k"
const labelOf = (n) => (n % 1000 === 0 ? `${n / 1000}k` : String(n));

/**
 * One model for each context window Grok lists. context_window is the default and keeps the plain id (grok-4.7), so a
 * saved agent stays where it was. Each other size in context_windows is offered beside it (grok-4.7@500k), the way the
 * CLI's /context-window offers it. A list with one size, or none, stays one model.
 */
export function windowsOf(d, efforts = []) {
  const name = d.name || d.id;
  const fallback = Number(d.context_window) || 0;
  const listed = (Array.isArray(d.context_windows) ? d.context_windows : []).map(Number).filter((n) => Number.isInteger(n) && n > 0);
  const windows = [...new Set(listed.length ? listed : [fallback].filter(Boolean))];
  const base = windows.includes(fallback) ? fallback : (windows[0] ?? 0);
  const model = (id, label, context) => ({ id, name: label, protocol: 'responses', context: context || undefined, vision: true, reasoning: efforts.length > 0 });
  const out = [model(d.id, name, base || fallback)];
  for (const w of windows) if (w !== base) out.push(model(`${d.id}@${labelOf(w)}`, `${name} @ ${labelOf(w)}`, w));
  return out;
}
