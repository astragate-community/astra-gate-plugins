import { describe, expect, it } from 'vitest';
import { storage, commands } from 'astra';
import { mount, runCommand } from '@astragate/plugin-sdk/testing';
import plugin, { settings } from '../src/main.js';
import { parse, normalize, fromV1Options } from '../src/settings.js';

const field = (v) => v.findAll('Field').map((f) => f.props.error).find(Boolean);

describe('settings view', () => {
  it('shows the stored JSON text', async () => {
    const v = await mount(settings, { storage: { settings: { text: '{"temperature": 0.2}', config: { temperature: 0.2 } } } });
    expect(v.find('CodeField').props.value).toBe('{"temperature": 0.2}');
    expect((await mount(settings)).find('CodeField').props.value).toBe('');
  });

  it('saves valid JSON as it is typed, keeping the text as typed', async () => {
    const v = await mount(settings);
    await v.change('text', '{\n  "temperature": 0.2\n}');
    expect(await v.storage.get('settings')).toEqual({ text: '{\n  "temperature": 0.2\n}', config: { temperature: 0.2 } });
    expect(field(v)).toBeUndefined();
  });

  it('keeps the last good version when the JSON is broken or not an object, and says so', async () => {
    const v = await mount(settings, { storage: { settings: { text: '{"a":1}', config: { a: 1 } } } });
    await v.change('text', '{"a":');
    expect(await v.storage.get('settings')).toEqual({ text: '{"a":1}', config: { a: 1 } });
    expect(field(v)).toMatch(/error\.json/);
    await v.change('text', '[1]');
    expect(await v.storage.get('settings')).toEqual({ text: '{"a":1}', config: { a: 1 } });
    expect(field(v)).toMatch(/error\.object/);
    await v.change('text', '{"b":2}');
    expect(await v.storage.get('settings')).toEqual({ text: '{"b":2}', config: { b: 2 } });
    expect(field(v)).toBeUndefined();
  });

  it('empties the override when the text is cleared', async () => {
    const v = await mount(settings, { storage: { settings: { text: '{"a":1}', config: { a: 1 } } } });
    await v.change('text', '');
    expect(await v.storage.get('settings')).toEqual({ text: '', config: {} });
  });

  it('the example button fills the editor and saves it', async () => {
    const v = await mount(settings);
    await v.press('useExample');
    const saved = await v.storage.get('settings');
    expect(saved.config.operations).toHaveLength(2);
    expect(v.find('CodeField').props.value).toBe(saved.text);
  });
});

describe('parse / normalize', () => {
  it('parses an object, treats empty as none, and names what is wrong', () => {
    expect(parse('{"a":1}')).toEqual({ config: { a: 1 } });
    expect(parse('  ')).toEqual({ config: {} });
    expect(parse(undefined)).toEqual({ config: {} });
    expect(parse('[]')).toEqual({ error: 'object' });
    expect(parse('null')).toEqual({ error: 'object' });
    expect(parse('{').error).toBeTruthy();
  });
  it('rebuilds the config from the stored text', () => {
    expect(normalize({ text: '{"a":1}', config: { stale: true } })).toEqual({ text: '{"a":1}', config: { a: 1 } });
    expect(normalize(undefined)).toEqual({ text: '', config: {} });
  });
});

describe('upgrade from v1', () => {
  // the SDK harness has no way to pass ctx.upgrade, so the test wraps activate to add it
  const upgraded = (options, storageSeed) => {
    const wrapped = {
      ...plugin,
      activate: async (ctx) => {
        await plugin.activate({ ...ctx, reason: 'upgrade', upgrade: { from: { apiVersion: 1, package: '@astragate-community/middleware-param-override', spec: 'x', options } } });
        ctx.subscriptions.push(commands.register('dump', async () => storage.get('settings')));
      },
    };
    return runCommand(wrapped, 'dump', {}, { storage: storageSeed });
  };
  it('turns the v1 options (New API\'s JSON) into the override', async () => {
    const options = { operations: [{ path: 'max_tokens', mode: 'set', value: 1 }] };
    const out = await upgraded(options);
    expect(out.config).toEqual(options);
    expect(JSON.parse(out.text)).toEqual(options);
    expect(fromV1Options({})).toEqual({ text: '', config: {} });
    expect(fromV1Options([1])).toEqual({ text: '', config: {} });
  });
  it('keeps settings that already exist', async () => {
    const seed = { settings: { text: '{"a":1}', config: { a: 1 } } };
    expect(await upgraded({ b: 2 }, seed)).toEqual(seed.settings);
  });
});
