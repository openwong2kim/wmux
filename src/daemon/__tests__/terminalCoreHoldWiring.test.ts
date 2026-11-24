/**
 * R2 (a) — the boot wiring of a session held for a missing terminal core,
 * pinned structurally (house pattern: heldUserShellWiring.test.ts). index.ts
 * runs main() on import, so recoverSessions exists only inside a running
 * daemon; the hold itself is behaviour-tested in terminalCoreMissingHold.test.ts
 * and its retention in StateWriter.test.ts.
 *
 * NOT covered here (needs a running daemon): a real same-boot survivor stopped
 * while the module is missing.
 */
import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import { readSourceText } from '../../test-utils/sourceText';

const daemon = readSourceText(path.join(__dirname, '..', 'index.ts'));
const between = (from: string, to: string, start = 0): string => {
  const a = daemon.indexOf(from, start);
  expect(a, `${from} not found`).toBeGreaterThanOrEqual(0);
  const b = daemon.indexOf(to, a + from.length);
  expect(b, `${to} not found after ${from}`).toBeGreaterThan(a);
  return daemon.slice(a, b);
};

describe('boot recovery with the terminal core missing', () => {
  const recovery = between('async function recoverSessions(', '\n}\n');
  // The hold branch inside the loop (an earlier one at the top only logs).
  const hold = between('if (terminalCoreMissing !== null) {', 'continue;', daemon.indexOf('settleStoredBinding(session);'));

  // CodeRabbit on #3417: a held record is saved suspended, which every later
  // reap skips, so a shell the old daemon left must be stopped before the hold.
  it('stops a same-boot survivor, WSL or not, before the record is held suspended', () => {
    const suspendAt = hold.indexOf("session.state = 'suspended';");
    expect(suspendAt).toBeGreaterThan(0);
    expect(hold.indexOf('if (isWslShell(session.cmd)) await reapWslSurvivor(session);')).toBeGreaterThan(0);
    expect(hold.indexOf('if (isWslShell(session.cmd)) await reapWslSurvivor(session);')).toBeLessThan(suspendAt);
    expect(hold.indexOf('else await leftoverShells.get(session.id);')).toBeLessThan(suspendAt);
    expect(hold.indexOf('sessionManager.holdPendingRecovery(session);')).toBeGreaterThan(suspendAt);
  });

  it('uses the same identity-checked WSL reap as a boot with the module', () => {
    const helper = between('const reapWslSurvivor = async', '};', daemon.indexOf('async function recoverSessions('));
    expect(helper).toMatch(/if \(rebooted \|\| session\.state === 'suspended' \|\| !recoverableIds\.has\(session\.id\)\s+\|\| !leftoverReapEligible\(session, sameBootProven\)\) return;/);
    expect(helper).toMatch(/await reapIfIdentityConfirmed\(\{ pid: session\.pid, cmd: session\.cmd,/);
    const wslBranchAt = recovery.indexOf('if (isWslShell(session.cmd)) {\n      await reapWslSurvivor(session);');
    expect(wslBranchAt).toBeGreaterThan(recovery.indexOf('if (releaseCoreHold(session, Date.now())) changed = true;'));
  });

  it('restarts the retention clocks when the hold ends', () => {
    expect(recovery).toMatch(/if \(releaseCoreHold\(session, Date\.now\(\)\)\) changed = true;/);
  });
});
