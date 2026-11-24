import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateRustSnapshot } from '../RustSnapshot';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-native-abi-'));
// CI names the built core in WMUX_TERMINAL_CORE_MODULE, which nativeCorePath reads first: unset it so the stubbed file is the module.
beforeEach(() => { vi.stubEnv('WMUX_TERMINAL_CORE_MODULE', undefined); });
afterEach(() => vi.unstubAllEnvs());
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

it.each(['missing', 'different'])('rejects a %s native ABI before constructing a terminal', async name => {
  const file = path.join(dir, `${name}.cjs`);
  fs.writeFileSync(file, `module.exports = {
    ${name === 'different' ? 'nativeCoreAbiVersion: () => 99,' : ''}
    NativeTerminal: class { constructor() { throw new Error('must not construct'); } }
  };`);
  vi.stubEnv('WMUX_RUST_SNAPSHOT_MODULE', file);
  expect(await generateRustSnapshot({ cols: 80, rows: 24, initial: Buffer.from('hello') }, 'text'))
    .toMatchObject({ ok: false, reason: 'error', detail: expect.stringContaining('ABI mismatch') });
});


it('refuses an older ANSI serializer before constructing a terminal', async () => {
  const file = path.join(dir, 'old-ansi.cjs');
  fs.writeFileSync(file, `module.exports = {
    nativeCoreAbiVersion: () => 1,
    nativeCoreCapabilities: () => ['text-v1'],
    NativeTerminal: class { constructor() { throw new Error('must not construct'); } }
  };`);
  vi.stubEnv('WMUX_RUST_SNAPSHOT_MODULE', file);
  expect(await generateRustSnapshot({ cols: 80, rows: 24, initial: Buffer.from('\x1b[5mblink') }, 'ansi'))
    .toMatchObject({ ok: false, reason: 'error', detail: expect.stringContaining('ANSI capability missing') });
});

// #3440: generateRustSnapshot reports a refused allocation by the error's code
// (allocFailed), so the backends never read it from the text of `detail`.
it.each([
  ['a coded refusal with an empty message', `Object.assign(new Error(''), { code: 'ALLOC_FAILED' })`, { detail: 'ALLOC_FAILED', allocFailed: true }],
  ['a coded refusal with a message', `Object.assign(new Error('ALLOC_FAILED: could not allocate 64 bytes for grid'), { code: 'ALLOC_FAILED' })`, { detail: 'ALLOC_FAILED: could not allocate 64 bytes for grid', allocFailed: true }],
  ['an "ALLOC_FAILED:" message without the code', `new Error('ALLOC_FAILED: could not allocate 64 bytes for grid')`, { detail: 'ALLOC_FAILED: could not allocate 64 bytes for grid' }],
])('turns %s into an error outcome', async (name, thrown, expected) => {
  const file = path.join(dir, `alloc-${name.replace(/[^a-z]+/gi, '-')}.cjs`);
  fs.writeFileSync(file, `module.exports = {
    nativeCoreAbiVersion: () => 1,
    nativeCoreCapabilities: () => ['text-v1', 'ansi-v3'],
    NativeTerminal: class { constructor() { throw ${thrown}; } }
  };`);
  vi.stubEnv('WMUX_RUST_SNAPSHOT_MODULE', file);
  for (const kind of ['text', 'ansi'] as const) {
    const out = await generateRustSnapshot({ cols: 80, rows: 24, initial: Buffer.from('hello') }, kind as 'text');
    expect(out).toEqual({ ok: false, reason: 'error', ...expected });
  }
});
