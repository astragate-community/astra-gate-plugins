// Reads of Command Code's account API.
import { http } from 'astra';
import { API } from './constants.js';

/** GET an account endpoint as JSON with the key; a failure carries `status`. */
export async function accountJSON(path, key, timeoutMs = 15000) {
  const res = await http.fetch(API + path, { headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' }, timeoutMs });
  if (!res.ok) throw Object.assign(new Error(`${path}: ${res.status}`), { status: res.status });
  return res.json();
}

const STATUS = {
  400: 'Bad Request',
  401: 'Unauthorized',
  402: 'Payment Required',
  403: 'Forbidden',
  404: 'Not Found',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
  504: 'Gateway Timeout',
};
/** A status as words; one with none is "HTTP <n>". */
export const statusText = (status) => STATUS[status] ?? `HTTP ${status}`;
