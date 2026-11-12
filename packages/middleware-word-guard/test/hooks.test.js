import { describe, expect, it } from 'vitest';
import { runHook } from '@astragate/plugin-sdk/testing';
import hooks from '../src/gateway.js';
import { matcher, maskOf, maskText } from '../src/matcher.js';

const call = (hook, input, settings, protocol = 'chat', extra = {}) => runHook(hooks, 'guard', hook, input, { shared: { settings }, protocol, ...extra });
const request = (body, settings, protocol) => call('request', body, settings, protocol);
const user = (content) => ({ role: 'user', content });

describe('matcher', () => {
  it('words are literal and case-insensitive, patterns are regexps, none gives null', () => {
    const re = matcher({ words: ['a.b', ' x+ ', '', 5], patterns: ['\\d{3}', '', 7] });
    const hits = (s) => ((re.lastIndex = 0), re.test(s));
    expect(hits('A.B')).toBe(true);
    expect(hits('axb')).toBe(false);
    expect(hits('X+')).toBe(true);
    expect(hits('call 123')).toBe(true);
    expect(matcher({ words: [], patterns: [] })).toBeNull();
    expect(matcher({})).toBeNull();
    expect(matcher(undefined)).toBeNull();
    expect(matcher('words')).toBeNull();
  });
  it("a pattern's own alternation stays inside it; the expression is cached per words and patterns", () => {
    const re = matcher({ words: ['zz'], patterns: ['a|b'] });
    expect('zz a b'.replace(re, '_')).toBe('_ _ _');
    expect(matcher({ words: ['zz'], patterns: ['a|b'] })).toBe(re);
    expect(matcher({ words: ['zz'], patterns: ['a'] })).not.toBe(re);
  });
  it('a bad pattern throws, and the next good call still works', () => {
    expect(() => matcher({ words: ['w'], patterns: ['('] })).toThrow();
    expect(matcher({ words: ['w'] })).toBeTruthy();
  });
  it('maskOf and maskText', () => {
    expect(maskOf({})).toBe('***');
    expect(maskOf({ mask: 5 })).toBe('***');
    expect(maskOf({ mask: '' })).toBe('');
    const re = matcher({ words: ['secret'] });
    // the shared expression is global: a second call must not start where the first stopped
    expect(maskText(re, 'secret Secret', '#')).toBe('# #');
    expect(maskText(re, 'secret', '#')).toBe('#');
  });
});

describe('onRequest', () => {
  it('with no words, no settings or none stored, does nothing', async () => {
    for (const settings of [{ words: [] }, undefined, null]) {
      const r = await request({ messages: [user('hello')] }, settings);
      expect(r.output).toBeUndefined();
      expect(r.rejected).toBeNull();
    }
  });

  it('reject: turns the request away naming the word, status 400', async () => {
    const r = await request({ messages: [user('about CodeName today')] }, { words: ['codename'] });
    expect(r.output).toBeUndefined();
    expect(r.rejected).toEqual({ status: 400, message: `this request has "CodeName", which this gateway doesn't send` });
  });
  it('reject: a custom message, and clean text passes', async () => {
    expect((await request({ messages: [user('an x')] }, { words: ['x'], message: 'no' })).rejected.message).toBe('no');
    expect((await request({ messages: [user('fine')] }, { words: ['x'] })).rejected).toBeNull();
  });
  it("reject is the action for anything that isn't mask", async () => {
    expect((await request({ messages: [user('x')] }, { words: ['x'], action: 'whatever' })).rejected).toBeTruthy();
  });

  it('check last reads only the last user message with text; all reads every one', async () => {
    const body = () => ({ messages: [user('bad word'), { role: 'assistant', content: 'ok' }, user('fine'), { role: 'user', content: [{ type: 'image_url' }] }] });
    expect((await request(body(), { words: ['bad'], check: 'last' })).rejected).toBeNull();
    expect((await request(body(), { words: ['bad'] })).rejected).toBeNull();
    expect((await request(body(), { words: ['bad'], check: 'all' })).rejected).toBeTruthy();
  });
  it("only the user's text is read: not the system prompt, assistant, or tool results", async () => {
    const r = await request({ messages: [{ role: 'system', content: 'bad' }, { role: 'assistant', content: 'bad' }, { role: 'tool', content: 'bad' }, user('fine')] }, { words: ['bad'], check: 'all' });
    expect(r.rejected).toBeNull();
  });

  it('mask: replaces every match in the chosen texts and returns the body', async () => {
    const r = await request({ messages: [user('old secret'), user('a secret and another SECRET')] }, { words: ['secret'], action: 'mask' });
    expect(r.output.messages.map((m) => m.content)).toEqual(['old secret', 'a *** and another ***']);
    const all = await request({ messages: [user('old secret'), user('x')] }, { words: ['secret'], action: 'mask', check: 'all', mask: '[removed]' });
    expect(all.output.messages[0].content).toBe('old [removed]');
  });
  it('mask: no match, no change, undefined', async () => {
    expect((await request({ messages: [user('fine')] }, { words: ['secret'], action: 'mask' })).output).toBeUndefined();
  });
  it('mask: text parts are masked, image parts left', async () => {
    const r = await request({ messages: [{ role: 'user', content: [{ type: 'text', text: 'a secret' }, { type: 'image_url', url: 'secret' }] }] }, { words: ['secret'], action: 'mask' });
    expect(r.output.messages[0].content).toEqual([{ type: 'text', text: 'a ***' }, { type: 'image_url', url: 'secret' }]);
  });

  it('responses: input string and input items', async () => {
    const s = await request({ input: 'my secret' }, { words: ['secret'], action: 'mask' }, 'responses');
    expect(s.output.input).toBe('my ***');
    const items = await request(
      { input: [{ role: 'user', content: [{ type: 'input_text', text: 'a secret' }, { type: 'input_image' }] }, { role: 'assistant', content: [{ type: 'output_text', text: 'secret' }] }] },
      { words: ['secret'], action: 'mask', check: 'all' },
      'responses',
    );
    expect(items.output.input[0].content[0].text).toBe('a ***');
    expect(items.output.input[1].content[0].text).toBe('secret');
    expect((await request({ input: 'secret' }, { words: ['secret'] }, 'responses')).rejected).toBeTruthy();
  });
  it('gemini: user contents, and a content without a role is the user\'s', async () => {
    const r = await request({ contents: [{ role: 'model', parts: [{ text: 'secret' }] }, { parts: [{ text: 'a secret' }] }] }, { words: ['secret'], action: 'mask', check: 'all' }, 'gemini');
    expect(r.output.contents[0].parts[0].text).toBe('secret');
    expect(r.output.contents[1].parts[0].text).toBe('a ***');
  });
  it("malformed bodies don't throw", async () => {
    for (const [body, protocol] of [[{}, 'chat'], [{ messages: 'x' }, 'chat'], [{ messages: [null, 3] }, 'chat'], [{ contents: null }, 'gemini'], [{ input: 3 }, 'responses']]) {
      const r = await request(body, { words: ['x'] }, protocol);
      expect(r.output).toBeUndefined();
      expect(r.rejected).toBeNull();
    }
  });
});

describe('replies', () => {
  const masking = { words: ['secret'], action: 'mask', replies: true };

  it('are left alone unless replies is on and the action is mask', async () => {
    for (const settings of [{ words: ['secret'], action: 'mask' }, { words: ['secret'], replies: true }, { words: [], action: 'mask', replies: true }, undefined]) {
      expect((await call('event', { type: 'content_block_delta', delta: { text: 'secret' } }, settings)).output).toBeUndefined();
      expect((await call('response', { choices: [{ message: { content: 'secret' } }] }, settings)).output).toBeUndefined();
    }
  });

  it("onEvent masks each API's text deltas", async () => {
    const cases = [
      [{ type: 'content_block_delta', delta: { type: 'text_delta', text: 'a secret' } }, (e) => e.delta.text],
      [{ type: 'response.output_text.delta', delta: 'a secret' }, (e) => e.delta],
      [{ type: 'response.output_text.done', text: 'a secret' }, (e) => e.text],
      [{ choices: [{ delta: { content: 'a secret' } }] }, (e) => e.choices[0].delta.content],
      [{ candidates: [{ content: { parts: [{ text: 'a secret' }] } }] }, (e) => e.candidates[0].content.parts[0].text],
    ];
    for (const [ev, read] of cases) expect(read((await call('event', ev, masking)).output)).toBe('a ***');
  });
  it('onEvent: nothing to mask, nothing returned', async () => {
    for (const ev of [{ type: 'ping' }, { choices: [{ delta: { role: 'assistant' } }] }, { choices: [{ delta: { content: 'fine' } }] }, { type: 'content_block_delta', delta: { partial_json: '{}' } }, { candidates: [{ finishReason: 'STOP' }, null] }]) {
      expect((await call('event', ev, masking)).output).toBeUndefined();
    }
  });

  it("onResponse masks each API's whole reply", async () => {
    const anthropic = (await call('response', { content: [{ type: 'text', text: 'a secret' }, { type: 'tool_use', text: 'secret' }] }, masking)).output;
    expect(anthropic.content.map((b) => b.text)).toEqual(['a ***', 'secret']);
    const chat = (await call('response', { choices: [{ message: { content: 'a secret' } }, { message: { content: null } }] }, masking)).output;
    expect(chat.choices[0].message.content).toBe('a ***');
    const responses = (await call('response', { output: [{ content: [{ type: 'output_text', text: 'a secret' }] }, { type: 'function_call' }] }, masking)).output;
    expect(responses.output[0].content[0].text).toBe('a ***');
    const gemini = (await call('response', { candidates: [{ content: { parts: [{ text: 'a secret' }] } }] }, masking)).output;
    expect(gemini.candidates[0].content.parts[0].text).toBe('a ***');
  });
  it('onResponse leaves errors and clean replies alone', async () => {
    expect((await call('response', { choices: [{ message: { content: 'secret' } }] }, masking, 'chat', { status: 500 })).output).toBeUndefined();
    expect((await call('response', { choices: [{ message: { content: 'fine' } }] }, masking)).output).toBeUndefined();
  });
});
