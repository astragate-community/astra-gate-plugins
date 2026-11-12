// The pure parts of a chat (the v1 plugin's models / conversation tests): the variant a model runs as, and the conversation.
import { describe, expect, it } from 'vitest';
import { modelsOf, slim } from '../src/models.js';
import { fitEffort, request, splitID } from '../src/variants.js';
import { CALL, NO_RESULT, catalog, conversation, joinSplitCalls, toolsOf } from '../src/conversation.js';
import { conversationID, sessionOf } from '../src/run.js';
import { text } from '../src/protobuf.js';
import { claude } from './support.js';

// the list as prepare reads it back: slimmed and through storage (JSON), so no entry shares an object with another
const stored = (models, ids = null) => JSON.parse(JSON.stringify(modelsOf(models, ids).map(slim)));

describe('request', () => {
  it("the effort and context asked for pick Cursor's variant, in Max Mode where it needs it", () => {
    const raw = stored([claude]);
    expect(request(raw, 'claude-x@200k', 'high', undefined)).toEqual({ id: 'claude-x-high', params: [{ id: 'effort', value: 'high' }, { id: 'context', value: '200k' }], maxMode: false });
    const big = request(raw, 'claude-x@1m', 'low', undefined);
    expect(big.id).toBe('claude-x-low-1m');
    expect(big.maxMode).toBe(true);
  });

  it("an id of Cursor's own that the list lacks runs as the variant it names; an unknown one as it is", () => {
    const raw = stored([claude]);
    expect(request(raw, 'claude-x-high', '', undefined).id).toBe('claude-x-high');
    expect(request(raw, 'mystery', '', undefined)).toEqual({ id: 'mystery', params: [], maxMode: false });
    expect(request(raw, 'auto', '', undefined).id).toBe('default');
  });

  it('fitEffort goes to the nearest level; splitID takes an id apart', () => {
    expect(fitEffort('xhigh', ['low', 'medium', 'high'])).toBe('high');
    expect(fitEffort('ultra', ['low', 'max'])).toBe('max');
    expect(fitEffort('none', ['low', 'high'])).toBe('low');
    expect(splitID('claude-opus-5-5-high-thinking-fast')).toEqual(['claude-opus-5-5-thinking-fast', 'high']);
    expect(splitID('cursor-grok-4.6')).toEqual(['cursor-grok-4.6', '']);
  });
});

const fn = (name, parameters) => ({ type: 'function', function: { name, description: name + ' it', parameters } });
const parsed = (conv) => conv.msgs.map((b) => JSON.parse(text(b)));

describe('conversation', () => {
  it('toolsOf: tool_choice none lists nothing, a named function lists just it', () => {
    const chat = { tools: [fn('read'), fn('write', { type: 'object', properties: { a: {} } }), { type: 'other' }] };
    expect(toolsOf(chat).map((t) => t.name)).toEqual(['read', 'write']);
    expect(toolsOf({ ...chat, tool_choice: 'none' })).toEqual([]);
    expect(toolsOf({ ...chat, tool_choice: { type: 'function', function: { name: 'write' } } }).map((t) => t.name)).toEqual(['write']);
    expect(toolsOf(chat)[0].schemaText).toBe('{"type":"object","properties":{}}');
  });

  it('catalog writes each tool as the CallDynamicTool call itself', () => {
    expect(catalog([])).toBe('');
    const c = catalog(toolsOf({ tools: [fn('read')] }));
    expect(c).toContain(`<call>${CALL}({"namespace":"magpie","toolName":"read","arguments":{...}})`);
    expect(c.endsWith('</dynamic_tool_catalog>')).toBe(true);
  });

  it("the system prompt and the catalog lead; the user's last words are kept", () => {
    const chat = { messages: [{ role: 'system', content: 'be brief' }, { role: 'developer', content: [{ type: 'text', text: 'dev' }] }, { role: 'user', content: 'hello' }] };
    const conv = conversation(chat, toolsOf({ tools: [fn('read')] }));
    const [sys, user] = parsed(conv);
    expect(sys.role).toBe('system');
    expect(sys.content.startsWith('be brief\n\ndev\n\n<dynamic_tool_catalog>')).toBe(true);
    expect(user).toEqual({ role: 'user', content: [{ type: 'text', text: 'hello' }] });
    expect(conv.last).toBe('hello');
    expect(conv.estimate).toBeGreaterThan(0);
  });

  it('a tool result answers its call; a call left unanswered is answered as interrupted', () => {
    const call = (id, name) => ({ id, type: 'function', function: { name, arguments: '{"x":1}' } });
    const chat = {
      messages: [
        { role: 'user', content: 'go' },
        { role: 'assistant', content: '', tool_calls: [call('c1', 'read'), call('c2', 'write')] },
        { role: 'tool', tool_call_id: 'c1', content: '{"ok":true}' },
        { role: 'user', content: 'and then?' },
      ],
    };
    const msgs = parsed(conversation(chat, []));
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'user']);
    expect(msgs[1].content[0]).toEqual({ type: 'tool-call', toolCallId: 'c1', toolName: CALL, args: { namespace: 'magpie', toolName: 'read', arguments: { x: 1 } } });
    const [r1, r2] = msgs[2].content;
    expect(r1.result).toEqual({ ok: true });
    expect(r1.isError).toBeUndefined();
    expect(r2).toMatchObject({ toolCallId: 'c2', isError: true, result: NO_RESULT });
  });

  it("a call id with Cursor's line in it is restored, and reasoning is sent as a reasoning part", () => {
    const chat = { messages: [{ role: 'assistant', reasoning_content: 'hmm', content: 'ok', tool_calls: [{ id: 'call_a__fc_b', type: 'function', function: { name: 't', arguments: '{}' } }] }] };
    const [a] = parsed(conversation(chat, []));
    expect(a.content.map((p) => p.type)).toEqual(['reasoning', 'text', 'tool-call']);
    expect(a.content[2].toolCallId).toBe('call_a\nfc_b');
  });

  it('images go inline as hex, other images and files as a line of text', () => {
    const chat = {
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'look' },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,AQID' } },
            { type: 'image_url', image_url: { url: 'https://x/y.png' } },
            { type: 'file', file: { filename: 'a.txt' } },
          ],
        },
      ],
    };
    const [u] = parsed(conversation(chat, []));
    expect(u.content[1]).toEqual({ type: 'image', mimeType: 'image/png', image: { __type: 'Uint8Array', hex: '010203' } });
    expect(u.content[2].text).toBe('[attachment image: https://x/y.png]');
    expect(u.content[3].text).toBe('[attachment a.txt]');
  });

  it("joinSplitCalls joins an assistant turn's calls split over two messages, leaving the input alone", () => {
    const a = { role: 'assistant', content: 'one', tool_calls: [{ id: '1' }] };
    const b = { role: 'assistant', content: 'two', tool_calls: [{ id: '2' }] };
    const msgs = [a, b];
    const out = joinSplitCalls(msgs);
    expect(out).toHaveLength(1);
    expect(out[0].content).toBe('one\n\ntwo');
    expect(out[0].tool_calls.map((c) => c.id)).toEqual(['1', '2']);
    expect(msgs).toHaveLength(2);
    expect(joinSplitCalls([{ role: 'assistant', content: 'x' }, b])).toHaveLength(2);
  });

  it('the conversation id is stable for a session and its first message, and none without a session', () => {
    const chat = { prompt_cache_key: 'thread-1', messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'yo' }] };
    const id = conversationID(chat, sessionOf(chat));
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(conversationID({ ...chat, messages: [...chat.messages, { role: 'user', content: 'more' }] }, 'thread-1')).toBe(id);
    expect(conversationID({ messages: chat.messages }, sessionOf({ messages: chat.messages }))).toBe('');
    expect(sessionOf({}, { session_id: 's-9' })).toBe('s-9');
  });
});
