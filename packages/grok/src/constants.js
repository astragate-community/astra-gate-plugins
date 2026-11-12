// Grok (SuperGrok / X Premium+) through Grok Build's backend: versions, timings, endpoints.
export const PROVIDER = 'grok';
export const BASE = 'https://cli-chat-proxy.grok.com/v1';
export const ISSUER = 'https://auth.x.ai';
export const CLIENT_VERSION = '1.0.41';
export const CLIENT_ID = 'b1a00492-073a-47ea-816f-4c329264a828';
export const SCOPE = 'openid profile email offline_access';
export const REFRESH_MARGIN = 5 * 60 * 1000; // a token this close to its end is renewed before a request
export const KEEP_RENEWED_MS = 60 * 1000; // how long a saved refresh's result answers for the old token
export const SIGN_IN_MS = 10 * 60 * 1000; // when the device code gives no end of its own
// the endpoints, for when the issuer's discovery document can't be had
export const FALLBACK_ENDPOINTS = { device_authorization_endpoint: ISSUER + '/oauth2/device/code', token_endpoint: ISSUER + '/oauth2/token' };
