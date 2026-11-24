import { afterEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';

vi.mock('../../shared/terminalCoreSettings', () => ({ terminalCoreSelection: () => 'node' }));
import { warmRustSnapshot } from '../RustSnapshot';

afterEach(() => vi.unstubAllEnvs());

describe('warmRustSnapshot (#3440)', () => {
  it('never throws at daemon start when no native snapshot module can load', () => {
    vi.stubEnv('WMUX_RUST_SNAPSHOT_MODULE', '');
    expect(() => warmRustSnapshot()).not.toThrow();
  });
  it('never throws for a module path that does not exist', () => {
    vi.stubEnv('WMUX_RUST_SNAPSHOT_MODULE', path.resolve('no-such-dir', 'core.node'));
    expect(() => warmRustSnapshot()).not.toThrow();
  });
});
