import { describe, expect, it } from 'vitest';
import { runHook } from '@astragate/plugin-sdk/testing';
import hooks from '../src/gateway.js';

const shared = (rules = [{ id: '1', from: 'fast', to: 'deepseek-chat' }], keepUpstreamName) => ({ rules, keepUpstreamName });
const run = (hook, input, opts = {}) => runHook(hooks, 'map', hook, input, opts);

describe('onRequest', () => {
  it('rewrites the model and remembers the asked one', async () => {
    const state = {};
    const r = await run('request', { model: 'fast', messages: [] }, { shared: shared(), state });
    expect(r.output).toEqual({ model: 'deepseek-chat', messages: [] });
    expect(state.asked).toBe('fast');
  });
  it('is a no-op without a string model, a rule, or stored rules', async () => {
    for (const body of [{}, { model: null }, { model: 7 }, { model: 'other' }]) {
      const state = {};
      expect((await run('request', body, { shared: shared(), state })).output).toBeUndefined();
      expect(state.asked).toBeUndefined();
    }
    expect((await run('request', { model: 'fast' }, { shared: { rules: null } })).output).toBeUndefined();
    expect((await run('request', { model: 'fast' }, { shared: {} })).output).toBeUndefined();
  });
  it('applies patterns with $1', async () => {
    const s = shared([{ id: '1', from: '/^claude-(.*)$/', to: 'glm-$1' }]);
    expect((await run('request', { model: 'claude-sonnet' }, { shared: s })).output.model).toBe('glm-sonnet');
  });
});

describe('onEvent', () => {
  const state = { asked: 'fast' };
  it("names the asked model in each API's stream", async () => {
    expect((await run('event', { type: 'message_start', message: { model: 'deepseek-chat' } }, { shared: shared(), state })).output.message.model).toBe('fast');
    expect((await run('event', { model: 'deepseek-chat', choices: [] }, { shared: shared(), state })).output.model).toBe('fast');
    expect((await run('event', { type: 'response.completed', response: { model: 'deepseek-chat' } }, { shared: shared(), state })).output.response.model).toBe('fast');
    expect((await run('event', { candidates: [], modelVersion: 'deepseek-chat' }, { shared: shared(), state })).output.modelVersion).toBe('fast');
  });
  it('leaves an event that already says the asked name, or none', async () => {
    for (const ev of [{ model: 'fast' }, { modelVersion: 'fast' }, { type: 'ping' }]) expect((await run('event', ev, { shared: shared(), state })).output).toBeUndefined();
  });
  it('does nothing when nothing was asked or keepUpstreamName is on', async () => {
    expect((await run('event', { model: 'deepseek-chat' }, { shared: shared() })).output).toBeUndefined();
    expect((await run('event', { model: 'deepseek-chat' }, { shared: shared(undefined, true), state })).output).toBeUndefined();
  });
});

describe('onResponse', () => {
  const state = { asked: 'fast' };
  it('names the asked model, but not in an error', async () => {
    expect((await run('response', { model: 'deepseek-chat' }, { shared: shared(), state })).output.model).toBe('fast');
    expect((await run('response', { response: { model: 'deepseek-chat' } }, { shared: shared(), state })).output.response.model).toBe('fast');
    expect((await run('response', { modelVersion: 'deepseek-chat' }, { shared: shared(), state })).output.modelVersion).toBe('fast');
    expect((await run('response', { model: 'deepseek-chat' }, { shared: shared(), state, status: 500 })).output).toBeUndefined();
    expect((await run('response', { other: 1 }, { shared: shared(), state })).output).toBeUndefined();
  });
  it('does nothing when nothing was asked or keepUpstreamName is on', async () => {
    expect((await run('response', { model: 'x' }, { shared: shared() })).output).toBeUndefined();
    expect((await run('response', { model: 'x' }, { shared: shared(undefined, true), state })).output).toBeUndefined();
  });
});
