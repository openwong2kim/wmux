import { describe, expect, it } from 'vitest';
import {
  daemonSessionCommandTarget,
  daemonSessionLocation,
} from '../sessionCommandTarget';

describe('daemon session location accessors', () => {
  it('constructs a WSL command target from the durable record', () => {
    const location = {
      domain: 'wsl' as const,
      cwd: '/home/me/repo',
      shell: 'wsl.exe',
      distro: 'Ubuntu',
    };
    expect(daemonSessionCommandTarget({ id: 'session-1', location })).toEqual({
      sessionId: 'session-1',
      location,
      activeContext: {
        sessionId: 'session-1',
        active: true,
        distro: 'Ubuntu',
      },
    });
  });

  it('refuses a live record that bypassed normalization', () => {
    expect(() => daemonSessionLocation({ id: 'legacy' })).toThrow(
      "Session 'legacy' has no normalized location",
    );
  });
});
