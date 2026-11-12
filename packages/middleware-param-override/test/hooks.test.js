import { describe, expect, it } from 'vitest';
import { runHook } from '@astragate/plugin-sdk/testing';
import hooks from '../src/gateway.js';

const run = (body, config, opts = {}) => runHook(hooks, 'override', 'request', body, { shared: { settings: config === undefined ? undefined : { text: '', config } }, protocol: 'chat', path: '/v1/chat/completions', model: body.model, ...opts });

describe('the hook as the gateway runs it', () => {
  it('rewrites the request from the stored settings and returns it', async () => {
    const r = await run({ model: 'deepseek-reasoner', temperature: 1, max_tokens: 64000 }, {
      operations: [
        { path: 'max_tokens', mode: 'set', value: 32000, conditions: [{ path: 'max_tokens', mode: 'gt', value: 32000 }] },
        { path: 'temperature', mode: 'delete', conditions: [{ path: 'model', mode: 'contains', value: 'reasoner' }] },
      ],
    });
    expect(r.output).toEqual({ model: 'deepseek-reasoner', max_tokens: 32000 });
    expect(r.rejected).toBeNull();
  });

  it('does nothing without settings, with an empty override, or when no operation applies', async () => {
    expect((await run({ a: 1 }, undefined)).output).toBeUndefined();
    expect((await run({ a: 1 }, {})).output).toBeUndefined();
    expect((await runHook(hooks, 'override', 'request', { a: 1 }, { shared: {} })).output).toBeUndefined();
    expect((await run({ model: 'x', a: 1 }, { operations: [{ path: 'a', mode: 'delete', conditions: [{ path: 'model', mode: 'full', value: 'y' }] }] })).output).toBeUndefined();
  });

  it('return_error turns the request away through ctx.reject', async () => {
    const r = await run({ model: 'claude-opus-4' }, { operations: [{ mode: 'return_error', value: { message: 'opus is not allowed here', status_code: 403 }, conditions: [{ path: 'model', mode: 'contains', value: 'opus' }] }] });
    expect(r.rejected).toEqual({ status: 403, message: 'opus is not allowed here' });
    expect(r.output).toBeUndefined();
  });

  it("conditions see the request's facts, and agent is the Astra client id", async () => {
    const config = { operations: [{ path: 'x', mode: 'set', value: 1, conditions: [{ path: 'agent', value: 'codex' }, { path: 'protocol', value: 'chat' }, { path: 'stream', value: true }, { path: 'request_path', mode: 'prefix', value: '/v1/' }], logic: 'AND' }] };
    expect((await run({}, config, { client: 'codex', stream: true })).output).toEqual({ x: 1 });
    expect((await run({}, config, { client: 'claude-code', stream: true })).output).toBeUndefined();
    const viaClient = { operations: [{ path: 'x', mode: 'set', value: 1, conditions: [{ path: 'client', value: 'codex' }] }] };
    expect((await run({}, viaClient, { client: 'codex' })).output).toEqual({ x: 1 });
  });

  it('settings holding anything but an object are ignored', async () => {
    for (const config of [[], 'x', 5, null]) expect((await run({ a: 1 }, config)).output).toBeUndefined();
  });
});
