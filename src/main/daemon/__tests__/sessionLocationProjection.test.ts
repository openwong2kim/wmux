import { describe, expect, it } from 'vitest';
import { DaemonSessionLocationProjection } from '../../daemonSessionLocationProjection';
import type { SessionLocationSnapshot } from '../../../shared/sessionLocation';

function snapshot(generation: number, revision: number, cwd: string): SessionLocationSnapshot {
  return {
    generation,
    revision,
    location: { domain: 'wsl', cwd, shell: 'wsl.exe' },
  };
}

describe('main daemon session location projection', () => {
  it('rejects an older RPC response after a newer event', () => {
    const projection = new DaemonSessionLocationProjection();
    expect(projection.accept('s1', snapshot(4, 2, '/new'))).toBe(true);
    expect(projection.accept('s1', snapshot(4, 1, '/old'))).toBe(false);
    expect(projection.get('s1')?.location.cwd).toBe('/new');
  });

  it('accepts lower generations after daemon replacement reset', () => {
    const projection = new DaemonSessionLocationProjection();
    projection.accept('s1', snapshot(100, 1, '/old-daemon'));
    projection.reset();
    expect(projection.accept('s1', snapshot(1, 1, '/replacement'))).toBe(true);
  });
});
