// Command Code's endpoints. The Provider API serves chat completions, Responses and Anthropic's Messages with the key
// in Authorization and x-api-key.
export const ID = 'commandcode-plan';
export const API = 'https://api.commandcode.ai';
export const GO_ID = 'commandcode-go';
export const BASE = API + '/provider/v1';
export const PATHS = { chat: '/chat/completions', responses: '/responses', anthropic: '/messages' };

// The Go plan's only endpoint, and the CLI release it speaks as (its request carries the CLI's own headers)
export const GENERATE = API + '/alpha/generate';
export const CLI_VERSION = '1.72.2';
export const MAX_TOKENS = 64000; // the CLI's max_tokens when none is asked
