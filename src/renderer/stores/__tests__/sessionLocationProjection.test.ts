import { beforeEach, describe, expect, it } from 'vitest';
import {
  getRememberedSessionLocation,
  rememberSessionLocation,
  resetSessionLocationProjections,
} from '../sessionLocationProjection';

function snapshot(generation: number, revision: number, cwd: string, distro?: string) {
  return {
    generation,
    revision,
    location: {
      domain: 'wsl' as const,
      cwd,
      shell: 'wsl.exe',
      ...(distro ? { distro } : {}),
    },
  };
}

beforeEach(() => {
  resetSessionLocationProjections();
});

describe('session location projection ordering', () => {
  it('rejects an older snapshot response after a newer pushed event', () => {
    expect(rememberSessionLocation('pty-1', snapshot(10, 2, '/new', 'Ubuntu'))).toBe(true);
    expect(rememberSessionLocation('pty-1', snapshot(10, 1, '/old'))).toBe(false);
    expect(getRememberedSessionLocation('pty-1')).toEqual(snapshot(10, 2, '/new', 'Ubuntu'));
  });

  it('rejects a delayed event from an older reused-id generation', () => {
    expect(rememberSessionLocation('pty-1', snapshot(11, 1, '/new'))).toBe(true);
    expect(rememberSessionLocation('pty-1', snapshot(10, 99, '/old', 'Stale'))).toBe(false);
    expect(getRememberedSessionLocation('pty-1')).toEqual(snapshot(11, 1, '/new'));
  });

  it('accepts a late enrichment in the current generation', () => {
    expect(rememberSessionLocation('pty-1', snapshot(10, 1, '/repo'))).toBe(true);
    expect(rememberSessionLocation('pty-1', snapshot(10, 2, '/repo', 'Ubuntu'))).toBe(true);
    expect(getRememberedSessionLocation('pty-1')?.location).toMatchObject({
      cwd: '/repo',
      distro: 'Ubuntu',
    });
  });
});
