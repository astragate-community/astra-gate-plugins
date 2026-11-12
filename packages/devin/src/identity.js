// Whose key it is, as Devin says (GetUserStatus).
import { crypto } from 'astra';
import { readUserStatus } from './api.js';

// tierName words a teamsTier as `devin auth status` says it: TEAMS_TIER_DEVIN_PRO is "Devin Pro", TEAMS_TIER_DEVIN_TEAMS_V2
// "Devin Teams" (the CLI leaves the tier's version out).
export const tierName = (t) =>
  String(t ?? '')
    .replace(/^TEAMS_TIER_/, '')
    .split('_')
    .filter((w) => w && w !== 'UNSPECIFIED' && !/^V\d+$/.test(w))
    .map((w) => w[0] + w.slice(1).toLowerCase())
    .join(' ');

/**
 * Whose key it is, as GetUserStatus says, asked with the key itself: { user, plan }; null when Devin refuses the key;
 * undefined when it can't tell (no answer, no name).
 */
export async function whoByKey(key) {
  let status;
  try {
    status = await readUserStatus(key);
  } catch {
    return undefined;
  }
  if (status.refused) return null;
  if (!status.res.ok) return undefined;
  let u;
  try {
    u = JSON.parse(status.text || '{}')?.userStatus ?? {};
  } catch {
    return undefined;
  }
  const user = u.email || u.name;
  if (!user) return undefined;
  const info = u.planStatus?.planInfo ?? {};
  return { user, plan: tierName(u.teamsTier || info.teamsTier) || info.planName || '' };
}

/** The account an accepted key makes: its key, name and plan. A key Devin turns away throws; one it can't name is "Devin". */
export async function accountOf(key) {
  const who = await whoByKey(key);
  if (who === null) throw new Error("Devin didn't take the sign-in: nobody is signed in with that token");
  const name = who?.user || 'Devin';
  return { key: who?.user ? who.user.toLowerCase() : 'devin-' + crypto.sha256(key).slice(0, 12), displayName: name, email: who?.user ?? null, plan: who?.plan || null };
}
