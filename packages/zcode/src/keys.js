// An account's API keys in a project: finding them, making them, and a team seat's key when the sign-in kept none.
import { call } from './api.js';
import { SITES, isBigModel } from './sites.js';
import { first } from './util.js';

export function teamHeaders(base, org, project) {
  return {
    'bigmodel-organization': org,
    'bigmodel-project': project,
    'set-language': isBigModel(base) ? 'zh' : 'en',
    'accept-language': 'en-US,en',
  };
}

export const keysURL = (root, org, project) => `${root}/api/biz/v1/organization/${encodeURIComponent(org)}/projects/${encodeURIComponent(project)}/api_keys`;

// projectKey finds the project's key named want.name (of want.keyType, when given), makes it when it isn't there and
// reads its secret: `<id>.<secret>`.
export async function projectKey(site, keys, auth, headers, want) {
  const name = SITES[site].name;
  let list;
  try {
    list = (await call('GET', keys, { auth, headers })) ?? [];
  } catch (e) {
    throw new Error(`${name} API keys: ${e.message}`);
  }
  const typed = 'keyType' in want;
  let id = '';
  for (const k of Array.isArray(list) ? list : []) {
    if (k.name === want.name && (!typed || String(k.keyType) === String(want.keyType)) && first(k.apiKey)) id = first(k.apiKey);
  }
  if (!id) {
    try {
      id = first((await call('POST', keys, { auth, headers, body: want }))?.apiKey);
    } catch (e) {
      throw new Error(`${name} API key: ${e.message}`);
    }
  }
  let secret = '';
  if (id) {
    try {
      secret = first((await call('GET', `${keys}/copy/${encodeURIComponent(id)}`, { auth, headers }))?.secretKey);
    } catch (e) {
      throw new Error(`${name} API key: ${e.message}`);
    }
  }
  if (id && !secret && typed) return id; // a team's key with no secret goes as it is
  if (!id || !secret) throw new Error(`${name} gave no API key`);
  return `${id}.${secret}`;
}

// a failed team-key mint is remembered for a minute (a cache: a restart forgets it)
const failed = new Map();

/** A team seat's key when the sign-in kept none: made from the seat's token. */
export async function teamKey(s) {
  if (s.key) return s.key;
  const id = [s.token, s.org, s.project].join('\0');
  const got = failed.get(id);
  if (got && Date.now() - got.at < 60_000) throw got.err;
  const site = isBigModel(s.base) ? 'bigmodel' : 'zai';
  try {
    return await projectKey(site, keysURL(SITES[site].api, s.org, s.project), s.token, teamHeaders(s.base, s.org, s.project), { name: 'zcode-team-api-key', keyType: 2 });
  } catch (e) {
    const err = new Error(`ZCode's team plan: ${e.message} — sign in to ZCode again`);
    failed.set(id, { err, at: Date.now() });
    throw err;
  }
}
