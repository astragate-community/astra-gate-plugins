// Which of Zen's models are free and usable, as the model records the host takes from `models()`.
import { PATHS } from './constants.js';

// Zen's docs table lists each model with the endpoint it answers on; that is the only place the protocol is stated.
const DOC_PROTOCOL = { 'chat/completions': 'chat', responses: 'responses', messages: 'anthropic', systemone: 'systemone' };

export function parseProtocolDocs(text) {
  const protocols = {};
  const pattern = /\|[^|]+\|\s*`?([^|`\s]+)`?\s*\|\s*`[^`]+\/v1\/(chat\/completions|responses|messages|systemone)`/g;
  for (const match of text.matchAll(pattern)) protocols[match[1]] = DOC_PROTOCOL[match[2]];
  return protocols;
}

// the catalog names the AI SDK package per model; map it back to a wire protocol
function sdkProtocol(npm) {
  if (npm?.includes('anthropic')) return 'anthropic';
  if (npm === '@ai-sdk/openai') return 'responses';
  if (npm?.includes('openai-compatible')) return 'chat';
  return undefined;
}

function isRetired(model) {
  return (
    model.deprecated === true ||
    ['deprecated', 'retired', 'disabled'].includes(model.status ?? model.lifecycle) ||
    model.deprecated_at != null ||
    model.retirement_date != null
  );
}

export function isFree(id, model = {}) {
  return !isRetired(model) && (/free/i.test(id) || (model.cost?.input === 0 && model.cost?.output === 0));
}

/** The host's model list from Zen's ids, OpenCode's catalog entry (`provider`) and the docs' protocols. */
export function buildModels(ids, provider, protocols) {
  const result = [];
  for (const id of ids) {
    if (typeof id !== 'string' || !id || id === '__proto__') continue;
    const raw = provider.models?.[id];
    const model = raw ?? {};
    const protocol = protocols[id] ?? (raw && sdkProtocol(model.provider?.npm ?? provider.npm));
    if (!isFree(id, model) || !Object.hasOwn(PATHS, protocol)) continue;
    const input = model.modalities?.input ?? ['text'];
    result.push({
      id,
      name: model.name ?? id,
      protocol,
      context: model.limit?.context ?? 32768,
      output: model.limit?.output ?? 4096,
      vision: input.includes('image'),
      reasoning: model.reasoning ?? false,
    });
  }
  return result;
}

// Offline bootstrap metadata from the OpenCode catalog, 2026-10-06 (same three models as the manifest's list).
export const bootstrapProvider = {
  npm: '@ai-sdk/openai-compatible',
  models: {
    'big-pickle': { name: 'Big Pickle', cost: { input: 0, output: 0 }, limit: { context: 200000, output: 32000 }, reasoning: true },
    'space-bunny-free': { name: 'Space Bunny Free', cost: { input: 0, output: 0 }, limit: { context: 1048576, output: 524288 }, reasoning: true },
    'muse-spark-1.3-contributor-free': {
      name: 'Muse Spark 1.3 Free',
      cost: { input: 0, output: 0 },
      provider: { npm: '@ai-sdk/openai' },
      limit: { context: 1048576, output: 131072 },
      reasoning: true,
      modalities: { input: ['text', 'image', 'video', 'pdf', 'audio'], output: ['text'] },
    },
  },
};
