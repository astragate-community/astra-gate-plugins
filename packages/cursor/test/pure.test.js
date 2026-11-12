import { describe, expect, it } from 'vitest';
import { failure, regional } from '../src/errors.js';
import { expiry } from '../src/jwt.js';
import { modelsOf, tokensOf } from '../src/models.js';
import { onDemandOf, poolBase } from '../src/usage.js';
import { b64urlBytes, b64urlText, unhex } from '../src/util.js';
import { claude, jwt } from './support.js';

describe('errors', () => {
  it("failure: Connect's details say it best, and the code picks the status", () => {
    const body = JSON.stringify({ code: 'resource_exhausted', message: 'Error', details: [{ debug: { details: { title: 'Usage', detail: 'limit hit' } } }] });
    expect(failure(429, body)).toEqual({ status: 429, message: 'usage limit reached: Usage: limit hit' });
    expect(failure(200, JSON.stringify({ error: { code: 'unavailable', message: 'later' } }))).toEqual({ status: 503, message: 'later' });
    expect(failure(400, JSON.stringify({ code: 'invalid_argument', message: 'bad' }))).toEqual({ status: 400, message: 'bad' });
  });

  it('failure: a stream that ended well keeps its 2xx; a non-JSON body is the text', () => {
    expect(failure(200, '{}')).toEqual({ status: 200, message: '' });
    expect(failure(502, 'bad gateway\n')).toEqual({ status: 502, message: 'bad gateway' });
  });

  it('failure: an expired sign-in is a 401 told to sign in again; a region is a 403', () => {
    expect(failure(500, JSON.stringify({ code: 'internal', message: 'token expired' })).status).toBe(401);
    const r = failure(500, JSON.stringify({ code: 'internal', message: 'not served in your region' }));
    expect(r.status).toBe(403);
    expect(regional(r.message)).toBe(true);
  });
});

describe('tokens', () => {
  it("expiry reads a JWT's exp in ms, and 0 for anything else", () => {
    expect(expiry(jwt({ exp: 1000 }))).toBe(1_000_000);
    expect(expiry(jwt({}))).toBe(0);
    expect(expiry('not a jwt')).toBe(0);
    expect(expiry(undefined)).toBe(0);
  });

  it('base64url by hand matches the real thing', () => {
    expect(b64urlText(Buffer.from('né 智').toString('base64url'))).toBe('né 智');
    expect(b64urlBytes(new Uint8Array([251, 255, 254, 1, 2]))).toBe(Buffer.from([251, 255, 254, 1, 2]).toString('base64url'));
    expect([...unhex('00ff10')]).toEqual([0, 255, 16]);
  });
});

describe('models', () => {
  it('tokensOf reads k and m', () => {
    expect(tokensOf('300k')).toBe(300000);
    expect(tokensOf('1m')).toBe(1000000);
    expect(tokensOf('1.5M')).toBe(1500000);
    expect(tokensOf('huge')).toBe(0);
  });

  it('a model is offered once for each context size, with that window and its efforts', () => {
    const list = modelsOf([claude, { name: 'gemini-2.5-pro' }, { name: 'hidden', isHidden: true }, { name: 'chat', isChatOnly: true }], null);
    expect(list.map((m) => [m.id, m.name, m.context])).toEqual([['claude-x@200k', 'Claude X @ 200k', 200000], ['claude-x@1m', 'Claude X @ 1m', 1000000]]);
    expect(list[0].levels).toEqual({ low: 'low', high: 'high' });
  });

  it('a model with no sizes is offered once, and the default model is auto', () => {
    const list = modelsOf([{ name: 'default', contextTokenLimit: 123000 }, { name: 'plain' }], null);
    expect(list.map((m) => [m.id, m.context])).toEqual([['auto', 123000], ['plain', 200000]]);
  });

  it("the usable list takes out the variants the account hasn't got", () => {
    expect(modelsOf([claude], new Set(['claude-x-low', 'claude-x-low-1m']))[0].levels).toEqual({ low: 'low' });
  });
});

describe('usage maths', () => {
  it('poolBase strips cursor-, the context size and the effort and speed the CLI adds', () => {
    expect(poolBase('cursor-Composer-2-fast')).toBe('composer-2');
    expect(poolBase('grok-4.7@256k')).toBe('grok-4.7');
    expect(poolBase('claude-opus-5-5-high-thinking')).toBe('claude-opus-5-5');
  });

  it("on-demand: a limit of the user's, none, and the team's pool", () => {
    expect(onDemandOf({ spendLimitUsage: { individualUsed: 250, individualLimit: 1000 } }, undefined)).toEqual({ kind: 'fixed', usedDollars: 2.5, limitDollars: 10 });
    expect(onDemandOf({}, { noUsageBasedAllowed: true })).toEqual({ kind: 'disabled', usedDollars: 0 });
    expect(onDemandOf({}, { hardLimit: 2147483647 })).toEqual({ kind: 'unlimited', usedDollars: 0 });
    expect(onDemandOf({}, undefined)).toEqual({ kind: 'unavailable', usedDollars: 0 });
    const team = { spendLimitUsage: { limitType: 'team', individualUsed: 500, pooledLimit: '45120000', pooledUsed: 1000 } };
    expect(onDemandOf(team, { hardLimit: 10 })).toEqual({ kind: 'fixed', usedDollars: 10, limitDollars: 451200, mineDollars: 5 });
  });
});
