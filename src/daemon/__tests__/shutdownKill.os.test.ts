import { describe, it, expect } from 'vitest';
import { isShutdownKillExit, SHUTDOWN_KILL_EXIT_CODE } from '../shutdownKill';

// Reboot-reattach RCA 2026-07-02: Windows kills PTY children with
// DBG_TERMINATE_PROCESS (0x40010004) at shutdown/logoff BEFORE the daemon
// dies. Those exits must classify as involuntary (→ suspend for recovery),
// while ordinary shell exits must keep the normal death flow.
describe('isShutdownKillExit', () => {
  const win = (exitCode: number | null, shuttingDown = false) =>
    isShutdownKillExit(exitCode, { platform: 'win32', shuttingDown });

  it('matches the observed incident signature: win32 + 0x40010004', () => {
    expect(SHUTDOWN_KILL_EXIT_CODE).toBe(1073807364); // the exact code in the incident log
    expect(win(1073807364)).toBe(true);
  });

  it('voluntary shell exits are NOT shutdown kills', () => {
    expect(win(0)).toBe(false); // `exit`
    expect(win(1)).toBe(false); // error exit / taskkill
    expect(win(null)).toBe(false); // no code recorded
    expect(win(-1073741502)).toBe(false); // 0xC0000142 — spawn-during-shutdown corpse, already dead-on-arrival
  });

  it('the Windows code does not classify on posix (different teardown semantics)', () => {
    expect(isShutdownKillExit(1073807364, { platform: 'linux', shuttingDown: false })).toBe(false);
    expect(isShutdownKillExit(1073807364, { platform: 'darwin', shuttingDown: false })).toBe(false);
  });

  it('ANY exit during our own graceful shutdown is involuntary (posix SIGTERM fan-out race)', () => {
    expect(isShutdownKillExit(0, { platform: 'linux', shuttingDown: true })).toBe(true);
    expect(isShutdownKillExit(143, { platform: 'darwin', shuttingDown: true })).toBe(true);
    expect(win(0, true)).toBe(true);
  });
});
