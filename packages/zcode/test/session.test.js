import { describe, expect, it } from 'vitest';
import { giftID, giftModel, giftServes, giftSpent, giftUsable, bucketModels } from '../src/gift.js';
import { jwtExpired, jwtExpiry, stateOf } from '../src/session.js';
import { modelsOf, planID } from '../src/models.js';
import { authorizeUrl, pollToken } from '../src/signin.js';
import { bestBuckets, savedCard } from '../src/usage.js';
import { bizRoot, rootOf } from '../src/sites.js';
import { b64urlBytes, b64urlText, first, num, startNum, who } from '../src/util.js';
import { rebase } from '../src/request.js';
import { jwtExpiring } from './support.js';

describe('values', () => {
  it("a session token's expiry is its exp claim", () => {
    expect(jwtExpired(jwtExpiring(3600))).toBe(false);
    expect(jwtExpired(jwtExpiring(-5))).toBe(true);
    expect(jwtExpiry('nonsense')).toBe(0);
    expect(jwtExpired('nonsense')).toBe(false);
  });

  it('base64url both ways, UTF-8 included', () => {
    expect(b64urlText(Buffer.from('智谱 ok').toString('base64url'))).toBe('智谱 ok');
    expect(b64urlText('***')).toBe(null);
    expect(b64urlBytes(new Uint8Array([251, 255, 254, 1]))).toBe(Buffer.from([251, 255, 254, 1]).toString('base64url'));
  });

  it('stateOf reads a secret and fills the site, base and device', () => {
    const s = stateOf(JSON.stringify({ site: 'bigmodel', key: ' k.s ', plan: 'Pro' }));
    expect([s.site, s.base, s.key, s.plan]).toEqual(['bigmodel', 'https://open.bigmodel.cn/api/anthropic', 'k.s', 'Pro']);
    expect(s.device).toBeTruthy();
    expect(stateOf(JSON.stringify({ site: 'other' })).site).toBe('zai');
    expect(stateOf('not json')).toBe(null);
  });

  it('small readers', () => {
    expect(first(null, '  ', ' a ')).toBe('a');
    expect(num('12x')).toBe(12);
    expect(startNum('12x')).toBeUndefined();
    expect(startNum(' 7 ')).toBe(7);
    expect(who({ email: 'a@b.c' })).toBe('a@b.c');
    expect(who({ email: '13800@phone.local', name: 'N' })).toBe('13800');
    expect(who({ name: 'N' })).toBe('N');
    expect(who(null)).toBe('ZCode');
    expect(rootOf('https://open.bigmodel.cn/api/anthropic')).toBe('https://open.bigmodel.cn');
    expect(bizRoot('https://open.bigmodel.cn/api/anthropic')).toBe('https://bigmodel.cn');
    expect(bizRoot('https://api.z.ai/api/anthropic')).toBe('https://api.z.ai');
  });

  it("rebase moves a request path between plans' bases", () => {
    expect(rebase('/v1/messages', 'https://b')).toBe('https://b/v1/messages');
    expect(rebase('https://api.z.ai/api/anthropic/v1/messages', 'https://b')).toBe('https://b/v1/messages');
  });
});

describe('gift', () => {
  it('giftID is the catalog spelling plus -Trial, and giftModel finds the raw name again', () => {
    expect(giftID('glm-5.3-flash')).toBe('GLM-5.3-Flash-Trial');
    expect(giftID('other')).toBe('other-Trial');
    expect(giftModel({ models: ['glm-5.3-flash'] }, 'glm-5.3-flash-trial')).toBe('glm-5.3-flash');
    expect(giftModel(null, 'x-trial')).toBeUndefined();
  });

  it('giftSpent: remaining says it, else used against total', () => {
    expect(giftSpent({ remaining_units: 0 })).toBe(true);
    expect(giftSpent({ remaining_units: '3' })).toBe(false);
    expect(giftSpent({ total_units: 10, used_units: 10 })).toBe(true);
    expect(giftSpent({})).toBe(false);
  });

  it('bucketModels reads model: capabilities and bare ones', () => {
    expect(bucketModels({ capabilities: ['model:a', 'b', 'tool:x', ' '] })).toEqual(['a', 'b']);
  });

  it('giftUsable: served and not expired', () => {
    const gift = { models: ['glm-5.3-flash'] };
    expect(giftServes(gift, 'GLM-5.3-Flash')).toBe(true);
    expect(giftUsable({ jwt: jwtExpiring(3600) }, gift, 'GLM-5.3-Flash')).toBe(true);
    expect(giftUsable({ jwt: jwtExpiring(-5) }, gift, 'GLM-5.3-Flash')).toBe(false);
    expect(giftUsable({ jwt: jwtExpiring(3600) }, gift, 'other')).toBe(false);
  });

  it('bestBuckets prefers a live bucket, then the least used', () => {
    const best = bestBuckets([
      { models: ['m'], used: 10, _spent: false },
      { models: ['m'], used: 5, _spent: false },
      { models: ['n'], used: 100, _spent: true },
      { models: ['n'], used: 100, _spent: false },
    ]);
    expect(best.get('m')).toBe(1);
    expect(best.get('n')).toBe(3);
  });

  it('savedCard keeps the saved plan and puts the MCP window last', () => {
    const card = savedCard({ windows: [{ name: 'MCP · Month' }, { name: 'Weekly' }] }, 'Pro');
    expect(card.plan).toBe('Pro');
    expect(card.windows.map((w) => w.name)).toEqual(['Weekly', 'MCP · Month']);
    expect(savedCard({ plan: 'Lite' }, 'Pro').plan).toBe('Lite');
  });
});

describe('config', () => {
  it("modelsOf reads a plan's models, switched-off ones out, limits from the matching rules", () => {
    const cfg = {
      config: {
        providerConfigRules: { providerRules: [{ providerId: 'account:zai-individual-coding-plan', builtinModelIds: ['GLM-5.2', 'GLM-5.3'] }] },
        modelConfigRules: {
          builtinProviderModelRules: [{ providerId: 'account:zai-individual-coding-plan', modelId: 'GLM-5.3', config: { enabled: false } }],
          modelRules: [{ modelMatch: 'glm-5\\..*', config: { properties: { contextWindow: 1000, inputFormat: { supportsImage: true } }, optionSpecs: { maxOutputTokens: { max: 64 }, reasoningLevel: { values: ['disabled', 'enabled', 'max'] } } } }],
        },
      },
    };
    expect(modelsOf(cfg, planID('https://api.z.ai/api/anthropic'))).toEqual([{ id: 'GLM-5.2', context: 1000, output: 64, image: true, efforts: ['none', 'high', 'max'] }]);
    expect(modelsOf(null, 'x')).toEqual([]);
  });

  it('planID by base', () => {
    expect(planID('https://zcode.z.ai/api/v1/zcode-plan/anthropic')).toBe('account:zai-start-plan');
    expect(planID('https://open.bigmodel.cn/api/anthropic')).toBe('account:bigmodel-individual-coding-plan');
  });
});

describe('sign-in helpers', () => {
  it('the browser comes back through zcode.z.ai, and the poll token is per site', () => {
    const z = authorizeUrl('https://z.ai/auth?x=1', 'zai');
    expect(z).toMatch(/^https:\/\/z\.ai\/auth\?x=1&redirect_uri=/);
    expect(decodeURIComponent(decodeURIComponent(z))).toContain('redirect_uri=https://zcode.z.ai/app/oauth/login?redirect=zcode://oauth/callback&app_version=3.17.2');
    expect(authorizeUrl('https://bigmodel.cn/auth', 'bigmodel')).toMatch(/\?redirect=/);
    expect(pollToken({ bigmodel: { accessToken: ' t ' } }, 'bigmodel')).toBe('t');
    expect(pollToken({ zai: { access_token: 'z' } }, 'zai')).toBe('z');
    expect(pollToken({ zai: { access_token: 'z' } }, 'bigmodel')).toBe('');
  });
});
