// Qoder: the COSY envelope that signs a call to the model API, as Qoder's desktop client does.
import { crypto, encoding, env } from 'astra';
import { COSY_VERSION, RSA_KEY } from './constants.js';
import { hexID } from './util.js';

// machineOS names the machine as Qoder's desktop clients do ("<arch>_<platform>"). The sandbox knows the platform but not the
// architecture, so x86_64 is named for every machine.
export function machineOS() {
  const platform = { macos: 'darwin', windows: 'win32', linux: 'linux' }[env.platform] ?? env.platform;
  return 'x86_64_' + platform;
}

// userBlob is the account as the envelope carries it: AES-128-CBC under a fresh key that is its own IV, the key wrapped with
// Qoder's RSA key.
export function userBlob(u) {
  const raw = JSON.stringify({ uid: u.uid, aid: '', name: u.name ?? '', email: u.email ?? '', security_oauth_token: u.access });
  const key = hexID().slice(0, 16);
  const info = crypto.aes.encrypt({ mode: 'cbc', key, iv: key, data: raw });
  const wrapped = crypto.rsa.encrypt({ key: RSA_KEY, data: key, padding: 'pkcs1' });
  return { info, key: wrapped };
}

// cosyHeaders signs a call to url whose body, as sent, is body.
export function cosyHeaders(url, u, body, ts = Math.floor(Date.now() / 1000)) {
  if (!u?.machineId) throw new Error('Qoder: the account has no machine id; sign in again');
  const blob = userBlob(u);
  const payload = encoding.base64.encode(JSON.stringify({ version: 'v1', requestId: hexID(), info: blob.info, cosyVersion: COSY_VERSION, ideVersion: '' }));
  let path = new URL(url).pathname;
  if (path.startsWith('/algo')) path = path.slice(5);
  const sig = crypto.digest('md5', `${payload}\n${blob.key}\n${ts}\n${body}\n${path}`);
  const m = u.machineId;
  return {
    Accept: 'application/json',
    'Accept-Encoding': 'identity',
    'Content-Type': 'application/json',
    Authorization: `Bearer COSY.${payload}.${sig}`,
    'Cosy-Business-Product': 'app',
    'Cosy-Business-Type': 'agent',
    'Cosy-ClientIp': m,
    'Cosy-ClientType': '10',
    'Cosy-Data-Policy': 'disagree',
    'Cosy-Date': String(ts),
    'Cosy-Key': blob.key,
    'Cosy-MachineId': m,
    'Cosy-MachineToken': m,
    'Cosy-MachineType': '5',
    'Cosy-MachineOS': machineOS(),
    'Cosy-Scene': 'app',
    'Cosy-User': u.uid,
    'Cosy-Version': COSY_VERSION,
    'Login-Version': 'v2',
  };
}
