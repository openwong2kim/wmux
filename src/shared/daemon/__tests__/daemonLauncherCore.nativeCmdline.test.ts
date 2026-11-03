// @wmux-lane unit — 'win32' here is the platform the launcher is told it runs on; the native reads, process.kill and execFileSync are all fakes.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * #2992: on Windows the launcher reads a recorded daemon's command line
 * through its process handle, and asks PowerShell's CIM only when that read
 * fails. Where policy or anti-virus stops PowerShell, the CIM read alone
 * left the daemon unverifiable and raised the recovery dialog.
 */
const PID = 424242;
const SCRIPT = 'C:\\Program Files\\wmux\\resources\\daemon-bundle\\index.js';

const probes = vi.hoisted(() => ({
  native: null as string | null,
  cim: null as string | null,
  nativeReads: [] as number[],
  cimReads: 0,
}));

vi.mock('../../../main/pty/winSnapshotNative', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../main/pty/winSnapshotNative')>()),
  readProcessExitState: () => 'running',
  readProcessCommandLine: (pid: number) => {
    probes.nativeReads.push(pid);
    return probes.native;
  },
}));
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return { ...actual, execFileSync: vi.fn((command: string, args: string[]) => {
    if (!args.some((a) => a.includes('Get-CimInstance Win32_Process'))) throw new Error(`unexpected ${command}`);
    probes.cimReads++;
    if (probes.cim === null) throw new Error('PowerShell blocked');
    return probes.cim;
  }) };
});

import { killVerifiedDaemonPidOutcome, staleCleanupOwnerFilter } from '../daemonLauncherCore';

const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;

describe('Windows command-line read for the daemon identity check', () => {
  beforeEach(() => {
    Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
    probes.native = null;
    probes.cim = null;
    probes.nativeReads = [];
    probes.cimReads = 0;
    vi.spyOn(process, 'kill').mockImplementation(() => true);
  });
  afterEach(() => {
    Object.defineProperty(process, 'platform', platform);
    vi.restoreAllMocks();
  });

  it('verifies the daemon from the native read without PowerShell', () => {
    probes.native = `"C:\\Program Files\\wmux\\wmux.exe" "${SCRIPT}"`;
    expect(killVerifiedDaemonPidOutcome(PID, { definitiveOnly: false, scriptCandidates: [SCRIPT] })).toBe('killed');
    expect(probes.nativeReads).toEqual([PID]);
    expect(probes.cimReads).toBe(0);
    expect(process.kill).toHaveBeenCalledWith(PID, 'SIGKILL');
  });

  it('refuses another program from the native read, still without PowerShell', () => {
    probes.native = '"C:\\Tools\\editor.exe" "C:\\notes\\index.js"';
    expect(killVerifiedDaemonPidOutcome(PID, { definitiveOnly: false, scriptCandidates: [SCRIPT] })).toBe('not-daemon');
    expect(probes.cimReads).toBe(0);
    expect(process.kill).not.toHaveBeenCalledWith(PID, 'SIGKILL');
  });

  it('falls back to CIM when the native read fails', () => {
    probes.cim = `"C:\\Program Files\\wmux\\wmux.exe" "${SCRIPT}"`;
    expect(killVerifiedDaemonPidOutcome(PID, { definitiveOnly: false, scriptCandidates: [SCRIPT] })).toBe('killed');
    expect(probes.cimReads).toBe(1);
  });

  it('is unverifiable only when both reads fail', () => {
    expect(killVerifiedDaemonPidOutcome(PID, { definitiveOnly: false, scriptCandidates: [SCRIPT] })).toBe('unverifiable');
    expect(probes.nativeReads).toEqual([PID]);
    expect(probes.cimReads).toBe(1);
  });

  it('lets the stale cleanup skip a reused pid it can read natively', () => {
    const keepsFiles = staleCleanupOwnerFilter('win32', [SCRIPT])!;
    probes.native = '"C:\\Windows\\System32\\notepad.exe"';
    expect(keepsFiles(PID)).toBe(false);
    probes.native = `"C:\\Program Files\\wmux\\wmux.exe" "${SCRIPT}"`;
    expect(keepsFiles(PID)).toBe(true);
    expect(probes.cimReads).toBe(0);
  });
});
