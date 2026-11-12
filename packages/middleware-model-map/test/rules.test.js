import { describe, expect, it } from 'vitest';
import { compileRules, fromV1Options, resolveModel } from '../src/rules.js';

const rulesOf = (mapping) => Object.entries(mapping).map(([from, to]) => ({ from, to }));
const mapped = (name, mapping) => resolveModel(name, compileRules(rulesOf(mapping)));

describe('rules (the v1 mapping semantics)', () => {
  it('maps exact names and leaves an unlisted name alone', () => {
    expect(mapped('fast', { fast: 'deepseek-chat' })).toBe('deepseek-chat');
    expect(mapped('slow', { fast: 'deepseek-chat' })).toBe('slow');
  });
  it('chains until nothing more maps', () => expect(mapped('a', { a: 'b', b: 'c' })).toBe('c'));
  it('stops a cycle where it would repeat', () => {
    expect(mapped('a', { a: 'b', b: 'a' })).toBe('b');
    expect(mapped('a', { a: 'a' })).toBe('a');
  });
  it('cuts a chain longer than 16 steps', () => {
    const mapping = {};
    for (let i = 0; i < 40; i++) mapping['m' + i] = 'm' + (i + 1);
    expect(mapped('m0', mapping)).toBe('m16');
  });
  it('patterns: regexp keys, $1, flags, and exact names win over them', () => {
    const mapping = { '/^claude-(.*)$/': 'glm-$1', 'claude-special': 'kept', '/^GPT-4$/i': 'gpt-x' };
    expect(mapped('claude-sonnet', mapping)).toBe('glm-sonnet');
    expect(mapped('claude-special', mapping)).toBe('kept');
    expect(mapped('gpt-4', mapping)).toBe('gpt-x');
  });
  it('drops a g flag so a pattern keeps matching call after call', () => {
    const rules = compileRules([{ from: '/^a$/g', to: 'b' }]);
    expect(resolveModel('a', rules)).toBe('b');
    expect(resolveModel('a', rules)).toBe('b');
  });
  it('ignores entries with an empty or non-string target, and a pattern that does not compile', () => {
    const rules = compileRules([{ from: 'a', to: '' }, { from: 'b', to: 3 }, { from: 'c', to: null }, { from: '/(/', to: 'x' }, { from: 'd', to: 'e' }]);
    expect(rules).toEqual({ exact: { d: 'e' }, patterns: [] });
  });
  it("does not map Object.prototype's names", () => {
    expect(mapped('constructor', { fast: 'x' })).toBe('constructor');
    expect(mapped('toString', {})).toBe('toString');
  });
  it('gives no rules for anything but a list', () => {
    for (const o of [undefined, null, 'x', 3, {}]) expect(compileRules(o)).toEqual({ exact: {}, patterns: [] });
  });
});

describe('fromV1Options', () => {
  it('reads the mapping form and keep_upstream_name', () => {
    const r = fromV1Options({ mapping: { fast: 'deepseek-chat', '/^gpt-4o(-.*)?$/': 'deepseek-chat', bad: '' }, keep_upstream_name: true });
    expect(r.rules.map(({ from, to }) => [from, to])).toEqual([['fast', 'deepseek-chat'], ['/^gpt-4o(-.*)?$/', 'deepseek-chat']]);
    expect(r.keepUpstreamName).toBe(true);
    expect(new Set(r.rules.map((x) => x.id)).size).toBe(2);
  });
  it('reads New API\'s flat form and ignores keep_upstream_name as a mapping', () => {
    const r = fromV1Options({ fast: 'x', keep_upstream_name: 'true' });
    expect(r.rules.map((x) => x.from)).toEqual(['fast']);
    expect(r.keepUpstreamName).toBe(false);
  });
  it('survives bad options', () => {
    for (const o of [undefined, null, 'x', 3]) expect(fromV1Options(o)).toEqual({ rules: [], keepUpstreamName: false });
  });
});
