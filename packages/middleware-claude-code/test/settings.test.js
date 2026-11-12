import { describe, expect, it } from 'vitest';
import { storage, commands } from 'astra';
import { mount, runCommand } from '@astragate/plugin-sdk/testing';
import plugin, { settings } from '../src/main.js';
import { normalize } from '../src/settings.js';

describe('settings view', () => {
  it('shows the stored settings', async () => {
    const v = await mount(settings, { storage: { settings: { providers: ['prov_1'], protocol: 'chat', version: '2.2.0', betas: 'x' } } });
    expect(v.find('TagInput').props.value).toEqual(['prov_1']);
    expect(v.find('Select').props.value).toBe('chat');
    expect(v.findAll('TextField').map((n) => n.props.value)).toEqual(['2.2.0', 'x']);
  });

  it('saves each control as it changes', async () => {
    const v = await mount(settings);
    expect(v.find('Select').props.value).toBe('anthropic');
    await v.change('providers', ['Relay', ' ']);
    await v.change('protocol', 'any');
    await v.change('version', '2.2.0');
    await v.change('betas', 'claude-code-20250219');
    expect(await v.storage.get('settings')).toEqual({ providers: ['Relay'], protocol: 'any', version: '2.2.0', betas: 'claude-code-20250219' });
  });
});

describe('normalize', () => {
  it('falls back to the defaults for anything mistyped', () => {
    expect(normalize(undefined)).toEqual({ providers: [], protocol: 'anthropic', version: '', betas: '' });
    expect(normalize({ providers: 'x', protocol: 'gemini', version: 1, betas: null })).toEqual({ providers: [], protocol: 'anthropic', version: '', betas: '' });
  });
});

describe('upgrade from v1', () => {
  // the SDK harness has no way to pass ctx.upgrade, so the test wraps activate to add it
  const upgraded = (options, storageSeed) => {
    const wrapped = {
      ...plugin,
      activate: async (ctx) => {
        await plugin.activate({ ...ctx, reason: 'upgrade', upgrade: { from: { apiVersion: 1, package: '@astragate-community/middleware-claude-code', spec: 'x', options } } });
        ctx.subscriptions.push(commands.register('dump', async () => storage.get('settings')));
      },
    };
    return runCommand(wrapped, 'dump', {}, { storage: storageSeed });
  };
  it('turns the v1 options into settings', async () => {
    expect(await upgraded({ providers: ['prov_1'], protocol: 'any', version: '2.1.281', betas: 'b' })).toEqual({ providers: ['prov_1'], protocol: 'any', version: '2.1.281', betas: 'b' });
  });
  it('keeps settings that already exist', async () => {
    const seed = { settings: { providers: ['mine'], protocol: 'anthropic', version: '', betas: '' } };
    expect(await upgraded({ providers: ['theirs'] }, seed)).toEqual(seed.settings);
  });
});
