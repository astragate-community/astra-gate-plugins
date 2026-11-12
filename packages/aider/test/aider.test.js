import { describe, expect, it } from 'vitest';
import { runClient } from '@astragate/plugin-sdk/testing';
import { readFileSync } from 'node:fs';
import plugin, { connect } from '../src/main.js';

const manifest = JSON.parse(readFileSync(new URL('../astra.plugin.json', import.meta.url), 'utf8'));
const gateway = { url: 'http://127.0.0.1:17321', v1: 'http://127.0.0.1:17321/v1', key: 'k-aider' };

describe('the client entry', () => {
  const [client] = manifest.contributes.clients;
  it('describes Aider and where its model goes', () => {
    expect(client).toMatchObject({ id: 'aider', bin: 'aider', config: '~/.aider.conf.yml', format: 'yaml', model: 'model', prefix: 'openai/', ua: ['aider', 'litellm'] });
    expect(client.icon).toMatch(/^https:\/\//);
  });
  it('asks only for the clients permission', () => {
    expect(manifest.permissions).toEqual(['clients']);
  });
});

describe('connect', () => {
  it("writes the gateway's address and key, and silences litellm's model warnings", () => {
    expect(connect({ gateway })).toEqual({
      'openai-api-base': 'http://127.0.0.1:17321/v1',
      'openai-api-key': 'k-aider',
      'show-model-warnings': false,
    });
  });
  it('is what the host calls for the registered client', async () => {
    expect(await runClient(plugin, 'aider', { gateway, model: 'deepseek/deepseek-flash' })).toEqual(connect({ gateway }));
  });
});
