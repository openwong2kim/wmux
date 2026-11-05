import { describe, expect, it } from 'vitest';
import { recheckDaemonBeforeKill } from '../daemonLauncherCore';

// Right before the kill that follows the launcher's wait on an unanswering
// daemon: the pid's command line is read again, since up to a minute and a
// half has passed since it was verified.
describe('recheckDaemonBeforeKill', () => {
  const candidates = ['/Applications/wmux.app/Contents/Resources/app.asar/dist/daemon/index.js'];
  const daemonArgv = ['/Applications/wmux.app/Contents/MacOS/wmux', candidates[0]];

  it('the daemon still at its pid is killed', () => {
    expect(recheckDaemonBeforeKill({ exited: () => false, argv: () => daemonArgv, candidates })).toBe('daemon');
  });

  it('another process at the pid now is not', () => {
    expect(recheckDaemonBeforeKill({ exited: () => false, argv: () => ['/usr/bin/vim', 'notes.txt'], candidates })).toBe('other');
  });

  it('a pid whose command line cannot be read is unverified, unless it has exited meanwhile', () => {
    expect(recheckDaemonBeforeKill({ exited: () => false, argv: () => null, candidates })).toBe('unverified');
    let checks = 0;
    expect(recheckDaemonBeforeKill({ exited: () => ++checks > 1, argv: () => null, candidates })).toBe('exited');
    expect(recheckDaemonBeforeKill({ exited: () => true, argv: () => daemonArgv, candidates })).toBe('exited');
  });
});
