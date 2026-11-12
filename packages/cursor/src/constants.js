// Cursor's endpoints, timings and the names the plugin uses.
export const ID = 'cursor';
export const API = 'https://api2.cursor.sh';
export const WEBSITE = 'https://cursor.com';
export const VERSION_FALLBACK = '2026.09.23-86fc751'; // the CLI version said to the API (v1 preferred an installed cursor-agent's)
export const DEFAULT_CONTEXT = 200_000; // a model Cursor gives no limit for
export const MODELS_KEEP = 10 * 60 * 1000;
// a token with less than this left is exchanged again (an API key's)
export const SOON = 5 * 60 * 1000;
