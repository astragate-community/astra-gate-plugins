// Shaping a model request for the Token Plan's endpoint.
import { AUTO_MODELS, TP_MODELS } from './constants.js';

const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

/** The model a request names, as the Token Plan calls it: mimo-auto is mimo-pro, and the app's names become the plan's. */
export function planModel(model) {
  const asked = Object.prototype.hasOwnProperty.call(AUTO_MODELS, model) ? AUTO_MODELS[model] : model;
  return Object.prototype.hasOwnProperty.call(TP_MODELS, asked) ? TP_MODELS[asked] : asked;
}

/** The body with its model renamed; a body that names no model (or isn't an object) is as it came. The caller's is left alone. */
export function renamedBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || typeof body.model !== 'string') return body;
  const model = planModel(body.model);
  return model === body.model ? body : { ...body, model };
}

/** Where a request goes: the plan's base and the path under it (the gateway's /v1 prefix is the base's own). */
export function planUrl(base, path) {
  return base.replace(/\/+$/, '') + String(path ?? '/chat/completions').split('?')[0].replace(/^\/v1(?=\/|$)/, '');
}

/**
 * A Xiaomi account's body: mimo-auto, the app's default, is asked as the model it stands for (and, for the Token Plan
 * (`names` = TP_MODELS), the plan's name for it). The caller's body is left alone.
 */
export function withAutoModel(body, names) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || typeof body.model !== 'string') return body;
  let model = has(AUTO_MODELS, body.model) ? AUTO_MODELS[body.model] : body.model;
  if (names && has(names, model)) model = names[model];
  return model === body.model ? body : { ...body, model };
}

/** The path under the app's /route (the gateway's /v1 prefix is the route's own). */
export const appPath = (path) => String(path ?? '/chat/completions').split('?')[0].replace(/^\/v1(?=\/|$)/, '');

/** What the app's /route path is at the Token Plan's endpoint (the same chat path). */
export const planPath = appPath;
