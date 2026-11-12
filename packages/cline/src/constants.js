// Cline's endpoints, the identity every request claims, and the timings the sign-in keeps to.
export const PROVIDER = 'cline';
export const API = 'https://api.cline.bot/api/v1';

// the WorkOS client Cline's own apps sign in with (their source, production)
export const WORKOS_CLIENT = 'client_01K3A541FN8TA3EPPHTD2325AR';
export const WORKOS_DEVICE = 'https://api.workos.com/user_management/authorize/device';
export const WORKOS_TOKEN = 'https://api.workos.com/user_management/authenticate';
export const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';

// a signed-in account's token rides as "workos:<jwt>" (Cline's own clients send it so)
export const WORKOS_PREFIX = 'workos:';

export const REFRESH_LEAD = 5 * 60 * 1000; // a token this close to its end is refreshed before a request
// a refresh that failed transiently keeps a token with this much left (Cline's DEFAULT_RETRYABLE_TOKEN_GRACE_MS);
// only once it has actually expired is the sign-in the one to blame
export const RETRYABLE_GRACE = 30 * 1000;
export const DEVICE_CAP = 600; // seconds the browser may take, however long the code lives

// Who every request says it comes from: the same client surface Cline's own CLI runs as. Move these along when Cline ships.
export const CLIENT = { type: 'cline-cli', version: '3.0.68', platform: 'cli', core: '0.0.90' };
