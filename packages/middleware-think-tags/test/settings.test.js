import { describe, expect, it } from 'vitest';
import { storage, commands } from 'astra';
import { mount, runCommand } from '@astragate/plugin-sdk/testing';
import plugin, { settings } from '../src/main.js';
import { normalize } from '../src/settings.js';

describe('settings view', () => {
  it('shows the stored mode, strip by default', async () => {
    expect((await mount(settings)).find('RadioCards').props.value).toBe('strip');
    expect((await mount(settings, { storage: { settings: { mode: 'to_content' } } })).find('RadioCards').props.value).toBe('to_content');
  });
  it('saves the mode as it changes', async () => {
    const v = await mount(settings);
    await v.change('mode', 'to_content');
    expect(await v.storage.get('settings')).toEqual({ mode: 'to_content' });
    await v.change('mode', 'strip');
    expect(await v.storage.get('settings')).toEqual({ mode: 'strip' });
  });
});

describe('normalize', () => {
  it('anything but to_content is strip', () => {
    expect(normalize(undefined)).toEqual({ mode: 'strip' });
    expect(normalize({ mode: 'other' })).toEqual({ mode: 'strip' });
    expect(normalize({ mode: 'to_content' })).toEqual({ mode: 'to_content' });
  });
});

describe('upgrade from v1', () => {
  // the SDK harness has no way to pass ctx.upgrade, so the test wraps activate to add it
  const upgraded = (options, storageSeed) => {
    const wrapped = {
      ...plugin,
      activate: async (ctx) => {
        await plugin.activate({ ...ctx, reason: 'upgrade', upgrade: { from: { apiVersion: 1, package: '@astragate-community/middleware-think-tags', spec: 'x', options } } });
        ctx.subscriptions.push(commands.register('dump', async () => storage.get('settings')));
      },
    };
    return runCommand(wrapped, 'dump', {}, { storage: storageSeed });
  };
  it('turns the v1 options into settings', async () => {
    expect(await upgraded({ mode: 'to_content' })).toEqual({ mode: 'to_content' });
    expect(await upgraded(undefined)).toEqual({ mode: 'strip' });
  });
  it('keeps settings that already exist', async () => {
    expect(await upgraded({ mode: 'to_content' }, { settings: { mode: 'strip' } })).toEqual({ mode: 'strip' });
  });
});
