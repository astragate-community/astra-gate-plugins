// The live model list: Zen's /models, OpenCode's catalog (metadata) and Zen's docs (protocols), merged over what was
// last known. What was last known is kept in `storage` (module variables are only a cache, 01 §3).
import { http, storage } from 'astra';
import { BASE, CATALOG, DISCOVERY_TIMEOUT_MS, DOCS, PUBLIC_KEY } from './constants.js';
import { bootstrapProvider, buildModels, parseProtocolDocs } from './models.js';

const read = (url, json, headers) =>
  http.fetch(url, { headers, timeoutMs: DISCOVERY_TIMEOUT_MS }).then((res) => {
    if (!res.ok) throw new Error(`Model discovery returned HTTP ${res.status}`);
    return json ? res.json() : res.text();
  });

/** The free models Zen serves now. Falls back to the last good list (then the bootstrap) when Zen's listing fails. */
export async function discover() {
  const headers = { authorization: `Bearer ${PUBLIC_KEY}`, 'x-opencode-client': 'cli' };
  const [listing, catalog, docs] = await Promise.allSettled([read(`${BASE}/models`, true, headers), read(CATALOG, true), read(DOCS, false)]);
  const last = (await storage.get('models')) ?? buildModels(Object.keys(bootstrapProvider.models), bootstrapProvider, {});
  if (listing.status !== 'fulfilled' || !Array.isArray(listing.value?.data)) return last;
  const metadata = catalog.status === 'fulfilled' && catalog.value?.opencode?.models ? catalog.value.opencode : bootstrapProvider;
  const protocols = docs.status === 'fulfilled' ? parseProtocolDocs(docs.value) : {};
  const ids = listing.value.data.map((item) => item.id);
  const found = buildModels(ids, metadata, protocols);
  if (catalog.status !== 'fulfilled' || !Object.keys(protocols).length) {
    // metadata is partial: keep a previously verified model while Zen still lists it
    for (const model of last) if (ids.includes(model.id) && !found.some((m) => m.id === model.id)) found.push(model);
  }
  await storage.set('models', found);
  return found;
}
