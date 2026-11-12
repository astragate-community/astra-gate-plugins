// MiniMax Code: the sign-in's constants, timings, the two sites and the chat endpoint.

export const CLIENT_ID = 'mcode-public';
export const SCOPE = 'agent.default';
export const AUDIENCE = 'agent-backend';
export const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';
export const EARLY_MS = 2 * 60 * 1000; // a token this close to its end is refreshed before a request
export const SIGN_IN_MS = 10 * 60 * 1000; // when the device code gives no end of its own
export const KEEP_RENEWED_MS = 60 * 1000; // how long a saved refresh's result answers for the old token
export const SIGN_SECRET = 'I*7Cf%WZ#S&%1RlZJ&C2'; // MiniMax Code's request signing (x-signature)
// the key MiniMax Code's Anthropic SDK is given: a placeholder, the account going in Authorization
export const PLACEHOLDER_KEY = 'sk-xxx';

// Each site's hosts, as MiniMax Code's prod build has them.
export const SITES = {
  'minimax-code': {
    id: 'minimax-code',
    name: 'MiniMax Code',
    region: 'cn',
    lang: 'zh',
    account: 'https://account.minimax.cn', // OAuth
    llm: 'https://agent.minimax.cn', // chats and the model list
    agent: 'https://agent.minimaxi.com', // the account and its membership
    platform: 'https://www.minimaxi.com', // the M Plan's windows
  },
  'minimax-code-global': {
    id: 'minimax-code-global',
    name: 'MiniMax Code (Global)',
    region: 'en',
    lang: 'en',
    account: 'https://account.minimax.io',
    llm: 'https://agent.minimax.io',
    agent: 'https://agent.minimax.io',
    platform: 'https://platform.minimax.io',
  },
};

/** The site's Anthropic-messages base URL. */
export const chatBase = (site) => site.llm + '/mavis/api/v1/llm/v1';

/** The site a provider id (or the host's row id that ends with it) names; the China site when it names none. */
export function siteOf(provider) {
  const id = String(provider ?? '');
  return Object.values(SITES).find((s) => id === s.id || id.endsWith('-' + s.id)) ?? SITES['minimax-code'];
}
