import { describe, expect, it } from 'vitest';
import { commands, storage } from 'astra';
import { mount, runCommand } from '@astragate/plugin-sdk/testing';
import plugin, { settings } from '../src/main.js';

describe('settings view', () => {
  it('lists the stored rules and the keep switch', async () => {
    const v = await mount(settings, { storage: { rules: [{ id: 'a', from: 'fast', to: 'x' }, { id: 'b', from: '/^g/', to: 'y' }], keepUpstreamName: true } });
    expect(v.find('Table').props.rows.map((r) => r.id)).toEqual(['a', 'b']);
    expect(v.find('Switch').props.checked).toBe(true);
  });

  it('adds, edits and deletes a rule, writing storage each time', async () => {
    const v = await mount(settings);
    await v.press('create');
    await v.change('from', 'fast');
    await v.change('to', 'deepseek-chat');
    await v.press('save');
    const [rule] = await v.storage.get('rules');
    expect(rule).toMatchObject({ from: 'fast', to: 'deepseek-chat' });
    expect(v.find('Sheet').props.open).toBe(false);

    await v.press('edit', { key: rule.id });
    expect(v.find('Sheet').props.open).toBe(true);
    await v.change('from', '/^fast/i');
    await v.change('to', 'glm-1');
    await v.press('save');
    expect(await v.storage.get('rules')).toEqual([{ id: rule.id, from: '/^fast/i', to: 'glm-1' }]);

    await v.press('remove', { key: rule.id });
    expect(await v.storage.get('rules')).toEqual([]);
  });

  it('refuses an empty field, a bad regular expression and a duplicate name', async () => {
    const v = await mount(settings, { storage: { rules: [{ id: 'a', from: 'fast', to: 'x' }] } });
    const save = async (from, to) => {
      await v.press('create');
      await v.change('from', from);
      await v.change('to', to);
      return (await v.press('save')).find((e) => e.type === 'fail')?.errors;
    };
    expect(await save('', 'x')).toHaveProperty('from');
    expect(await save('/(/', 'x')).toHaveProperty('from');
    expect(await save('fast', 'x')).toHaveProperty('from');
    expect(await save('ok', '')).toHaveProperty('to');
    expect(await v.storage.get('rules')).toEqual([{ id: 'a', from: 'fast', to: 'x' }]);
  });

  it('stores the keep switch', async () => {
    const v = await mount(settings);
    await v.change('keepUpstreamName', true);
    expect(await v.storage.get('keepUpstreamName')).toBe(true);
  });
});

describe('upgrade from v1', () => {
  // the SDK harness has no way to pass ctx.upgrade, so the test wraps activate to add it
  const upgraded = (options, storageSeed) => {
    const wrapped = {
      ...plugin,
      activate: async (ctx) => {
        await plugin.activate({ ...ctx, reason: 'upgrade', upgrade: { from: { apiVersion: 1, package: '@astragate-community/middleware-model-map', spec: 'x', options } } });
        ctx.subscriptions.push(commands.register('dump', async () => ({ rules: await storage.get('rules'), keep: await storage.get('keepUpstreamName') })));
      },
    };
    return runCommand(wrapped, 'dump', {}, { storage: storageSeed });
  };

  it('turns the v1 options into rules', async () => {
    const out = await upgraded({ mapping: { fast: 'deepseek-chat' }, keep_upstream_name: true });
    expect(out.rules.map(({ from, to }) => [from, to])).toEqual([['fast', 'deepseek-chat']]);
    expect(out.keep).toBe(true);
  });

  it('keeps rules that already exist', async () => {
    const seed = { rules: [{ id: 'a', from: 'mine', to: 'x' }] };
    expect((await upgraded({ fast: 'y' }, seed)).rules).toEqual(seed.rules);
  });
});
