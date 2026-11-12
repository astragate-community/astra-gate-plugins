// Trae: Trae CN's daily check-in (每日签到), asked as the account with the headers Trae CN's IDE (3.3.104) sends a growth
// page: its Cloud-IDE-JWT, its device and a client's User-Agent (a script's User-Agent got 9074 「当前参与用户太多」).
import { http } from 'astra';
import { REQUEST_TIMEOUT } from './api.js';
import { errorOf, lapsedCode } from './errors.js';
import { parseJSON } from './values.js';

const UG = '/trae/api/v2/ug/checkin_credits/';

export const ugUA = (site) =>
  `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) TRAE-SOLO-CN/${site.clientVersion} Chrome/120.0.6099.291 Electron/28.2.10 Safari/537.36`;

export function ugHeaders(a, site) {
  return {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    Authorization: `Cloud-IDE-JWT ${a.token}`,
    'User-Agent': ugUA(site),
    'x-device-id': a.deviceId,
    'x-device-brand': site.brand,
    'x-device-type': 'Windows',
    'x-os-version': '10.0.22631',
    'x-app-version': site.clientVersion,
  };
}

async function ask(site, a, what) {
  const res = await http.fetch(site.hosts.auth + UG + what, { method: 'POST', headers: ugHeaders(a, site), body: JSON.stringify({ req_source: 1 }), timeoutMs: REQUEST_TIMEOUT });
  const text = await res.text();
  const v = parseJSON(text);
  return { status: res.status, v, lapsed: res.status === 401 || lapsedCode(errorOf(v).code, site) };
}

// checkIn asks today's status and claims when it is on and not yet in: { state, credits?, code?, message? }.
// state: "claimed" | "already" | "off" | "expired" | "failed"
export async function checkIn(site, a) {
  const s = await ask(site, a, 'status');
  if (s.lapsed) return { state: 'expired' };
  const d = s.v.data ?? s.v;
  if (s.status !== 200 || (s.v.code && String(s.v.code) !== '0')) return { state: 'failed', code: s.v.code, message: errorOf(s.v).message };
  if (d.enable === false) return { state: 'off' };
  if (d.checked_in) return { state: 'already', credits: d.credits };
  const c = await ask(site, a, 'claim');
  if (c.lapsed) return { state: 'expired' };
  const e = errorOf(c.v);
  // 9095: this device has checked in today. Nothing sends another device id to get round it, nor a 9074.
  if (String(e.code) === '9095') return { state: 'already' };
  if (c.status !== 200 || (e.code && String(e.code) !== '0')) return { state: 'failed', code: e.code, message: e.message };
  return { state: 'claimed', credits: (c.v.data ?? c.v).credits ?? d.credits };
}

