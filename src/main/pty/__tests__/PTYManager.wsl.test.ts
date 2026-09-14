import { describe, it, expect, vi } from 'vitest';
const { spawn } = vi.hoisted(() => ({ spawn: vi.fn(() => ({ pid: 0, kill() {} })) }));
vi.mock('node-pty', () => ({ spawn, default: { spawn } }));
import { PTYManager } from '../PTYManager';

describe('local PTY launch arguments', () => {
  it('preserves native shell arguments before integration arguments', () => {
    const manager = new PTYManager();
    vi.spyOn(manager, 'buildHookInjection').mockReturnValue({ args: ['--rcfile', '/hook'], env: {} });
    try {
      manager.create({ shell: '/bin/bash', shellArgs: ['--noprofile'] });
      expect(spawn).toHaveBeenCalledWith('/bin/bash', ['--noprofile', '--rcfile', '/hook'], expect.any(Object));
    } finally { manager.disposeAll(); }
  });
});
