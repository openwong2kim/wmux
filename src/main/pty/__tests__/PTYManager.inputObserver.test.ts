import { describe, it, expect, vi } from 'vitest';

// Local PTY mode: every write reaches the input observer (workspace settle).
vi.mock('node-pty', () => ({ spawn: vi.fn(), default: { spawn: vi.fn() } }));
import { PTYManager } from '../PTYManager';

describe('PTYManager input observer', () => {
  it('sees each write to a live PTY, and nothing for an unknown id or after clearing', () => {
    const manager = new PTYManager();
    const write = vi.fn();
    (manager as unknown as { instances: Map<string, unknown> }).instances.set('pty-1', { process: { write } });
    const seen: Array<[string, string]> = [];
    manager.setInputObserver((id, data) => seen.push([id, data]));
    manager.write('pty-1', 'ls\r');
    manager.write('pty-missing', 'x');
    manager.setInputObserver(null);
    manager.write('pty-1', 'y');
    expect(write).toHaveBeenCalledTimes(2);
    expect(seen).toEqual([['pty-1', 'ls\r']]);
  });
});
