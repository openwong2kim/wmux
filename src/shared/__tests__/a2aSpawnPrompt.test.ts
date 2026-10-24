// finalizeSpawnPrompt is what main re-runs before a spawn prompt leaves: it
// must be a fixed point, or main would refuse a prompt the dialog showed.
import { describe, expect, it } from 'vitest';
import { finalizeSpawnPrompt } from '../a2aSpawnPrompt';

/** A small seeded generator, so a failure is the same on every run. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('finalizeSpawnPrompt', () => {
  it('a commit after a masked value next to a key word stays as the first pass left it', () => {
    const sha = '3e5deed29bd61c27089ac217e5703e512c238453';
    const text = `api token-${sha}- ${sha}`;
    const once = finalizeSpawnPrompt(text).text;
    expect(once).toBe(`api token-[redacted]- ${sha}`);
    expect(finalizeSpawnPrompt(once).text).toBe(once);
  });

  it('is a fixed point on mixed input: keys, hex, URLs, paths, wmux lines, bidi', () => {
    const rand = prng(2694);
    const hex = (n: number) => Array.from({ length: n }, () => '0123456789abcdef'[Math.floor(rand() * 16)]).join('');
    const b64 = (n: number) => Array.from({ length: n }, () => 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'[Math.floor(rand() * 64)]).join('');
    const atoms = () => [hex(32), hex(40), hex(40), b64(24), 'feat/p1-7-x-v2', 'api token', 'Bearer', 'postgres://u:p@h/x', `https://${b64(16).replace(/[+/]/g, 'x')}@h`,
      '[wmux] x', '[redacted]', '?access_token=abc', '"', ',', '/', '-', `sk-${hex(24)}`, '\n', ' ', 'a@b', '\u202E', 'C:\\Users\\k'];
    const seps = ['', ' ', '-', '/', '.', '\n'];
    const failures: string[] = [];
    for (let i = 0; i < 3000; i++) {
      const pool = atoms();
      let s = '';
      for (let j = 0; j < 12; j++) s += pool[Math.floor(rand() * pool.length)] + seps[Math.floor(rand() * seps.length)];
      const once = finalizeSpawnPrompt(s).text;
      if (finalizeSpawnPrompt(once).text !== once) failures.push(s);
    }
    expect(failures).toEqual([]);
  });
});
