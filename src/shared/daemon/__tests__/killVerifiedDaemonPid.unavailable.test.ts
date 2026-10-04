import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';

const probes = vi.hoisted(() => ({ image: '' as string | null, argv: null as string | null, imageReads: 0 }));
function readImage(): string {
  probes.imageReads++;
  if (probes.image === null) throw new Error('Process image lookup unavailable');
  return probes.image;
}
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return { ...actual, execFileSync: vi.fn((command: string, args: string[]) => {
    if (command.endsWith('tasklist.exe')) return `"${readImage()}","424242","Console","1","1 K"`;
    if (args.includes('comm=')) return readImage();
    if (probes.argv === null) throw new Error('Process command-line lookup unavailable');
    return probes.argv;
  }) };
});
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return { ...actual, readFileSync: vi.fn((file: string, ...args: unknown[]) => {
    if (file === '/proc/424242/comm') return readImage();
    if (file === '/proc/424242/cmdline') {
      if (probes.argv === null) throw new Error('Process command-line lookup unavailable');
      return probes.argv;
    }
    return Reflect.apply(actual.readFileSync, actual, [file, ...args]);
  }) };
});

import { describeDaemonKillOutcome, killVerifiedDaemonPid, killVerifiedDaemonPidOutcome } from '../daemonLauncherCore';

describe('killVerifiedDaemonPid — unavailable command line', () => {
  beforeEach(() => {
    probes.image = path.basename(process.execPath);
    probes.argv = null;
    probes.imageReads = 0;
    // No real PID is signalled by these failure-injection tests.
    vi.spyOn(process, 'kill').mockReturnValue(true);
  });
  afterEach(() => vi.restoreAllMocks());

  it.each([false, true])('refuses a matching image without script identity (definitiveOnly=%s)', (definitiveOnly) => {
    expect(killVerifiedDaemonPid(424242, { definitiveOnly })).toBe(false);
    expect(process.kill).not.toHaveBeenCalledWith(424242, 'SIGKILL');
  });

  it('also refuses an empty command-line response', () => {
    probes.argv = '';
    expect(killVerifiedDaemonPid(424242, { definitiveOnly: false })).toBe(false);
    expect(process.kill).not.toHaveBeenCalledWith(424242, 'SIGKILL');
  });

  it.each([false, true])('still signals a verified script (definitiveOnly=%s)', (definitiveOnly) => {
    probes.argv = verifiedArgv();
    expect(killVerifiedDaemonPid(424242, { definitiveOnly })).toBe(true);
    expect(process.kill).toHaveBeenCalledWith(424242, 'SIGKILL');
  });

  it.each([false, true])('requires script identity for a different host image (definitiveOnly=%s)', (definitiveOnly) => {
    probes.image = 'other-host-node';
    expect(killVerifiedDaemonPid(424242, { definitiveOnly })).toBe(false);
    expect(process.kill).not.toHaveBeenCalledWith(424242, 'SIGKILL');

    probes.argv = verifiedArgv();
    expect(killVerifiedDaemonPid(424242, { definitiveOnly })).toBe(true);
    expect(process.kill).toHaveBeenCalledWith(424242, 'SIGKILL');
  });

  // On Windows the liveness probe is the same tasklist call, so it reads
  // `unknown` here; unknown liveness still proceeds to the identity checks.
  it('relaxed mode signals a verified script even when the image lookup is unavailable', () => {
    probes.image = null;
    probes.argv = verifiedArgv();
    expect(killVerifiedDaemonPid(424242, { definitiveOnly: false })).toBe(true);
    expect(process.kill).toHaveBeenCalledWith(424242, 'SIGKILL');
  });

  it('strict mode refuses a verified script when the image lookup is unavailable', () => {
    probes.image = null;
    probes.argv = verifiedArgv();
    expect(killVerifiedDaemonPid(424242, { definitiveOnly: true })).toBe(false);
    expect(process.kill).not.toHaveBeenCalledWith(424242, 'SIGKILL');
  });

  // The same probes also serve liveness (tasklist on Windows) and the
  // command line (`ps -o comm=` on macOS), so compare the two modes instead
  // of expecting zero reads.
  it('relaxed mode skips the image lookup that strict mode performs', () => {
    probes.argv = verifiedArgv();
    expect(killVerifiedDaemonPid(424242, { definitiveOnly: true })).toBe(true);
    const strictReads = probes.imageReads;
    probes.imageReads = 0;
    expect(killVerifiedDaemonPid(424242, { definitiveOnly: false })).toBe(true);
    expect(probes.imageReads).toBe(strictReads - 1);
  });

  // The before-quit backstop logs this outcome, so a refused, possibly live
  // daemon must not read like one that is already gone.
  it('reports why a kill was refused', () => {
    expect(killVerifiedDaemonPidOutcome(424242, { definitiveOnly: false })).toBe('unverifiable');
    probes.image = null;
    probes.argv = verifiedArgv();
    expect(killVerifiedDaemonPidOutcome(424242, { definitiveOnly: true })).toBe('unverifiable');
    probes.image = path.basename(process.execPath);
    probes.argv = unrelatedArgv();
    expect(killVerifiedDaemonPidOutcome(424242, { definitiveOnly: false })).toBe('not-daemon');
    expect(killVerifiedDaemonPidOutcome(-1, { definitiveOnly: false })).toBe('dead');
    expect(process.kill).not.toHaveBeenCalledWith(424242, 'SIGKILL');

    probes.argv = verifiedArgv();
    expect(killVerifiedDaemonPidOutcome(424242, { definitiveOnly: false })).toBe('killed');
    expect(process.kill).toHaveBeenCalledWith(424242, 'SIGKILL');
  });

  it('reports a verified kill whose signal throws as failed', () => {
    probes.argv = verifiedArgv();
    vi.mocked(process.kill).mockImplementation((_pid, signal) => {
      if (signal === 'SIGKILL') throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
      return true;
    });
    expect(killVerifiedDaemonPidOutcome(424242, { definitiveOnly: false })).toBe('failed');
  });

  it('describes an unverifiable refusal as a daemon that may still be running', () => {
    expect(describeDaemonKillOutcome('unverifiable')).toMatch(/may still be running/);
    expect(describeDaemonKillOutcome('dead')).not.toBe(describeDaemonKillOutcome('unverifiable'));
  });
});

function unrelatedArgv(): string {
  if (process.platform === 'linux') return `${process.execPath}\0/test/someone-elses-app/index.js\0`;
  if (process.platform === 'win32') return `"${process.execPath}" /test/someone-elses-app/index.js`;
  return `${process.execPath} /test/someone-elses-app/index.js`;
}

// The command line each platform's probe returns for a verified daemon:
// NUL-separated /proc cmdline on Linux, the quoted CIM string on Windows,
// and the unquoted space-joined `ps -o command=` line on macOS.
function verifiedArgv(): string {
  if (process.platform === 'linux') return `${process.execPath}\0/test/daemon-bundle/index.js\0`;
  if (process.platform === 'win32') return `"${process.execPath}" /test/daemon-bundle/index.js`;
  return `${process.execPath} /test/daemon-bundle/index.js`;
}
