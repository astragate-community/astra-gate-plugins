// An account as /client/users/me describes it, and as the sign-in is kept in the account's secret.
import { safeParse } from './json.js';

/** Who names the account: its GitHub login, its username, its name, its id. */
export function who(me) {
  for (const s of [me.user?.github_login, me.user?.username, me.user?.name]) if (typeof s === 'string' && s.trim()) return s.trim();
  if (me.user?.legacy_user_id) return String(me.user.legacy_user_id);
  return 'Zed account';
}

/** The organization the account's models are asked under: its default one when it is among its organizations, else its first, as Zed picks it. */
export function orgOf(me) {
  const orgs = me.organizations ?? [];
  const def = orgs.find((o) => o.id === me.default_organization_id);
  if (def) return def.id;
  if (orgs.length) return orgs[0].id;
  return me.default_organization_id ?? '';
}

export const planOf = (me, org) => me.plans_by_organization?.[org] || me.plan?.plan_v3 || '';

export function modelsOff(me, org) {
  const c = me.configuration_by_organization?.[org];
  return !!c && c.is_zed_model_provider_enabled === false;
}

/** A plan's id as a reader would name it. */
export function planName(id) {
  const names = { zed_pro: 'Pro', zed_pro_trial: 'Pro Trial', zed_business: 'Business', zed_student: 'Student', zed_vip: 'VIP', zed_free: 'Free', '': 'Free' };
  return names[id ?? ''] ?? String(id).replace(/^zed_/, '');
}

/** What the account's secret holds: the user id and access token (the pair), the machine id, the organization, the plan. Null when it isn't one. */
export function stateOf(secret) {
  const s = safeParse(secret ?? '');
  if (!s?.access || !s?.userId) return null;
  return { access: String(s.access), userId: String(s.userId), systemId: s.systemId ?? '', org: s.org ?? '', plan: s.plan ?? '', who: s.who ?? '' };
}
