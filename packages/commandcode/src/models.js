// The plan's model list: the Provider API's, cut by what the plan refuses, with the built-in list standing in.
import { http } from 'astra';
import { BASE } from './constants.js';
import { MODELS, TABLE, refuses } from './catalog.js';

const isClaude = (id) => /^claude-/i.test(id) || id.startsWith('anthropic/');
const byId = (list) => Object.fromEntries(list.map((m) => [m.id, m]));

/** A catalog entry as the host's model record. */
export const hostModel = (m) => ({
  id: m.id,
  name: m.name ?? m.id,
  protocol: m.protocol ?? (isClaude(m.id) ? 'anthropic' : 'chat'),
  ...(m.context ? { context: m.context } : {}),
  ...(m.output ? { output: m.output } : {}),
  ...(typeof m.images === 'boolean' ? { vision: m.images } : {}),
  ...(m.efforts?.length ? { reasoning: true } : {}),
});

/** What the plugin offers before an account's own list is read: Claude on Messages, the rest on chat completions. */
export const builtinModels = () => MODELS.map(hostModel);

// the first of the APIs a model is served on, in the built-in's order (chat completions, Responses, Messages)
const protocolOf = (id, endpoints) => {
  const eps = (endpoints ?? []).map((e) => String(e).replace(/\/$/, '').replace(/^\/v1/, ''));
  if (eps.includes('/chat/completions')) return 'chat';
  if (eps.includes('/responses')) return 'responses';
  if (eps.includes('/messages')) return 'anthropic';
  return isClaude(id) ? 'anthropic' : 'chat';
};

/**
 * The Provider API's list, with the API each model is served on (its Claude models on /messages alone, the open ones on
 * /chat/completions and /responses, some on /responses alone); the built-in list and the CLI's table fill in names,
 * windows, pictures and reasoning levels it leaves out. Every Claude model takes pictures; of any other the list says
 * nothing unless a table does.
 */
export async function liveModels(key) {
  const res = await http.fetch(BASE + '/models', { headers: { Authorization: `Bearer ${key}`, 'x-api-key': key }, timeoutMs: 15000 });
  if (!res.ok) throw new Error(`models: ${res.status}`);
  const body = await res.json();
  const known = byId(MODELS);
  const table = byId(TABLE);
  const out = [];
  for (const m of body?.data ?? []) {
    if (!m?.id) continue;
    const k = known[m.id];
    const t = table[m.id];
    let images = Array.isArray(m.modalities?.input) ? m.modalities.input.includes('image') : undefined;
    if (images === undefined) images = k?.images ?? t?.images ?? (isClaude(m.id) || undefined);
    const ctx = Number(m.context_length);
    out.push(
      hostModel({
        id: m.id,
        name: m.name && m.name !== m.id ? m.name : m.display_name || k?.name || t?.name || m.id,
        context: Number.isFinite(ctx) && ctx > 0 ? ctx : (k?.context ?? t?.context ?? 0),
        images,
        efforts: t?.efforts,
        protocol: protocolOf(m.id, m.supported_endpoints),
      }),
    );
  }
  if (!out.length) throw new Error('models: an empty list');
  return out;
}

/** The plan's list: the Provider API's less what the plan refuses (an account with credits beyond its plan's is let every model); the built-in list, cut the same way, when it can't be had. */
export async function modelsFor(key, plan, extra) {
  const keep = (m) => extra || !refuses(plan, m.id);
  try {
    const out = (await liveModels(key)).filter(keep);
    if (out.length) return out;
  } catch {
    // the built-in list stands in
  }
  return builtinModels().filter(keep);
}

// models that draw, or are not for text (embeddings, speech), are left out, as catalog.Chat leaves them
const drawsID = (id) => ['image', 'imagen', 'imagine', 'dall-e', 'flux', 'seedream', 'cogview', 'stable-diffusion', 'sdxl', 'wanx', 'kolors', 'hidream'].some((w) => id.toLowerCase().includes(w));
const textID = (id) =>
  !['embed', '-tts', 'image', 'audio', '-live', 'robotics', 'computer-use', 'deep-research', 'transcribe', 'realtime', 'moderation', 'whisper', 'dall-e', 'sora'].some((w) => id.includes(w));

/** What the CLI's table has of a model the Go list names (also by its id without the vendor, as v1 looked it up). */
const tableEntry = (id) => {
  const known = byId(TABLE);
  const i = id.lastIndexOf('/');
  return known[id] ?? (i >= 0 ? known[id.slice(i + 1)] : undefined);
};

/** The Go plan's models in the built-in's shape: all on chat completions (the plugin sends them on to /alpha/generate). */
const goRecord = (m) => hostModel({ ...m, protocol: 'chat' });

/** The Go plan's list: the Provider API's list, which answers without a key (Go's key has no Provider API), less what Go is refused (all of it for an account with credits beyond its plan's); the CLI's table fills in levels, pictures and windows. */
export async function liveGoModels(open = false) {
  const res = await http.fetch(BASE + '/models', { headers: { Accept: 'application/json' }, timeoutMs: 8000 });
  if (!res.ok) throw new Error(`models: ${res.status}`);
  const body = await res.json();
  let rows = Array.isArray(body?.data) ? body.data : [];
  if (!rows.length) rows = Array.isArray(body?.models) ? body.models : [];
  const listed = [];
  for (const r of rows) {
    const id = (typeof r?.id === 'string' && r.id) || (typeof r?.name === 'string' && r.name) || '';
    if (!id || drawsID(id) || !textID(id)) continue;
    const input = Array.isArray(r.modalities?.input) ? r.modalities.input.includes('image') : undefined;
    const ctx = typeof r.context_length === 'number' && r.context_length > 0 ? Math.trunc(r.context_length) : 0;
    let m = { id, name: (typeof r.display_name === 'string' && r.display_name) || id, context: ctx, images: input };
    const k = tableEntry(id);
    if (k) m = { ...m, name: m.name === id ? k.name : m.name, efforts: k.efforts, images: input === undefined ? k.images : input, context: m.context || k.context };
    listed.push(m);
  }
  if (!listed.length) throw new Error('no models listed');
  const out = open ? listed : listed.filter((m) => !refuses('Go', m.id));
  if (!out.length) throw new Error('Command Code listed no models for the Go plan');
  return out.map(goRecord);
}

/** The Go plan's list, the CLI's table (cut for Go) standing in when it can't be had. */
export async function goModels(open = false) {
  try {
    return await liveGoModels(open);
  } catch {
    return TABLE.filter((m) => open || !refuses('Go', m.id)).map(goRecord);
  }
}
