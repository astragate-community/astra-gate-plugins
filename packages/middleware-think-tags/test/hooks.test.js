import { describe, expect, it } from 'vitest';
import { runHook } from '@astragate/plugin-sdk/testing';
import hooks from '../src/gateway.js';
import { stripWhole, streamStripper, tail } from '../src/think.js';
import { reasoningToText, reasoningIntoReply } from '../src/reasoning.js';

// a request's hooks share one `state`; `settings` is what the view stored (undefined: none, so "strip")
const session = (settings, status) => {
  const state = {};
  const call = (hook, input) => runHook(hooks, 'think', hook, input, { shared: { settings }, state, status });
  return { state, event: (ev) => call('event', ev).then((r) => r.output), response: (body) => call('response', body).then((r) => r.output) };
};

describe('stripWhole', () => {
  it('takes a leading block and the whitespace after it', () => {
    expect(stripWhole('<think>hmm</think>\n\nanswer')).toBe('answer');
    expect(stripWhole('  \n<think>a\nb</think>answer')).toBe('answer');
    expect(stripWhole('<think></think>x')).toBe('x');
  });
  it("leaves a block that doesn't open the text, or isn't closed", () => {
    expect(stripWhole('answer <think>x</think>')).toBe('answer <think>x</think>');
    expect(stripWhole('<think>never closed')).toBe('<think>never closed');
    expect(stripWhole('plain')).toBe('plain');
    expect(stripWhole('')).toBe('');
  });
  it('takes only the first block', () => {
    expect(stripWhole('<think>a</think>b<think>c</think>d')).toBe('b<think>c</think>d');
  });
});

describe('tail', () => {
  it('is the longest end of s that begins the tag', () => {
    expect(tail('abc</thi', '</think>')).toBe('</thi');
    expect(tail('abc<', '</think>')).toBe('<');
    expect(tail('abc', '</think>')).toBe('');
    expect(tail('', '</think>')).toBe('');
    expect(tail('</think>', '</think>')).toBe('');
    expect(tail('xx</think', '</think>')).toBe('</think');
  });
});

describe('streamStripper', () => {
  // feed pieces through a stripper, as a stream does
  const streamed = (pieces) => {
    const strip = streamStripper({}, 'k');
    return pieces.map(strip);
  };
  it('a stream without a block passes straight through', () => {
    expect(streamed(['Hello', ' world'])).toEqual(['Hello', ' world']);
  });
  it("a stream's block is dropped, however its pieces fall", () => {
    const whole = '<think>reasoning</think>\n\nAnswer here';
    for (let n = 1; n <= whole.length; n++) {
      const pieces = [];
      for (let i = 0; i < whole.length; i += n) pieces.push(whole.slice(i, i + n));
      expect(streamed(pieces).join('')).toBe('Answer here');
    }
  });
  it("a partial open tag is held back, then given back when it isn't one", () => {
    expect(streamed(['<thi', 'nk>x</think>y'])).toEqual(['', 'y']);
    expect(streamed(['<th', 'ought'])).toEqual(['', '<thought']);
    expect(streamed(['  ', 'hi'])).toEqual(['', '  hi']);
  });
  it('after the text has begun, <think> is just text', () => {
    expect(streamed(['hello', '<think>x</think>'])).toEqual(['hello', '<think>x</think>']);
  });
  it('state is per key', () => {
    const state = {};
    const a = streamStripper(state, 'a0');
    const b = streamStripper(state, 'a1');
    expect(a('<think>x')).toBe('');
    expect(b('plain')).toBe('plain');
    expect(a('</think>done')).toBe('done');
  });
});

describe('strip: onEvent', () => {
  it('strips Anthropic text deltas across events, by block index', async () => {
    const s = session(undefined);
    const send = async (index, text) => {
      const ev = { type: 'content_block_delta', index, delta: { type: 'text_delta', text } };
      const out = await s.event(ev);
      return out ? out.delta.text : text;
    };
    expect(await send(0, '<think>a')).toBe('');
    expect(await send(0, 'b</think>\n')).toBe('');
    expect(await send(0, 'Hi')).toBe('Hi');
    expect(await send(1, 'plain')).toBe('plain');
  });

  it("returns nothing for events it doesn't touch", async () => {
    const s = session({ mode: 'strip' });
    expect(await s.event({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{' } })).toBeUndefined();
    expect(await s.event({ type: 'ping' })).toBeUndefined();
    expect(await s.event({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } })).toBeUndefined();
  });

  it('strips Responses deltas and whole-text events', async () => {
    const s = session(undefined);
    expect((await s.event({ type: 'response.output_text.delta', item_id: 'i', content_index: 0, delta: '<think>x</think>A' })).delta).toBe('A');
    expect((await s.event({ type: 'response.output_text.done', text: '<think>x</think>\nA' })).text).toBe('A');
    expect((await s.event({ type: 'response.content_part.done', part: { text: '<think>x</think>A' } })).part.text).toBe('A');
    const item = { type: 'response.output_item.done', item: { type: 'message', content: [{ type: 'output_text', text: '<think>x</think>A' }] } };
    expect((await s.event(item)).item.content[0].text).toBe('A');
    const completed = { type: 'response.completed', response: { output: [{ type: 'message', content: [{ type: 'output_text', text: '<think>x</think>A' }] }, { type: 'reasoning' }] } };
    expect((await s.event(completed)).response.output[0].content[0].text).toBe('A');
    expect(await s.event({ type: 'response.completed', response: { output: [{ type: 'message', content: [{ type: 'output_text', text: 'A' }] }] } })).toBeUndefined();
  });

  it('strips Chat chunks per choice and gives back text held at the end', async () => {
    const chunk = (content, finish) => ({ choices: [{ index: 0, delta: { content }, finish_reason: finish ?? null }] });
    const s = session(undefined);
    expect((await s.event(chunk('<think>r</think>Hello'))).choices[0].delta.content).toBe('Hello');
    expect(await s.event(chunk(' there'))).toBeUndefined();
    // ends while "<thi" is held back: it comes out with the finish
    const s2 = session(undefined);
    expect((await s2.event(chunk('<thi'))).choices[0].delta.content).toBe('');
    expect((await s2.event({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })).choices[0].delta.content).toBe('<thi');
    expect(s2.state.c0.carry).toBe('');
    // a choice without a delta is skipped
    expect(await session(undefined).event({ choices: [null, {}, { index: 1, delta: { content: 'ok' } }] })).toBeUndefined();
  });
});

describe('strip: onResponse', () => {
  it('strips Anthropic, Chat and Responses replies', async () => {
    const anthropic = await session(undefined).response({ content: [{ type: 'thinking', thinking: 't' }, { type: 'text', text: '<think>x</think>A' }, { type: 'text', text: '<think>y</think>B' }] });
    expect(anthropic.content[1].text).toBe('A');
    // only the first text block can open with the thinking
    expect(anthropic.content[2].text).toBe('<think>y</think>B');
    const chat = await session({ mode: 'strip' }).response({ choices: [{ message: { content: '<think>x</think>\nA' } }, { message: { content: null } }, null] });
    expect(chat.choices[0].message.content).toBe('A');
    const responses = await session(undefined).response({ output: [{ type: 'reasoning' }, { type: 'message', content: [{ type: 'output_text', text: '<think>x</think>A' }] }] });
    expect(responses.output[1].content[0].text).toBe('A');
  });

  it('leaves errors, clean replies and unknown shapes alone', async () => {
    expect(await session(undefined, 500).response({ choices: [{ message: { content: '<think>x</think>A' } }] })).toBeUndefined();
    expect(await session(undefined).response({ choices: [{ message: { content: 'A' } }] })).toBeUndefined();
    expect(await session(undefined).response({})).toBeUndefined();
  });
});

describe('to_content', () => {
  const settings = { mode: 'to_content' };

  it("a Chat stream's reasoning becomes <think> text, closed when the answer starts", async () => {
    const s = session(settings);
    const chunk = (delta, finish) => ({ choices: [{ index: 0, delta, finish_reason: finish ?? null }] });
    expect((await s.event(chunk({ reasoning_content: 'think ' }))).choices[0].delta).toEqual({ content: '<think>\nthink ' });
    expect((await s.event(chunk({ reasoning_content: 'more' }))).choices[0].delta).toEqual({ content: 'more' });
    expect((await s.event(chunk({ content: 'Answer' }))).choices[0].delta.content).toBe('\n</think>\n\nAnswer');
    expect(await s.event(chunk({ content: ' more' }))).toBeUndefined();
  });

  it('the reasoning alias, an empty reasoning, and an end of stream that closes the block', async () => {
    const s = session(settings);
    expect((await s.event({ choices: [{ index: 0, delta: { reasoning: 'r' } }] })).choices[0].delta.content).toBe('<think>\nr');
    const empty = await s.event({ choices: [{ index: 0, delta: { reasoning_content: '', content: '' } }] });
    expect(empty.choices[0].delta.reasoning_content).toBeUndefined();
    expect((await s.event({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })).choices[0].delta.content).toBe('\n</think>\n\n');
    expect(s.state.t0).toBe('closed');
  });

  it('an empty reasoning alone never opens a block; non-Chat events are left alone', async () => {
    const state = {};
    const ev = { choices: [{ index: 0, delta: { reasoning_content: '', content: 'Hi' } }] };
    expect(reasoningToText(ev, state)).toBe(ev);
    expect(ev.choices[0].delta.content).toBe('Hi');
    expect(state.t0).toBeUndefined();
    expect(await session(settings).event({ type: 'content_block_delta', delta: { type: 'text_delta', text: '<think>x</think>y' } })).toBeUndefined();
    expect(reasoningToText({ choices: [null, {}] }, {})).toBeUndefined();
  });

  it('a whole Chat reply gets its reasoning in front', async () => {
    const out = await session(settings).response({ choices: [{ message: { reasoning_content: 'why', content: 'Answer' } }, { message: { reasoning: 'r2' } }, { message: { content: 'none' } }, null] });
    expect(out.choices[0].message).toEqual({ content: '<think>\nwhy\n</think>\n\nAnswer' });
    expect(out.choices[1].message).toEqual({ content: '<think>\nr2\n</think>\n\n' });
    expect(out.choices[2].message).toEqual({ content: 'none' });
  });

  it('no reasoning, no choices, or an error: unchanged; it never strips', async () => {
    expect(reasoningIntoReply({ choices: [{ message: { content: 'x', reasoning_content: '' } }] })).toBeUndefined();
    expect(await session(settings).response({ content: [] })).toBeUndefined();
    expect(await session(settings, 400).response({ choices: [{ message: { reasoning_content: 'r' } }] })).toBeUndefined();
    expect(await session(settings).response({ choices: [{ message: { content: '<think>x</think>A' } }] })).toBeUndefined();
  });
});
