import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { runHook } from '@astragate/plugin-sdk/testing';
import hooks from '../src/gateway.js';
import { IDENTITY, fingerprint, sessionUuid } from '../src/identity.js';

const sha256 = (v) => createHash('sha256').update(Array.isArray(v) ? Buffer.from(v) : Buffer.from(String(v), 'utf8')).digest('hex');
const upstream = (protocol = 'anthropic', id = 'prov_1', name = 'Relay') => ({ protocol, provider: { id, name }, model: 'claude-sonnet-4-5', stream: true });

// out: what the hook returned (undefined: the request is left as it was); body: the request after it
async function run(body, settings, up = upstream()) {
  const r = await runHook(hooks, 'identity', 'upstream', body, { shared: { settings }, upstream: up });
  return { out: r.output, headers: Object.fromEntries(r.headers), body: r.output ?? body };
}
const request = () => ({ model: 'claude-sonnet-4-5', system: 'Be brief.', messages: [{ role: 'user', content: 'Hello, world!' }] });

describe('which requests', () => {
  it('no providers, another channel or another API: nothing happens', async () => {
    for (const settings of [undefined, null, {}, { providers: [] }, { providers: ['prov_2'] }, { providers: ['prov_1'], protocol: 'chat' }]) {
      const { out, headers } = await run(request(), settings);
      expect(out).toBeUndefined();
      expect(headers).toEqual({});
    }
    expect((await run(request(), { providers: ['prov_1'] }, upstream('chat'))).out).toBeUndefined();
  });
  it('a request with no upstream (a plain request hook) is left alone', async () => {
    const r = await runHook(hooks, 'identity', 'upstream', request(), { shared: { settings: { providers: ['prov_1'] } } });
    expect(r.output).toBeUndefined();
    expect(r.headers).toEqual([]);
  });
  it('the channel is named by id or by name', async () => {
    expect((await run(request(), { providers: ['prov_1'] })).out).toBeTruthy();
    expect((await run(request(), { providers: ['Relay'] })).out).toBeTruthy();
  });
});

describe('anthropic', () => {
  it("sets the CLI's headers, billing and identity blocks before the caller's system, and a user_id", async () => {
    const { out, headers, body } = await run(request(), { providers: ['prov_1'] });
    expect(out).toBeTruthy();
    expect(headers['User-Agent']).toBe('claude-cli/2.1.281 (external, cli)');
    expect(headers['X-App']).toBe('cli');
    expect(headers['anthropic-version']).toBe('2023-06-01');
    expect(headers['anthropic-beta']).toMatch(/^claude-code-20250219,/);
    expect(headers['anthropic-beta']).not.toMatch(/oauth/);
    expect(headers.Authorization).toBeUndefined();
    expect(body.system).toEqual([
      { type: 'text', text: 'x-anthropic-billing-header: cc_version=2.1.281.a99; cc_entrypoint=cli;' },
      { type: 'text', text: IDENTITY },
      { type: 'text', text: 'Be brief.' },
    ]);
    const user = JSON.parse(body.metadata.user_id);
    expect(user.device_id).toBe(sha256('astra-claude-device::prov_1'));
    expect(user.account_uuid).toBe('');
    expect(user.session_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("the fingerprint matches Astra's C# one, also when the picked bytes cut a multi-byte character", () => {
    expect(fingerprint('Hello, world!', '2.1.281')).toBe('a99');
    expect(fingerprint('hi', '2.1.281')).toBe('d4a');
    const bytes = Buffer.from('帮我看看这段代码哪里有问题', 'utf8');
    const raw = sha256([...Buffer.from('59cf53e54c78'), bytes[4], bytes[7], bytes[20], ...Buffer.from('2.1.281')]).slice(0, 3);
    expect(fingerprint('帮我看看这段代码哪里有问题', '2.1.281')).toBe(raw);
  });

  it('one conversation keeps one session id; another gets another', async () => {
    const id = async (r) => JSON.parse((await run(r, { providers: ['prov_1'] })).body.metadata.user_id).session_id;
    const other = request();
    other.messages[0].content = 'Something else';
    expect(await id(request())).toBe(await id(request()));
    expect(await id(request())).not.toBe(await id(other));
    expect(sessionUuid('seed')).toHaveLength(36);
  });

  it("a request that is already Claude Code's keeps its own system and metadata", async () => {
    const own = [
      { type: 'text', text: 'x-anthropic-billing-header: cc_version=2.1.300.abc; cc_entrypoint=cli;' },
      { type: 'text', text: IDENTITY },
      { type: 'text', text: 'the rest', cache_control: { type: 'ephemeral' } },
    ];
    const { body } = await run({ model: 'm', system: structuredClone(own), metadata: { user_id: 'theirs' }, messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] }, { providers: ['prov_1'] });
    expect(body.system).toEqual(own);
    expect(body.metadata.user_id).toBe('theirs');
  });

  it('no system at all gets one; a missing billing block alone is added in front', async () => {
    const billing = 'x-anthropic-billing-header: cc_version=2.1.281.d4a; cc_entrypoint=cli;';
    const bare = (await run({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }, { providers: ['prov_1'] })).body;
    expect(bare.system.map((b) => b.text)).toEqual([billing, IDENTITY]);
    const only = (await run({ model: 'm', system: [{ type: 'text', text: IDENTITY }], messages: [{ role: 'user', content: 'hi' }] }, { providers: ['prov_1'] })).body;
    expect(only.system.map((b) => b.text)).toEqual([billing, IDENTITY]);
  });

  it('version and betas settings', async () => {
    const { headers, body } = await run(request(), { providers: ['prov_1'], version: '2.2.0', betas: 'claude-code-20250219' });
    expect(headers['User-Agent']).toBe('claude-cli/2.2.0 (external, cli)');
    expect(headers['anthropic-beta']).toBe('claude-code-20250219');
    expect(body.system[0].text).toMatch(/cc_version=2\.2\.0\./);
    expect((await run(request(), { providers: ['prov_1'], version: 'bad' })).headers['User-Agent']).toBe('claude-cli/2.1.281 (external, cli)');
  });

  it('the host profile is stable per channel', async () => {
    const a = (await run(request(), { providers: ['prov_1'] })).headers;
    const b = (await run(request(), { providers: ['prov_1'] })).headers;
    expect(a['X-Stainless-OS']).toBe(b['X-Stainless-OS']);
    expect(a['X-Stainless-Runtime-Version']).toBe(b['X-Stainless-Runtime-Version']);
  });
});

describe('chat', () => {
  it('the identity as the first system message, once; no Anthropic headers', async () => {
    const body = { model: 'm', messages: [{ role: 'system', content: 'Be brief.' }, { role: 'user', content: 'hi' }] };
    const settings = { providers: ['prov_1'], protocol: 'chat' };
    const r = await run(body, settings, upstream('chat'));
    expect(r.out).toBeTruthy();
    expect(r.body.messages[0]).toEqual({ role: 'system', content: IDENTITY });
    expect(r.body.messages[1].content).toBe('Be brief.');
    expect(r.headers['anthropic-version']).toBeUndefined();
    expect(r.headers['User-Agent']).toBe('claude-cli/2.1.281 (external, cli)');
    expect((await run(r.body, settings, upstream('chat'))).out).toBeUndefined();
  });
  it('protocol any covers every API', async () => {
    expect((await run(request(), { providers: ['prov_1'], protocol: 'any' })).out).toBeTruthy();
    expect((await run({ messages: [] }, { providers: ['prov_1'], protocol: 'any' }, upstream('chat'))).out).toBeTruthy();
  });
});
