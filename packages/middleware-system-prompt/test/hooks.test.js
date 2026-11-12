import { describe, expect, it } from 'vitest';
import { runHook } from '@astragate/plugin-sdk/testing';
import hooks from '../src/gateway.js';

const P = 'Answer in English.';
// the hook's answer: `out` is what it returned (undefined: the request is left as it was), `body` the request after it
const run = (body, settings, protocol, extra = {}) =>
  runHook(hooks, 'prompt', 'request', body, { shared: { settings: settings === undefined ? undefined : { prompt: P, ...settings } }, protocol, ...extra }).then((r) => ({ out: r.output, body: r.output ?? body }));

describe('without anything to add', () => {
  it('no prompt, bad settings or an unknown protocol: nothing happens', async () => {
    for (const shared of [{}, { settings: null }, { settings: {} }, { settings: { prompt: 5 } }, { settings: { prompt: '' } }]) {
      expect((await runHook(hooks, 'prompt', 'request', {}, { shared, protocol: 'chat' })).output).toBeUndefined();
    }
    expect((await run({}, {}, 'other')).out).toBeUndefined();
  });
});

describe('filters', () => {
  it('agents: only the listed clients', async () => {
    expect((await run({ messages: [] }, { agents: ['claude-code'] }, 'chat', { client: 'codex' })).out).toBeUndefined();
    expect((await run({ messages: [] }, { agents: ['claude-code'] }, 'chat', { client: null })).out).toBeUndefined();
    expect((await run({ messages: [] }, { agents: ['claude-code'] }, 'chat', { client: 'claude-code' })).out).toBeTruthy();
    expect((await run({ messages: [] }, { agents: [] }, 'chat', { client: 'codex' })).out).toBeTruthy();
  });
  it('models: only model name prefixes, from the body or else the ctx', async () => {
    expect((await run({ model: 'gpt-4o', messages: [] }, { models: ['claude'] }, 'chat')).out).toBeUndefined();
    expect((await run({ model: 'claude-3', messages: [] }, { models: ['claude'] }, 'chat')).out).toBeTruthy();
    expect((await run({ messages: [] }, { models: ['gem'] }, 'chat', { model: 'gemini-2' })).out).toBeTruthy();
    expect((await run({ messages: [] }, { models: [7] }, 'chat')).out).toBeUndefined();
    expect((await run({ messages: [] }, { models: ['x'] }, 'chat')).out).toBeUndefined();
  });
});

describe('anthropic', () => {
  it('is given when there is none, kept unless override', async () => {
    for (const system of [undefined, null, '', []]) expect((await run({ system }, {}, 'anthropic')).body.system).toBe(P);
    expect((await run({ system: 'mine' }, {}, 'anthropic')).out).toBeUndefined();
  });
  it('override appends or prepends, to a string or to blocks', async () => {
    expect((await run({ system: 'mine' }, { override: true }, 'anthropic')).body.system).toBe('mine\n' + P);
    expect((await run({ system: 'mine' }, { override: true, position: 'prepend' }, 'anthropic')).body.system).toBe(P + '\nmine');
    expect((await run({ system: [{ type: 'text', text: 'mine' }] }, { override: true }, 'anthropic')).body.system).toEqual([{ type: 'text', text: 'mine' }, { type: 'text', text: P }]);
    expect((await run({ system: [{ type: 'text', text: 'mine' }] }, { override: true, position: 'prepend' }, 'anthropic')).body.system).toEqual([{ type: 'text', text: P }, { type: 'text', text: 'mine' }]);
    // a system of some other shape is not ours to rewrite
    expect((await run({ system: 5 }, { override: true }, 'anthropic')).out).toBeUndefined();
  });
});

describe('chat', () => {
  it('a system message is added in front when there is none', async () => {
    const { body } = await run({ messages: [{ role: 'user', content: 'hi' }] }, {}, 'chat');
    expect(body.messages).toEqual([{ role: 'system', content: P }, { role: 'user', content: 'hi' }]);
    expect((await run({ messages: [] }, {}, 'chat')).body.messages).toEqual([{ role: 'system', content: P }]);
  });
  it("the agent's own system or developer message is kept unless override", async () => {
    for (const role of ['system', 'developer']) {
      expect((await run({ messages: [{ role, content: 'mine' }] }, {}, 'chat')).out).toBeUndefined();
      expect((await run({ messages: [{ role, content: 'mine' }] }, { override: true }, 'chat')).body.messages[0].content).toBe('mine\n' + P);
      expect((await run({ messages: [{ role, content: 'mine' }] }, { override: true, position: 'prepend' }, 'chat')).body.messages[0].content).toBe(P + '\nmine');
    }
  });
  it('override goes into content parts, and leaves content of another shape', async () => {
    const parts = { messages: [{ role: 'system', content: [{ type: 'text', text: 'mine' }] }] };
    expect((await run(parts, { override: true }, 'chat')).body.messages[0].content).toEqual([{ type: 'text', text: 'mine' }, { type: 'text', text: P }]);
    expect((await run(parts, { override: true, position: 'prepend' }, 'chat')).body.messages[0].content[0]).toEqual({ type: 'text', text: P });
    expect((await run({ messages: [{ role: 'system', content: null }] }, { override: true }, 'chat')).out).toBeUndefined();
  });
  it('a body without a messages array is left alone', async () => {
    expect((await run({}, {}, 'chat')).out).toBeUndefined();
    expect((await run({ messages: 'x' }, {}, 'chat')).out).toBeUndefined();
  });
  it('only the first message counts as the system prompt', async () => {
    const { body } = await run({ messages: [{ role: 'user', content: 'hi' }, { role: 'system', content: 'late' }] }, { override: true }, 'chat');
    expect(body.messages[0].content).toBe(P);
    expect(body.messages).toHaveLength(3);
  });
});

describe('responses', () => {
  it('instructions are given, kept, or joined', async () => {
    expect((await run({}, {}, 'responses')).body.instructions).toBe(P);
    expect((await run({ instructions: '' }, {}, 'responses')).body.instructions).toBe(P);
    expect((await run({ instructions: 5 }, {}, 'responses')).body.instructions).toBe(P);
    expect((await run({ instructions: 'mine' }, {}, 'responses')).out).toBeUndefined();
    expect((await run({ instructions: 'mine' }, { override: true }, 'responses')).body.instructions).toBe('mine\n' + P);
    expect((await run({ instructions: 'mine' }, { override: true, position: 'prepend' }, 'responses')).body.instructions).toBe(P + '\nmine');
  });
});

describe('gemini', () => {
  it('systemInstruction parts, and the snake_case spelling when that is what is there', async () => {
    expect((await run({}, {}, 'gemini')).body.systemInstruction).toEqual({ parts: [{ text: P }] });
    expect((await run({ systemInstruction: { parts: [] } }, {}, 'gemini')).body.systemInstruction).toEqual({ parts: [{ text: P }] });
    const snake = (await run({ system_instruction: { parts: [] } }, {}, 'gemini')).body;
    expect(snake.system_instruction).toEqual({ parts: [{ text: P }] });
    expect(snake.systemInstruction).toBeUndefined();
    expect((await run({ systemInstruction: { parts: [{ text: 'mine' }] } }, {}, 'gemini')).out).toBeUndefined();
    expect((await run({ systemInstruction: { parts: [{ text: 'mine' }] } }, { override: true }, 'gemini')).body.systemInstruction.parts).toEqual([{ text: 'mine' }, { text: P }]);
    expect((await run({ systemInstruction: { parts: [{ text: 'mine' }] } }, { override: true, position: 'prepend' }, 'gemini')).body.systemInstruction.parts).toEqual([{ text: P }, { text: 'mine' }]);
  });
  it('with both spellings present, camelCase wins', async () => {
    const both = (await run({ system_instruction: { parts: [{ text: 'a' }] }, systemInstruction: { parts: [{ text: 'b' }] } }, { override: true }, 'gemini')).body;
    expect(both.systemInstruction.parts).toHaveLength(2);
    expect(both.system_instruction.parts).toHaveLength(1);
  });
});
