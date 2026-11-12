// Xiaomi MiMo's Token Plan: the provider id, the endpoints per region and the model names the plan uses.

export const PROVIDER = 'mimo-app';

// The Token Plan is spent with its `tp-` API key at token-plan-<region>.xiaomimimo.com (the open platform's Token Plan
// page shows the key and the endpoint). Regions follow the MiMo servers' naming; the manifest's net: permissions name each.
export const REGIONS = {
  cn: 'https://token-plan-cn.xiaomimimo.com/v1',
  sgp: 'https://token-plan-sgp.xiaomimimo.com/v1',
  ru: 'https://token-plan-ru.xiaomimimo.com/v1',
  in: 'https://token-plan-in.xiaomimimo.com/v1',
};
export const DEFAULT_REGION = 'cn';

// mimo-auto, the app's default model, is asked as the model it stands for
export const AUTO_MODELS = { 'mimo-auto': 'mimo-pro' };
// the Token Plan's names for the app's models; any other passes as it is
export const TP_MODELS = { 'mimo-pro': 'mimo-v2.6-pro', 'mimo-flash': 'mimo-v2.6-flash' };

export const KEY_PREFIX = 'tp-';

// ---- the Xiaomi-account sign-in (the app's /route, and the platform's Token Plan pages read with the same account)
export const HOSTS = {
  SGP: 'https://mimo-server-sgp.xiaomimimo.com/api',
  RU: 'https://mimo-server-ru.xiaomimimo.com/api',
  IN: 'https://mimo-server-in.xiaomimimo.com/api',
};
export const REGION = 'SGP';
export const ACCOUNT = 'https://account.xiaomi.com';
// The open platform (platform.xiaomimimo.com) sells the Token Plan, spent with its tp- key at token-plan-<region>, not
// through the app's /route.
export const PLATFORM = 'https://platform.xiaomimimo.com';
export const APP_VERSION = '26.929.292248';
export const SOURCE = 'mimocode-cli-free';
export const UA = 'miNative PC/Normal Windows_NT/10.0.26100 SDKV/1.0.0 DEVT/PC DEVS/Windows APP/miaccount_desktop APPV/0.1.0';
export const RENEW_AFTER = 24 * 60 * 60 * 1000; // the app signs on again after a day
export const SIGN_IN_LIFE = 10 * 60 * 1000; // how long the sign-in page's long poll is kept
export const TP_LIFE = 60 * 60 * 1000; // this long, an account the app refused is asked at its Token Plan
// `prepare` has five seconds in all; every other provider call has thirty
export const PREPARE_BUDGET = 3500;
export const SLOW_BUDGET = 25000;

export const baseOf = (region) => HOSTS[String(region ?? '').trim().toUpperCase()] ?? '';
export const appHeaders = () => ({ 'user-agent': UA, 'x-client-version': APP_VERSION });
