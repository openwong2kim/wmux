import { describe, expect, it } from 'vitest';
import { PreloadSessionLocationProjection } from '../sessionLocationProjection';
import type { SessionLocationSnapshot } from '../../shared/sessionLocation';

function snapshot(generation: number, revision: number): SessionLocationSnapshot {
  return {
    generation,
    revision,
    location: {
      domain: 'wsl',
      cwd: `/g${generation}/r${revision}`,
      shell: 'wsl.exe',
    },
  };
}

describe('preload session location propagation', () => {
  it('projects response snapshots and replays the accepted value', () => {
    const projection = new PreloadSessionLocationProjection();
    const request = projection.beginDiscovery();
    expect(projection.accept('pty-1', snapshot(4, 1), request)).toBe(true);
    projection.finishDiscovery(request);

    expect(projection.snapshots()).toEqual([['pty-1', snapshot(4, 1)]]);
  });

  it('settled dispose blocks only the closed id in an in-flight list response', () => {
    const projection = new PreloadSessionLocationProjection();
    expect(projection.acceptEvent('closed', snapshot(4, 1))).toBe(true);
    const list = projection.beginDiscovery();

    projection.release('closed');

    expect(projection.accept('closed', snapshot(4, 2), list)).toBe(false);
    expect(projection.accept('live', snapshot(1, 1), list)).toBe(true);
    projection.finishDiscovery(list);
    expect(projection.snapshots()).toEqual([['live', snapshot(1, 1)]]);
  });

  it('authenticated replacement reset fences a pre-reset response', () => {
    const projection = new PreloadSessionLocationProjection();
    const oldRequest = projection.beginDiscovery();
    projection.reset();

    const projected = projection.projectResponse(
      { id: 'pty-1', locationSnapshot: snapshot(100, 1), shell: 'pwsh.exe' },
      oldRequest,
    );
    expect(projected).toEqual({
      response: { id: 'pty-1', locationSnapshot: undefined, shell: 'pwsh.exe' },
      deliverable: false,
    });
    expect(projection.acceptEvent('pty-1', snapshot(1, 1))).toBe(true);
  });

  it('leaves an idless response unchanged and undeliverable', () => {
    const projection = new PreloadSessionLocationProjection();
    const request = projection.beginDiscovery();
    const response = {
      locationSnapshot: undefined,
      success: false,
      error: 'missing session',
    };

    expect(projection.projectResponse(response, request)).toEqual({
      response,
      deliverable: false,
    });
  });

  it('strips a released id from a delayed list response without affecting peers', () => {
    const projection = new PreloadSessionLocationProjection();
    const request = projection.beginDiscovery();
    projection.release('closed');

    expect(projection.projectResponse(
      { id: 'closed', locationSnapshot: snapshot(4, 1) },
      request,
    )).toEqual({
      response: { id: 'closed', locationSnapshot: undefined },
      deliverable: false,
    });
    expect(projection.projectResponse(
      { id: 'live', locationSnapshot: snapshot(1, 1) },
      request,
    )).toEqual({
      response: { id: 'live', locationSnapshot: snapshot(1, 1) },
      deliverable: true,
    });
  });

  it('ordered exact-generation exit releases a closed session', () => {
    const projection = new PreloadSessionLocationProjection();
    expect(projection.acceptEvent('pty-1', snapshot(4, 1))).toBe(true);

    expect(projection.retireAndRelease('pty-1', 4)).toBe(true);
    expect(projection.snapshots()).toEqual([]);
  });

  it('stale exact-generation exit cannot release a newer reused session', () => {
    const projection = new PreloadSessionLocationProjection();
    expect(projection.acceptEvent('pty-1', snapshot(5, 1))).toBe(true);

    expect(projection.retireAndRelease('pty-1', 4)).toBe(false);
    expect(projection.snapshots()).toEqual([['pty-1', snapshot(5, 1)]]);
  });
});
