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
  it('exposes the shared lifecycle owner through the main adapter', () => {
    const projection = new DaemonSessionLocationProjection();
    const discovery = projection.beginDiscovery();
    const lease = projection.begin('s1', discovery);
    projection.finishDiscovery(discovery);
    expect(lease).toBeDefined();
    expect(projection.accept('s1', snapshot(4, 2, '/live'), lease!)).toBe(true);
    expect(projection.get('s1')?.location.cwd).toBe('/live');
  });
});
