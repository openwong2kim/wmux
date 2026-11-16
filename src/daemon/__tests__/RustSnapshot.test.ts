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
