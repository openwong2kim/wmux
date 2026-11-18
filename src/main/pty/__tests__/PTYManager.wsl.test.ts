import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
const { spawn } = vi.hoisted(() => ({ spawn: vi.fn(() => ({ pid: 4242, kill() {} })) }));
vi.mock('../../../shared/terminalPty', async (importOriginal) => (await import('../../../test-utils/ptyTransportStub')).routeSpawnToNodePtyMock(importOriginal));
vi.mock('node-pty', () => ({ spawn, default: { spawn } }));
import { PTYManager } from '../PTYManager';

describe('local PTY launch arguments', () => {
  // This test checks node-pty's arguments; pin the engine, since Rust is the
  // Windows default where the native core is built.
  const savedCore = process.env.WMUX_TERMINAL_CORE;
  beforeEach(() => { process.env.WMUX_TERMINAL_CORE = 'node'; });
  afterEach(() => {
    if (savedCore === undefined) delete process.env.WMUX_TERMINAL_CORE;
    else process.env.WMUX_TERMINAL_CORE = savedCore;
  });

  it('preserves native shell arguments before integration arguments', () => {
    const manager = new PTYManager();
    vi.spyOn(manager, 'buildHookInjection').mockReturnValue({ args: ['--rcfile', '/hook'], env: {} });
    try {
      manager.create({ shell: '/bin/bash', shellArgs: ['--noprofile'] });
      expect(spawn).toHaveBeenCalledWith('/bin/bash', ['--noprofile', '--rcfile', '/hook'], expect.any(Object));
    } finally { manager.disposeAll(); }
  });
});
