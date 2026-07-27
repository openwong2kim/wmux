import { beforeEach, describe, expect, it } from 'vitest';
import {
  beginSessionLocationProjection,
  forgetSessionLocation,
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
  it('requires an explicit active binding before accepting delivery', () => {
    expect(rememberSessionLocation('pty-1', snapshot(10, 2, '/new', 'Ubuntu'))).toBe(false);
    expect(getRememberedSessionLocation('pty-1')).toBeUndefined();
  });

  it('stores accepted delivery for an explicitly bound pty', () => {
    expect(beginSessionLocationProjection('pty-1')).toBe(true);
    expect(rememberSessionLocation('pty-1', snapshot(10, 2, '/new', 'Ubuntu'))).toBe(true);
    expect(getRememberedSessionLocation('pty-1')).toEqual(snapshot(10, 2, '/new', 'Ubuntu'));
  });

  it('release prevents delayed delivery from implicitly rebinding', () => {
    beginSessionLocationProjection('pty-1');
    rememberSessionLocation('pty-1', snapshot(10, 1, '/live'));
    forgetSessionLocation('pty-1');
    expect(rememberSessionLocation('pty-1', snapshot(10, 2, '/late'))).toBe(false);
    expect(getRememberedSessionLocation('pty-1')).toBeUndefined();
  });
});
