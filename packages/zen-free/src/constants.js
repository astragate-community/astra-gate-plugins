// OpenCode Zen free: the provider id, its endpoints and the wire protocols it speaks.
export const PROVIDER = 'opencode-zen-free';
export const BASE = 'https://opencode.ai/zen/v1';
export const CATALOG = 'https://models.opencode.ai/api.json';
export const DOCS = 'https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/web/src/content/docs/zen.mdx';
// Zen's endpoint for each protocol the host can ask for (the host's `protocol` -> path under BASE)
export const PATHS = { chat: '/chat/completions', responses: '/responses', anthropic: '/messages' };
export const PUBLIC_KEY = 'public';
export const CORE_TOOLS = ['bash', 'edit', 'glob', 'grep', 'read'];
export const OPENCODE_VERSION = '1.18.34';
export const DISCOVERY_TIMEOUT_MS = 15000;
