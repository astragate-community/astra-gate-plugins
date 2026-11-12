import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { sha256 } from '../src/sha256.js';

const node = (data) => createHash('sha256').update(typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data)).digest('hex');

describe('sha256', () => {
  it('agrees with node:crypto on strings of every length around the block edges, and on non-ASCII text', () => {
    for (let n = 0; n < 200; n++) expect(sha256('a'.repeat(n))).toBe(node('a'.repeat(n)));
    for (const s of ['', 'abc', '帮我看看这段代码', 'emoji 😀 mix', 'astra-claude-device::prov_1']) expect(sha256(s)).toBe(node(s));
  });
  it('hashes a list of raw bytes, also ones that are not valid UTF-8', () => {
    for (const b of [[], [0], [255, 254, 253], Array.from({ length: 300 }, (_, i) => (i * 7) % 256)]) expect(sha256(b)).toBe(node(b));
  });
});
