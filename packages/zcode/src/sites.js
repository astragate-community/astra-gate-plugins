// The two sites a ZCode account signs in to, and where their APIs are.
import { BIGMODEL_API, BIGMODEL_BASE, ZAI_API, ZAI_BASE } from './constants.js';

export const SITES = {
  zai: { name: 'Z.ai', api: ZAI_API, base: ZAI_BASE, subscribe: 'z.ai/subscribe' },
  bigmodel: { name: 'BigModel', api: BIGMODEL_API, base: BIGMODEL_BASE, subscribe: 'bigmodel.cn/glm-coding' },
};
export const siteOf = (s) => (s === 'bigmodel' ? 'bigmodel' : 'zai');

/** Whether a plan's base URL is BigModel's. */
export const isBigModel = (base) => base.includes('bigmodel.cn');

const hostOf = (url) => /^https?:\/\/([^/?#]+)/i.exec(url)?.[1]?.toLowerCase() ?? '';

/** The scheme and host of a base URL (Z.ai's API when it doesn't parse). */
export const rootOf = (base) => {
  const m = /^(https?:\/\/[^/?#]+)/i.exec(base);
  return m ? m[1] : ZAI_API;
};

/** bizRoot is the business API of the site a plan is served from. */
export const bizRoot = (base) => (hostOf(base).endsWith('bigmodel.cn') ? BIGMODEL_API : rootOf(base));
