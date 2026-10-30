// Main's launch writers ask the daemon once before they type: a folder-trust
// prompt on screen always stops them, a screen that cannot rule one out stops
// only an automated line, and no verdict to have types as before.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { daemonFolderTrustReading, daemonFolderTrustVerdict, folderTrustLaunchHold, folderTrustLaunchRefusal, forgetFolderTrustPane } from '../folderTrustCheck';
import { FOLDER_TRUST_LAUNCH_REFUSAL } from '../../shared/folderTrustWording';
import type { DaemonClient } from '../DaemonClient';

type Answer = Awaited<ReturnType<DaemonClient['folderTrustState']>>;
const daemon = (answer: Answer) => ({ folderTrustState: vi.fn(async () => answer) });

afterEach(() => vi.restoreAllMocks());

describe('folderTrustLaunchRefusal', () => {
  it('refuses at a folder-trust prompt whoever types, with one log line naming the writer and the verdict', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const dc = daemon({ state: 'trust' });
    expect(await folderTrustLaunchRefusal(dc, 'pty-1', 'launch line', { refuseUnknown: false })).toBe(FOLDER_TRUST_LAUNCH_REFUSAL);
    expect(await folderTrustLaunchRefusal(dc, 'pty-1', 'auto-resume line', { refuseUnknown: true })).toBe(FOLDER_TRUST_LAUNCH_REFUSAL);
    expect(dc.folderTrustState).toHaveBeenCalledWith('pty-1', 400);
    expect(warn.mock.calls.map((c) => c[0])).toEqual([
      '[folder-trust] refused launch line on pane pty-1: folder-trust trust',
      '[folder-trust] refused auto-resume line on pane pty-1: folder-trust trust',
    ]);
  });

  it('refuses an unreadable screen only for an automated line, and types as before with no verdict', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const unknown = daemon({ state: 'unknown' });
    expect(await folderTrustLaunchRefusal(unknown, 'pty-1', 'auto-resume line', { refuseUnknown: true })).toMatch(/folder-trust prompt cannot be ruled out/);
    expect(await folderTrustLaunchRefusal(unknown, 'pty-1', 'launch line', { refuseUnknown: false })).toBeNull();
    expect(await folderTrustLaunchRefusal(daemon({ state: 'clear' }), 'pty-1', 'auto-resume line', { refuseUnknown: true })).toBeNull();
    expect(await folderTrustLaunchRefusal(daemon({ unavailable: 'timeout' }), 'pty-1', 'auto-resume line', { refuseUnknown: true })).toBeNull();
    expect(await folderTrustLaunchRefusal(null, 'pty-1', 'auto-resume line', { refuseUnknown: true })).toBeNull();
    expect(await folderTrustLaunchRefusal(daemon({ state: 'unknown', reason: 'unseen-cells' }), 'pty-1', 'auto-resume line', { refuseUnknown: true }))
      .toMatch(/folder-trust prompt cannot be ruled out/);
    expect(warn.mock.calls.map((c) => c[0])).toEqual([
      '[folder-trust] refused auto-resume line on pane pty-1: folder-trust unknown',
      '[folder-trust] check unavailable on pane pty-1: timeout',
      // The daemon's reason tag, when it sent one.
      '[folder-trust] refused auto-resume line on pane pty-1: folder-trust unknown (unseen-cells)',
    ]);
  });
});

describe('daemonFolderTrustReading', () => {
  it("names a caller's read budget to the daemon and waits past it; the default names none", async () => {
    const dc = daemon({ state: 'clear' });
    await daemonFolderTrustReading(dc, 'pty-1', { budgetMs: 1000 });
    await daemonFolderTrustReading(dc, 'pty-1');
    expect(dc.folderTrustState.mock.calls).toEqual([['pty-1', 1150, 1000], ['pty-1', 400]]);
  });

  it('a launch line no person waits on names its budget; a person\'s line keeps the default', async () => {
    const dc = daemon({ state: 'clear' });
    expect(await folderTrustLaunchHold(dc, 'pty-1', 'startup line', { refuseUnknown: true, budgetMs: 1000 })).toBeNull();
    expect(await folderTrustLaunchRefusal(dc, 'pty-1', 'launch line', { refuseUnknown: false })).toBeNull();
    expect(dc.folderTrustState.mock.calls).toEqual([['pty-1', 1150, 1000], ['pty-1', 400]]);
  });
});

describe('the per-pane log memory', () => {
  it('a retrying writer logs a refusal once while it holds, and a pane that ended is forgotten', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const trust = daemon({ state: 'trust' });
    for (let i = 0; i < 3; i++) await folderTrustLaunchRefusal(trust, 'pty-9', 'startup line', { refuseUnknown: true, once: true });
    const gone = daemon({ unavailable: 'daemon not connected' });
    await daemonFolderTrustVerdict(gone, 'pty-9');
    await daemonFolderTrustVerdict(gone, 'pty-9');
    expect(warn).toHaveBeenCalledTimes(2);
    // The session died: the next refusal and the next unavailable check are logged again.
    forgetFolderTrustPane('pty-9');
    await folderTrustLaunchRefusal(trust, 'pty-9', 'startup line', { refuseUnknown: true, once: true });
    await daemonFolderTrustVerdict(gone, 'pty-9');
    expect(warn).toHaveBeenCalledTimes(4);
  });
});
