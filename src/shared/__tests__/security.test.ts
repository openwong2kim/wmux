import * as path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fsMock = vi.hoisted(() => ({
  existsSync: vi.fn(),
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
  readFileSync: vi.fn(),
  renameSync: vi.fn(),
  rmSync: vi.fn(),
  unlinkSync: vi.fn(),
  chmodSync: vi.fn(),
  promises: {
    chmod: vi.fn(),
    readFile: vi.fn(),
    writeFile: vi.fn(),
    rename: vi.fn(),
    rm: vi.fn(),
  },
}));

const execFileSyncMock = vi.hoisted(() => vi.fn());
const execFileMock = vi.hoisted(() => vi.fn());

vi.mock('fs', () => ({
  existsSync: fsMock.existsSync,
  mkdirSync: fsMock.mkdirSync,
  writeFileSync: fsMock.writeFileSync,
  readFileSync: fsMock.readFileSync,
  renameSync: fsMock.renameSync,
  rmSync: fsMock.rmSync,
  unlinkSync: fsMock.unlinkSync,
  chmodSync: fsMock.chmodSync,
  promises: fsMock.promises,
}));

vi.mock('child_process', () => ({
  execFileSync: execFileSyncMock,
  execFile: execFileMock,
}));

// NOTE: these are STRUCTURAL tests — the child_process and fs surfaces are
// mocked, so they assert the invocation shape (which tool, which args, which
// order) but never run a real ACL operation. The decisive runtime behavior
// (a custom EXPLICIT broad ACE actually disappearing, which the plain icacls
// strip leaves in place) is covered out-of-band by
// scripts/issue-124-acl-dynamic.mjs, which drives the genuine compiled function
// against seeded on-disk ACLs.

const HARDEN_TMP = '.harden-tmp';

/** Answer `whoami /user` with a fixed SID; every other sync invocation
 *  (icacls) returns empty. */
function stubWhoamiSid(sid: string): void {
  execFileSyncMock.mockImplementation((cmd: unknown) =>
    typeof cmd === 'string' && cmd.toLowerCase().includes('whoami')
      ? Buffer.from(`\nUSER INFORMATION\n----------------\nUser Name: machine\\user\nSID:       ${sid}\n`)
      : Buffer.from(''),
  );
}

function callsMatching(mock: typeof execFileSyncMock, needle: string) {
  return mock.mock.calls.filter(
    ([cmd]) => typeof cmd === 'string' && cmd.toLowerCase().includes(needle),
  ) as Array<[string, unknown[], Record<string, unknown>]>;
}

function icaclsCall(): [string, unknown[], Record<string, unknown>] | undefined {
  return callsMatching(execFileSyncMock, 'icacls')[0];
}

function icaclsArgs(): unknown[] | undefined {
  return icaclsCall()?.[1];
}

function icaclsAsyncCall(): [string, unknown[], Record<string, unknown>] | undefined {
  return callsMatching(execFileMock, 'icacls')[0];
}

/**
 * The load-bearing regression guard for GHSA-8fj2-47w9-jxq3 (Norton flags
 * `-ExecutionPolicy Bypass -EncodedCommand` as IDP.HELU.PSE85) and for
 * Constrained Language Mode fleets (the .NET rebuild died on its first method
 * call there, 22/22, silently degrading every token to the weaker icacls strip).
 * NO code path may spawn powershell.exe any more.
 */
function expectNoPowerShell(): void {
  expect(callsMatching(execFileSyncMock, 'powershell')).toEqual([]);
  expect(callsMatching(execFileMock, 'powershell')).toEqual([]);
}

/** Default async execFile: succeed by invoking the node-style callback. */
function stubAsyncExecFile(sid: string | null, opts: { icaclsFails?: boolean } = {}): void {
  execFileMock.mockImplementation((cmd: unknown, _args: unknown, _o: unknown, cb: unknown) => {
    const done = cb as (e: Error | null, out?: string) => void;
    const c = typeof cmd === 'string' ? cmd.toLowerCase() : '';
    if (c.includes('whoami')) {
      if (sid === null) { done(new Error('whoami unavailable')); return; }
      done(null, `User Name: machine\\user\nSID:       ${sid}\n`);
      return;
    }
    if (c.includes('icacls') && opts.icaclsFails) { done(new Error('icacls denied')); return; }
    done(null, '');
  });
}

function resetAll(): void {
  vi.resetModules();
  vi.clearAllMocks();
  execFileSyncMock.mockReset();
  execFileMock.mockReset();
  fsMock.existsSync.mockReset();
  fsMock.writeFileSync.mockReset();
  fsMock.readFileSync.mockReset();
  fsMock.renameSync.mockReset();
  fsMock.rmSync.mockReset();
  fsMock.unlinkSync.mockReset();
  fsMock.chmodSync.mockReset();
  fsMock.promises.chmod.mockReset();
  fsMock.promises.readFile.mockReset();
  fsMock.promises.writeFile.mockReset();
  fsMock.promises.rename.mockReset();
  fsMock.promises.rm.mockReset();
  fsMock.existsSync.mockReturnValue(true);
  fsMock.readFileSync.mockReturnValue(Buffer.from('existing-token'));
  fsMock.promises.readFile.mockResolvedValue(Buffer.from('existing-token'));
  fsMock.promises.writeFile.mockResolvedValue(undefined);
  fsMock.promises.rename.mockResolvedValue(undefined);
  fsMock.promises.rm.mockResolvedValue(undefined);
  fsMock.promises.chmod.mockResolvedValue(undefined);
}

describe('secureWriteTokenFile', () => {
  beforeEach(resetAll);

  it('creates the parent directory before writing', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    fsMock.existsSync.mockReturnValue(false);

    const { secureWriteTokenFile } = await import('../security');
    const tokenPath = path.join('/home', 'tester', '.wmux', 'daemon-auth-token');

    secureWriteTokenFile(tokenPath, 'secret-token');

    expect(fsMock.existsSync).toHaveBeenCalledWith(path.dirname(tokenPath));
    expect(fsMock.mkdirSync).toHaveBeenCalledWith(path.dirname(tokenPath), { recursive: true });
    expect(fsMock.writeFileSync).toHaveBeenCalledWith(tokenPath, 'secret-token', {
      encoding: 'utf8',
      mode: 0o600,
    });
  });

  it('re-applies mode 0600 when overwriting an existing POSIX token file', async () => {
    const platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    try {
      const { secureWriteTokenFile } = await import('../security');
      const tokenPath = '/home/tester/.wmux-auth-token';

      secureWriteTokenFile(tokenPath, 'secret-token');

      expect(fsMock.chmodSync).toHaveBeenCalledWith(tokenPath, 0o600);
    } finally {
      platformSpy.mockRestore();
    }
  });

  it('fails closed when a POSIX mode repair fails', async () => {
    const platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    fsMock.chmodSync.mockImplementationOnce(() => {
      throw new Error('chmod denied');
    });
    try {
      const { secureWriteTokenFile } = await import('../security');
      const tokenPath = '/home/tester/.wmux-auth-token';

      expect(() => secureWriteTokenFile(tokenPath, 'secret-token')).toThrow(
        `Failed to set secure mode on ${tokenPath}: chmod denied`,
      );
      expect(fsMock.unlinkSync).toHaveBeenCalledWith(tokenPath);
    } finally {
      platformSpy.mockRestore();
    }
  });

  // ── win32: every write goes through a fresh, pre-hardened inode ────────────
  describe('win32 fresh-inode write path', () => {
    beforeEach(() => {
      vi.stubEnv('USERNAME', 'tester');
      vi.stubEnv('SystemRoot', 'C:\\Windows');
      vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    });

    it('hardens a staging inode and renames it over the target — never writes the target in place', async () => {
      stubWhoamiSid('S-1-5-21-1-2-3-1001');

      const { secureWriteTokenFile } = await import('../security');
      const tokenPath = path.join('C:', 'Users', 'tester', '.wmux-auth-token');
      const tmp = `${tokenPath}${HARDEN_TMP}`;

      secureWriteTokenFile(tokenPath, 'secret-token');

      // SID resolved via whoami first...
      expect(execFileSyncMock).toHaveBeenCalledWith(
        'C:\\Windows\\System32\\whoami.exe',
        ['/user', '/fo', 'list'],
        { windowsHide: true },
      );
      // ...then the DACL is built on the STAGING path, not the target.
      expect(icaclsCall()?.[0]).toBe('C:\\Windows\\System32\\icacls.exe');
      expect(icaclsArgs()).toEqual([
        tmp,
        '/grant:r',
        '*S-1-5-21-1-2-3-1001:F',
        '/inheritance:r',
        '/remove:g',
        '*S-1-1-0', // Everyone
        '/remove:g',
        '*S-1-5-32-545', // BUILTIN\Users
        '/remove:g',
        '*S-1-5-11', // Authenticated Users
        '/remove:g',
        '*S-1-5-4', // INTERACTIVE
      ]);
      // The target is only ever reached by the atomic rename.
      expect(fsMock.renameSync).toHaveBeenCalledWith(tmp, tokenPath);
      expect(
        fsMock.writeFileSync.mock.calls.filter(([p]) => p === tokenPath),
      ).toEqual([]);
      expectNoPowerShell();
    });

    // Ordering is the whole point: if the payload landed first, a crash between
    // the write and the harden would leave the secret readable in the staging
    // inode under the directory's inherited ACEs.
    it('locks the staging inode down while it is still EMPTY, before the secret lands', async () => {
      stubWhoamiSid('S-1-5-21-1-2-3-1001');
      const order: string[] = [];
      fsMock.writeFileSync.mockImplementation((_p: unknown, data: unknown) => {
        order.push(data === '' ? 'write-empty' : 'write-payload');
      });
      execFileSyncMock.mockImplementation((cmd: unknown) => {
        const c = typeof cmd === 'string' ? cmd.toLowerCase() : '';
        if (c.includes('whoami')) {
          return Buffer.from('User Name: machine\\user\nSID:       S-1-5-21-1-2-3-1001\n');
        }
        order.push('icacls');
        return Buffer.from('');
      });
      fsMock.renameSync.mockImplementation(() => { order.push('rename'); });

      const { secureWriteTokenFile } = await import('../security');
      secureWriteTokenFile(path.join('C:', 'Users', 'tester', '.wmux-auth-token'), 'secret-token');

      expect(order).toEqual(['write-empty', 'icacls', 'write-payload', 'rename']);
    });

    it('discards a staging inode left behind by an earlier crash', async () => {
      stubWhoamiSid('S-1-5-21-1-2-3-1001');

      const { secureWriteTokenFile } = await import('../security');
      const tokenPath = path.join('C:', 'Users', 'tester', '.wmux-auth-token');

      secureWriteTokenFile(tokenPath, 'secret-token');

      expect(fsMock.rmSync).toHaveBeenCalledWith(`${tokenPath}${HARDEN_TMP}`, { force: true });
    });

    it('fails closed (drops the staging inode, deletes the target, throws) when icacls denies', async () => {
      execFileSyncMock.mockImplementation((cmd: unknown) => {
        const c = typeof cmd === 'string' ? cmd.toLowerCase() : '';
        if (c.includes('whoami')) {
          return Buffer.from('User Name: machine\\user\nSID:       S-1-5-21-1-2-3-1001\n');
        }
        throw new Error('icacls denied');
      });

      const { secureWriteTokenFile } = await import('../security');
      const tokenPath = path.join('C:', 'Users', 'tester', '.wmux-auth-token');

      expect(() => secureWriteTokenFile(tokenPath, 'secret-token')).toThrow(
        `Failed to set secure ACL on ${tokenPath}: icacls denied`,
      );
      expect(fsMock.rmSync).toHaveBeenCalledWith(`${tokenPath}${HARDEN_TMP}`, { force: true });
      expect(fsMock.unlinkSync).toHaveBeenCalledWith(tokenPath);
      // The target was never swapped in, so no unhardened token exists.
      expect(fsMock.renameSync).not.toHaveBeenCalled();
    });

    it('fails closed when the final rename fails — a write that did not land must throw', async () => {
      stubWhoamiSid('S-1-5-21-1-2-3-1001');
      fsMock.renameSync.mockImplementation(() => {
        throw new Error('EPERM: file is open');
      });

      const { secureWriteTokenFile } = await import('../security');
      const tokenPath = path.join('C:', 'Users', 'tester', '.wmux-auth-token');

      expect(() => secureWriteTokenFile(tokenPath, 'secret-token')).toThrow(
        /Failed to set secure ACL/,
      );
      expect(fsMock.rmSync).toHaveBeenCalledWith(`${tokenPath}${HARDEN_TMP}`, { force: true });
    });

    it('parses the SID field instead of SID-like text in the account name', async () => {
      vi.stubEnv('USERNAME', 'victim');
      execFileSyncMock.mockImplementation((cmd: unknown) =>
        typeof cmd === 'string' && cmd.toLowerCase().includes('whoami')
          ? Buffer.from(
              '\nUSER INFORMATION\n----------------\n' +
                'User Name: S-1-1-0\\victim\n' +
                'SID:       S-1-5-21-1111111111-2222222222-3333333333-1001\n',
            )
          : Buffer.from(''),
      );

      const { secureWriteTokenFile } = await import('../security');
      secureWriteTokenFile(path.join('C:', 'Users', 'victim', '.wmux-auth-token'), 'secret-token');

      // The principal is the SID FIELD, never the SID-like account-name text.
      expect(icaclsArgs()?.[2]).toBe('*S-1-5-21-1111111111-2222222222-3333333333-1001:F');
    });

    // Regression (#90): a non-ASCII (Korean) profile name passed verbatim to a
    // native ACL tool is mangled by the console OEM codepage into a ghost
    // principal — Full control to an account that does not exist, while the real
    // owner gets nothing. Identifying by SID (pure ASCII) avoids this.
    it('never passes a non-ASCII username to native ACL tooling', async () => {
      vi.stubEnv('USERNAME', '홍길동');
      stubWhoamiSid('S-1-5-21-1-2-3-1001');

      const { secureWriteTokenFile } = await import('../security');
      secureWriteTokenFile(path.join('C:', 'Users', '홍길동', '.wmux-auth-token'), 'secret-token');

      // The PRINCIPAL is the SID; the file PATH legitimately keeps the name.
      expect(icaclsArgs()?.[2]).toBe('*S-1-5-21-1-2-3-1001:F');
      expect(icaclsArgs()?.slice(1).join(' ')).not.toContain('홍길동');
    });

    it('falls back to an ASCII %USERNAME% principal when the SID cannot be resolved', async () => {
      vi.stubEnv('USERNAME', 'tester');
      execFileSyncMock.mockImplementation((cmd: unknown) => {
        if (typeof cmd === 'string' && cmd.toLowerCase().includes('whoami')) {
          throw new Error('whoami unavailable');
        }
        return Buffer.from('');
      });

      const { secureWriteTokenFile } = await import('../security');
      const tokenPath = path.join('C:', 'Users', 'tester', '.wmux-auth-token');
      secureWriteTokenFile(tokenPath, 'secret-token');

      // No `*` SID prefix on a plain username principal.
      expect(icaclsArgs()?.slice(0, 4)).toEqual([
        `${tokenPath}${HARDEN_TMP}`,
        '/grant:r',
        'tester:F',
        '/inheritance:r',
      ]);
    });

    // When the SID can't be resolved, the %USERNAME% fallback must NOT be used
    // for a non-ASCII account — that would re-create the ghost-principal lock-out
    // and re-apply it on every load.
    it('refuses (throws + deletes, no ACL tooling) when SID unresolved AND USERNAME is non-ASCII', async () => {
      vi.stubEnv('USERNAME', '홍길동');
      execFileSyncMock.mockImplementation((cmd: unknown) => {
        if (typeof cmd === 'string' && cmd.toLowerCase().includes('whoami')) {
          throw new Error('whoami unavailable');
        }
        return Buffer.from('');
      });

      const { secureWriteTokenFile } = await import('../security');
      const tokenPath = path.join('C:', 'Users', '홍길동', '.wmux-auth-token');

      expect(() => secureWriteTokenFile(tokenPath, 'secret-token')).toThrow(
        /refusing to apply a mangling-prone ACL/,
      );
      expect(icaclsCall()).toBeUndefined();
      expectNoPowerShell();
      expect(fsMock.unlinkSync).toHaveBeenCalledWith(tokenPath);
    });
  });
});

// RCA A12 — re-hardening an EXISTING token file whose VALUE does not change.
describe('reHardenTokenFileAcl', () => {
  beforeEach(resetAll);

  it('rebuilds the DACL through a fresh inode and reports "hardened" on win32', async () => {
    vi.stubEnv('USERNAME', 'tester');
    vi.stubEnv('SystemRoot', 'C:\\Windows');
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    stubWhoamiSid('S-1-5-21-1-2-3-1001');

    const { reHardenTokenFileAcl } = await import('../security');
    const tokenPath = path.join('C:', 'Users', 'tester', '.wmux-auth-token');
    const tmp = `${tokenPath}${HARDEN_TMP}`;

    expect(reHardenTokenFileAcl(tokenPath)).toBe('hardened');

    // The existing bytes are carried over verbatim — the VALUE never changes.
    expect(fsMock.readFileSync).toHaveBeenCalledWith(tokenPath);
    expect(fsMock.writeFileSync).toHaveBeenCalledWith(tmp, Buffer.from('existing-token'));
    expect(icaclsArgs()?.[0]).toBe(tmp);
    expect(fsMock.renameSync).toHaveBeenCalledWith(tmp, tokenPath);
    expectNoPowerShell();
  });

  it('chmods to 0600 on POSIX without rewriting anything', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');

    const { reHardenTokenFileAcl } = await import('../security');
    const tokenPath = '/home/tester/.wmux-auth-token';

    expect(reHardenTokenFileAcl(tokenPath)).toBe('hardened');
    expect(fsMock.chmodSync).toHaveBeenCalledWith(tokenPath, 0o600);
    expect(fsMock.writeFileSync).not.toHaveBeenCalled();
  });

  // THE regression this refactor exists to prevent. A rename collision is not a
  // security failure — the original file and its ACL are untouched. Reporting it
  // as one makes PeerStore.persist unlink the peer store and
  // loadOrCreateMachineKey regenerate the HMAC key, which invalidates
  // lanlink-peers.json's MAC and silently drops every paired device.
  it('reports "unchanged" (NOT "failed") when only the final rename fails', async () => {
    vi.stubEnv('USERNAME', 'tester');
    vi.stubEnv('SystemRoot', 'C:\\Windows');
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    stubWhoamiSid('S-1-5-21-1-2-3-1001');
    fsMock.renameSync.mockImplementation(() => {
      const err = new Error('EPERM: another process has the file open') as NodeJS.ErrnoException;
      err.code = 'EPERM';
      throw err;
    });

    const { reHardenTokenFileAcl } = await import('../security');
    const tokenPath = path.join('C:', 'Users', 'tester', '.wmux-auth-token');

    expect(reHardenTokenFileAcl(tokenPath)).toBe('unchanged');
    // The staging inode is cleaned up and the original is left alone.
    expect(fsMock.rmSync).toHaveBeenCalledWith(`${tokenPath}${HARDEN_TMP}`, { force: true });
    expect(fsMock.unlinkSync).not.toHaveBeenCalled();
  });

  it('reports "failed" when the staging inode cannot be hardened at all', async () => {
    vi.stubEnv('USERNAME', 'tester');
    vi.stubEnv('SystemRoot', 'C:\\Windows');
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    execFileSyncMock.mockImplementation((cmd: unknown) => {
      if (typeof cmd === 'string' && cmd.toLowerCase().includes('whoami')) {
        return Buffer.from('User Name: machine\\user\nSID:       S-1-5-21-1-2-3-1001\n');
      }
      throw new Error('icacls denied');
    });

    const { reHardenTokenFileAcl } = await import('../security');
    const tokenPath = path.join('C:', 'Users', 'tester', '.wmux-auth-token');

    // Best-effort: a live daemon must not crash because it couldn't tighten perms.
    expect(() => reHardenTokenFileAcl(tokenPath)).not.toThrow();
    expect(reHardenTokenFileAcl(tokenPath)).toBe('failed');
    // Unlike the write path, the working token is NOT deleted.
    expect(fsMock.unlinkSync).not.toHaveBeenCalled();
  });

  // Fail soft: never run an ACL tool with a mangling-prone name, never delete
  // the working token. Re-locking the owner out on every load is worse than
  // leaving the current ACL untouched.
  it('reports "failed" without running ACL tooling when SID unresolved AND USERNAME is non-ASCII', async () => {
    vi.stubEnv('USERNAME', '홍길동');
    vi.stubEnv('SystemRoot', 'C:\\Windows');
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    execFileSyncMock.mockImplementation((cmd: unknown) => {
      if (typeof cmd === 'string' && cmd.toLowerCase().includes('whoami')) {
        throw new Error('whoami unavailable');
      }
      return Buffer.from('');
    });

    const { reHardenTokenFileAcl } = await import('../security');
    const tokenPath = path.join('C:', 'Users', '홍길동', '.wmux-auth-token');

    expect(reHardenTokenFileAcl(tokenPath)).toBe('failed');
    expect(icaclsCall()).toBeUndefined();
    expectNoPowerShell();
    expect(fsMock.unlinkSync).not.toHaveBeenCalled();
  });
});

describe('scheduleTokenFileReHarden (deferred re-harden)', () => {
  beforeEach(resetAll);

  /** setImmediate + the internal async chain need a couple of macrotask turns. */
  async function drain(): Promise<void> {
    for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r));
  }

  it('does not run synchronously — the caller returns before any ACL work', async () => {
    vi.stubEnv('SystemRoot', 'C:\\Windows');
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    stubAsyncExecFile('S-1-5-21-1-2-3-1001');

    const { scheduleTokenFileReHarden } = await import('../security');
    scheduleTokenFileReHarden(path.join('C:', 'Users', 'tester', '.wmux-auth-token'));

    // Nothing has happened yet — this is what keeps the boot path free.
    expect(execFileMock).not.toHaveBeenCalled();
    expect(execFileSyncMock).not.toHaveBeenCalled();
    await drain();
    expect(execFileMock).toHaveBeenCalled();
  });

  it('POSIX: chmods 0600 asynchronously', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');

    const { scheduleTokenFileReHarden } = await import('../security');
    const tokenPath = '/home/tester/.wmux-auth-token';
    scheduleTokenFileReHarden(tokenPath);
    await drain();

    expect(fsMock.promises.chmod).toHaveBeenCalledWith(tokenPath, 0o600);
  });

  it('win32: stages, hardens and renames entirely through async fs + icacls', async () => {
    vi.stubEnv('USERNAME', 'tester');
    vi.stubEnv('SystemRoot', 'C:\\Windows');
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    stubAsyncExecFile('S-1-5-21-1-2-3-1001');

    const { scheduleTokenFileReHarden } = await import('../security');
    const tokenPath = path.join('C:', 'Users', 'tester', '.wmux-auth-token');
    const tmp = `${tokenPath}${HARDEN_TMP}`;
    scheduleTokenFileReHarden(tokenPath);
    await drain();

    expect(icaclsAsyncCall()?.[1]).toEqual([
      tmp,
      '/grant:r',
      '*S-1-5-21-1-2-3-1001:F',
      '/inheritance:r',
      '/remove:g',
      '*S-1-1-0',
      '/remove:g',
      '*S-1-5-32-545',
      '/remove:g',
      '*S-1-5-11',
      '/remove:g',
      '*S-1-5-4',
    ]);
    expect(fsMock.promises.rename).toHaveBeenCalledWith(tmp, tokenPath);
    // No *Sync anywhere on this path — a sync harden would stall the daemon's
    // freshly-opened control pipe.
    expect(execFileSyncMock).not.toHaveBeenCalled();
    expect(fsMock.writeFileSync).not.toHaveBeenCalled();
    expect(fsMock.renameSync).not.toHaveBeenCalled();
    expectNoPowerShell();
  });

  it('win32: never throws to the caller when the harden fails (best-effort)', async () => {
    vi.stubEnv('USERNAME', 'tester');
    vi.stubEnv('SystemRoot', 'C:\\Windows');
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    stubAsyncExecFile('S-1-5-21-1-2-3-1001', { icaclsFails: true });

    const { scheduleTokenFileReHarden } = await import('../security');
    const tokenPath = path.join('C:', 'Users', 'tester', '.wmux-auth-token');

    expect(() => scheduleTokenFileReHarden(tokenPath)).not.toThrow();
    await expect(drain()).resolves.toBeUndefined();
    // The staging inode is cleaned up rather than left holding the secret.
    expect(fsMock.promises.rm).toHaveBeenCalledWith(`${tokenPath}${HARDEN_TMP}`, { force: true });
  });

  it('win32: a rename collision leaves the original untouched and does not throw', async () => {
    vi.stubEnv('USERNAME', 'tester');
    vi.stubEnv('SystemRoot', 'C:\\Windows');
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    stubAsyncExecFile('S-1-5-21-1-2-3-1001');
    fsMock.promises.rename.mockRejectedValue(new Error('EPERM: file is open'));

    const { scheduleTokenFileReHarden } = await import('../security');
    const tokenPath = path.join('C:', 'Users', 'tester', '.wmux-auth-token');
    scheduleTokenFileReHarden(tokenPath);
    await drain();

    expect(fsMock.promises.rm).toHaveBeenCalledWith(`${tokenPath}${HARDEN_TMP}`, { force: true });
    expect(fsMock.unlinkSync).not.toHaveBeenCalled();
  });
});
