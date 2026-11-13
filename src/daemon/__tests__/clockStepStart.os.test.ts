// A recorded process start survives a clock step. On Linux `lstart` is the
// boot time plus the start in clock ticks, and the boot time moves when the
// clock is stepped (NTP), so the same process reads with new text. The
// kernel start, bound to its boot, is kept beside the text and compared
// first when both sides have one; a record without it still matches by text.
import { describe, expect, it, vi } from 'vitest';
import { classifyReapIdentity } from '../phantomExit';
import { captureTreePosix, matchesRecordedStart, recordedRootMatcher, type PosixProcRow, type PosixTreeDeps } from '../automation/verifiedTreeKill';
import { currentBootId, kernelStartOf, sameKernelStart } from '../../shared/processStartTime';
import { snapshotTree, stillHeld, type HeadlessProcDeps } from '../a2aRemote/headlessProcs';
import { coerceHeadlessStart } from '../a2aRemote/headlessStartStore';

const AT = 'Fri Nov 13 07:05:07 2026';
const STEPPED = 'Fri Nov 13 07:05:09 2026'; // the same process after the boot time moved 2 s
const BOOT = '0f6c1d2e-3a4b-4c5d-8e9f-0123456789ab';
const OTHER_BOOT = '7d1e2f30-4b5c-4d6e-9f80-123456789abc';
const K = `${BOOT}:2154321`;

describe('boot-bound kernel starts', () => {
  it('match within one boot, never across boots, and say nothing when one is missing', () => {
    expect(sameKernelStart(K, `${BOOT}:2154321`)).toBe(true);
    expect(sameKernelStart(K, `${BOOT}:2154322`)).toBe(false);
    // Same pid, equal ticks, different boot: another process.
    expect(sameKernelStart(K, `${OTHER_BOOT}:2154321`)).toBe(false);
    expect(sameKernelStart(K, null)).toBeNull();
    expect(sameKernelStart(undefined, K)).toBeNull();
  });

  it.runIf(process.platform === 'linux' || process.platform === 'darwin')('are read for a live process on this boot', () => {
    expect(currentBootId()).toMatch(/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);
    const mine = kernelStartOf(process.pid);
    expect(mine?.startsWith(`${currentBootId()}:`)).toBe(true);
    expect(sameKernelStart(mine, kernelStartOf(process.pid))).toBe(true);
  });
});

describe.skipIf(process.platform === 'win32')('a recorded start across a clock step', () => {
  it('reap identity: the same process after a 2 s step is confirmed; a reused pid, another boot and an old record behave', () => {
    const base = { looksLikeOurShell: false, storedStartTime: AT };
    expect(classifyReapIdentity({ ...base, storedStartKernel: K, currentStartTime: STEPPED, currentStartKernel: K })).toBe('start-time');
    expect(classifyReapIdentity({ ...base, storedStartKernel: K, currentStartTime: AT, currentStartKernel: `${BOOT}:9999999` })).toBe('unconfirmed');
    expect(classifyReapIdentity({ ...base, storedStartKernel: K, currentStartTime: AT, currentStartKernel: `${OTHER_BOOT}:2154321` })).toBe('unconfirmed');
    // A record without a kernel start (from before): by text, as it was.
    expect(classifyReapIdentity({ ...base, currentStartTime: AT, currentStartKernel: K })).toBe('start-time');
    expect(classifyReapIdentity({ ...base, currentStartTime: STEPPED, currentStartKernel: K })).toBe('unconfirmed');
  });

  it('a pane tree kill takes the same process after a step and logs one warning for another', async () => {
    const deps = (kernel: string | null): PosixTreeDeps => ({
      listProcesses: async (): Promise<PosixProcRow[]> => [{ pid: 100, ppid: 1, stat: 'S', start: STEPPED }],
      signal: () => undefined,
      kernelStart: () => kernel,
    });
    const warn = vi.fn();

    const same = await captureTreePosix(100, deps(K), { rootIsOurs: recordedRootMatcher(100, AT, warn, K) });
    expect(same?.pids()).toEqual([100]);
    same?.release();
    expect(warn).not.toHaveBeenCalled();

    const reused = `${BOOT}:2154999`;
    expect(await captureTreePosix(100, deps(reused), { rootIsOurs: recordedRootMatcher(100, AT, warn, K) })).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    const line = warn.mock.calls[0][0] as string;
    for (const part of ['pid 100', AT, STEPPED, K, reused]) expect(line).toContain(part);

    // Another boot, equal ticks: not ours either.
    expect(await captureTreePosix(100, deps(`${OTHER_BOOT}:2154321`), { rootIsOurs: recordedRootMatcher(100, AT, warn, K) })).toBeNull();
  });

  it('a record without a kernel start matches by text', () => {
    expect(matchesRecordedStart(AT, AT, { current: K })).toBe(true);
    expect(matchesRecordedStart('Fri Nov  3 07:05:07 2026', 'Fri Nov 3 07:05:07 2026', { current: K })).toBe(true);
    expect(matchesRecordedStart(AT, STEPPED, { current: K })).toBe(false);
  });
});

describe.skipIf(process.platform === 'win32')('a headless record across a clock step', () => {
  it('keeps the same process held after a step, lets a reused pid or another boot go', async () => {
    const deps = (start: string, kernel: string | null): HeadlessProcDeps => ({
      listProcesses: async () => [{ pid: 200, ppid: 1, stat: 'S', start }],
      procRoot: '/nonexistent-proc-for-test',
      kernelStart: () => kernel,
    });
    const snap = (await snapshotTree(200, deps(AT, K))) ?? [];
    expect(snap).toEqual([expect.objectContaining({ pid: 200, startTime: AT, startKernel: K })]);
    expect(await stillHeld(snap, '/tmp/worktree', deps(STEPPED, K))).toHaveLength(1);
    expect(await stillHeld(snap, '/tmp/worktree', deps(AT, `${BOOT}:2154999`))).toEqual([]);
    expect(await stillHeld(snap, '/tmp/worktree', deps(AT, `${OTHER_BOOT}:2154321`))).toEqual([]);
  });

  it('stores the kernel start beside the text, and loads a record without it', () => {
    const base = {
      v: 1, hostId: '0f1e2d3c-4b5a-4968-8776-655443322110', spawnId: 'sp-0f6c1d2e-3a4b-4c5d-8e9f-0123456789ab', agent: 'claude', repoPath: '/repo',
      sessionId: 'hl-0f6c1d2e-3a4b-4c5d-8e9f-0123456789ab', workspaceId: 'hl-ws', agentSessionId: '0f6c1d2e-3a4b-4c5d-8e9f-0123456789ab',
      lineage: 'remote-spawn:x', runId: 'run-1', phase: 'created', rootPid: 4242, rootStart: AT, startedAt: '2026-11-13T00:00:00.000Z',
    };
    const withKernel = coerceHeadlessStart({ ...base, rootStartKernel: K, survivors: [{ pid: 7, reason: 'did not exit', startTime: AT, startKernel: K }] });
    expect(withKernel).toMatchObject({ rootStart: AT, rootStartKernel: K, survivors: [{ startTime: AT, startKernel: K }] });
    const old = coerceHeadlessStart(base);
    expect(old).toMatchObject({ rootStart: AT });
    expect(old).not.toHaveProperty('rootStartKernel');
    expect(coerceHeadlessStart({ ...base, rootStartKernel: 'not a kernel start' })).toBeNull();
  });
});
