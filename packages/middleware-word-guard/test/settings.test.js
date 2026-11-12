import { describe, expect, it } from 'vitest';
import { storage, commands } from 'astra';
import { mount, runCommand } from '@astragate/plugin-sdk/testing';
import plugin, { settings } from '../src/main.js';
import { normalize } from '../src/settings.js';

const DEFAULT = { words: [], patterns: [], action: 'reject', check: 'last', mask: '***', replies: false, message: '' };

describe('settings view', () => {
  it('shows the stored settings', async () => {
    const v = await mount(settings, { storage: { settings: { ...DEFAULT, words: ['a'], patterns: ['\\d+'], action: 'mask', replies: true } } });
    expect(v.findAll('TagInput').map((n) => n.props.value)).toEqual([['a'], ['\\d+']]);
    expect(v.find('Switch').props.checked).toBe(true);
  });

  it('saves each control as it changes', async () => {
    const v = await mount(settings);
    await v.change('words', ['codename', ' ']);
    await v.change('patterns', ['\\b\\d{3}-\\d{4}\\b']);
    await v.change('action', 'mask');
    await v.change('check', 'all');
    await v.change('mask', '[x]');
    await v.change('message', 'no');
    await v.change('replies', true);
    expect(await v.storage.get('settings')).toEqual({ words: ['codename'], patterns: ['\\b\\d{3}-\\d{4}\\b'], action: 'mask', check: 'all', mask: '[x]', replies: true, message: 'no' });
  });

  it('refuses a pattern that is not a regular expression, and says so', async () => {
    const v = await mount(settings, { storage: { settings: { ...DEFAULT, patterns: ['a'] } } });
    await v.change('patterns', ['a', '(']);
    expect(await v.storage.get('settings')).toEqual({ ...DEFAULT, patterns: ['a'] });
    expect(v.findAll('Field').map((f) => f.props.error).find(Boolean)).toMatch(/patterns\.error|not a valid regular expression/);
  });
});

describe('normalize', () => {
  it('falls back to the defaults for anything mistyped', () => {
    expect(normalize(undefined)).toEqual(DEFAULT);
    expect(normalize({ words: 'x', patterns: [1, ''], action: 'delete', check: 'first', mask: 5, replies: 'yes', message: null })).toEqual(DEFAULT);
  });
});

describe('upgrade from v1', () => {
  // the SDK harness has no way to pass ctx.upgrade, so the test wraps activate to add it
  const upgraded = (options, storageSeed) => {
    const wrapped = {
      ...plugin,
      activate: async (ctx) => {
        await plugin.activate({ ...ctx, reason: 'upgrade', upgrade: { from: { apiVersion: 1, package: '@astragate-community/middleware-word-guard', spec: 'x', options } } });
        ctx.subscriptions.push(commands.register('dump', async () => storage.get('settings')));
      },
    };
    return runCommand(wrapped, 'dump', {}, { storage: storageSeed });
  };
  it('turns the v1 options into settings', async () => {
    const options = { words: ['project-codename'], patterns: ['\\d+'], action: 'mask', check: 'all', mask: '#', replies: true, message: 'm' };
    expect(await upgraded(options)).toEqual(options);
  });
  it('keeps settings that already exist', async () => {
    const seed = { settings: { ...DEFAULT, words: ['mine'] } };
    expect(await upgraded({ words: ['theirs'] }, seed)).toEqual(seed.settings);
  });
});
