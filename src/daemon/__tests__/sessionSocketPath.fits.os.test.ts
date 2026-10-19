// The test HOME must leave room for unix session sockets. sun_path holds 104
// bytes on macOS (108 on Linux) and bind(2) does not refuse a longer path: it
// binds the first 103 bytes. Under macOS's os.tmpdir() the path
// `<HOME>/.wmux-vitest/session-modepre-<8 hex>.sock` was 116 bytes, so the
// unique suffix was cut off and two SessionPipes bound at once collided with
// EADDRINUSE (SessionPipe.modePreamble, SessionPipe.attachSnapshot on macos-14).
import { describe, expect, it } from 'vitest';
import { getSessionSocketPath } from '../../shared/constants';

describe.skipIf(process.platform === 'win32')('session socket paths under the test HOME', () => {
  it('fit the 103-byte macOS sun_path with the longest test session id', () => {
    // Longest id the daemon tests use, plus headroom for a UUID-sized one.
    for (const id of ['attsnap-queued-1e7f80a5', '00000000-0000-0000-0000-000000000000-extra']) {
      expect(Buffer.byteLength(getSessionSocketPath(id))).toBeLessThanOrEqual(103);
    }
  });
});
