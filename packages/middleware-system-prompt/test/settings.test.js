import { describe, expect, it } from 'vitest';
import { storage, commands } from 'astra';
import { mount, runCommand } from '@astragate/plugin-sdk/testing';
import plugin, { settings } from '../src/main.js';
import { normalize, fromV1Options } from '../src/settings.js';

describe('settings view', () => {
  it('shows the stored settings', async () => {
    const v = await mount(settings, { storage: { settings: { prompt: 'Be brief.', override: true, position: 'prepend', agents: ['codex'], models: ['claude'] } } });
    expect(v.find('TextArea').props.value).toBe('Be brief.');
    expect(v.find('Switch').props.checked).toBe(true);
    expect(v.find('Segmented').props.value).toBe('prepend');
    expect(v.findAll('TagInput').map((n) => n.props.value)).toEqual([['codex'], ['claude']]);
  });

  it('saves each control as it changes', async () => {
    const v = await mount(settings);
    expect(v.find('TextArea').props.value).toBe('');
    await v.change('prompt', 'Reply in French.');
    await v.change('override', true);
    await v.change('position', 'prepend');
    await v.change('agents', ['claude-code', ' ']);
    await v.change('models', ['deepseek']);
    expect(await v.storage.get('settings')).toEqual({ prompt: 'Reply in French.', override: true, position: 'prepend', agents: ['claude-code'], models: ['deepseek'] });
  });
});

describe('normalize', () => {
  it('falls back to the defaults for anything mistyped', () => {
    expect(normalize(undefined)).toEqual({ prompt: '', override: false, position: 'append', agents: [], models: [] });
    expect(normalize({ prompt: 5, override: 'yes', position: 'middle', agents: 'x', models: [1, 'a'] })).toEqual({ prompt: '', override: false, position: 'append', agents: [], models: ['a'] });
  });
});

describe('upgrade from v1', () => {
  // the SDK harness has no way to pass ctx.upgrade, so the test wraps activate to add it
  const upgraded = (options, storageSeed) => {
    const wrapped = {
      ...plugin,
      activate: async (ctx) => {
        await plugin.activate({ ...ctx, reason: 'upgrade', upgrade: { from: { apiVersion: 1, package: '@astragate-community/middleware-system-prompt', spec: 'x', options } } });
        ctx.subscriptions.push(commands.register('dump', async () => storage.get('settings')));
      },
    };
    return runCommand(wrapped, 'dump', {}, { storage: storageSeed });
  };
  it('turns the v1 options into settings', async () => {
    expect(await upgraded({ system_prompt: 'Hi', override: true, position: 'prepend', agents: ['claude'], models: ['gpt'] })).toEqual({ prompt: 'Hi', override: true, position: 'prepend', agents: ['claude'], models: ['gpt'] });
    expect(fromV1Options(undefined).prompt).toBe('');
  });
  it('keeps settings that already exist', async () => {
    const seed = { settings: { prompt: 'mine', override: false, position: 'append', agents: [], models: [] } };
    expect(await upgraded({ system_prompt: 'theirs' }, seed)).toEqual(seed.settings);
  });
});
