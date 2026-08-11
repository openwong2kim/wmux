import * as path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fsMock = vi.hoisted(() => ({
  existsSync: vi.fn(),
  mkdirSync: vi.fn(),
  mkdtempSync: vi.fn(),
  writeFileSync: vi.fn(),
  readFileSync: vi.fn(),
  readdirSync: vi.fn(),
  statSync: vi.fn(),
  renameSync: vi.fn(),
  rmSync: vi.fn(),
  unlinkSync: vi.fn(),
  chmodSync: vi.fn(),
  promises: {
    chmod: vi.fn(),
    mkdir: vi.fn(),
    mkdtemp: vi.fn(),
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
  mkdtempSync: fsMock.mkdtempSync,
  writeFileSync: fsMock.writeFileSync,
  readFileSync: fsMock.readFileSync,
  readdirSync: fsMock.readdirSync,
  statSync: fsMock.statSync,
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
// (a custom EXPLICIT broad ACE actually disappearing; sddlIsOwnerOnly agreeing
// with REAL `icacls /save` output) is covered out-of-band by
// scripts/issue-124-acl-dynamic.mjs, which drives the genuine compiled function
// against seeded on-disk ACLs.

const HARDEN_TMP = '.harden-tmp';
const OWNER_ONLY_SDDL = (sid: string) => `token\r\nD:PAI(A;;FA;;;${sid})\r\n`;
const BROAD_SDDL = (sid: string) => `token\r\nD:PAI(A;;FR;;;S-1-1-0)(A;;FA;;;${sid})\r\n`;

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

/** All sync icacls /grant:r calls, in order (staging DIR first, then file). */
function icaclsGrants(): unknown[][] {
  return callsMatching(execFileSyncMock, 'icacls')
    .filter(([, args]) => args?.[1] === '/grant:r')
    .map(([, args]) => args);
}

/** The icacls `/save` DACL read-back used by swap-failure verification. */
function icaclsSaveCall(): [string, unknown[], Record<string, unknown>] | undefined {
  return callsMatching(execFileSyncMock, 'icacls').find(([, args]) => args?.[1] === '/save');
}

/** The per-operation-unique staging DIRECTORY (captured from mkdirSync). */
function stagingDir(): string | undefined {
  const call = fsMock.mkdirSync.mock.calls.find(
    ([p]) => typeof p === 'string' && p.includes(`${HARDEN_TMP}.`),
  );
  return call?.[0] as string | undefined;
}

/** The staged payload file inside the staging directory. */
function stagedFile(): string | undefined {
  const dir = stagingDir();
  return dir === undefined ? undefined : path.join(dir, 'staged');
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
  for (const fn of Object.values(fsMock)) {
    if (typeof fn === 'function') (fn as ReturnType<typeof vi.fn>).mockReset();
  }
  for (const fn of Object.values(fsMock.promises)) fn.mockReset();
  fsMock.existsSync.mockReturnValue(true);
  fsMock.readdirSync.mockReturnValue([]);
  fsMock.readFileSync.mockReturnValue(Buffer.from('existing-token'));
  fsMock.mkdtempSync.mockImplementation((p: unknown) => `${p}RND`);
  fsMock.promises.mkdtemp.mockImplementation((p: unknown) => Promise.resolve(`${p}RND`));
  fsMock.promises.mkdir.mockResolvedValue(undefined);
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
      // POSIX overwrite is in place: the target holds the NEW token under a
      // possibly-wrong mode, so the fail-closed unlink is still correct there.
      expect(fsMock.unlinkSync).toHaveBeenCalledWith(tokenPath);
    } finally {
      platformSpy.mockRestore();
    }
  });

  // ── win32: every write is staged inside a pre-hardened directory ───────────
  describe('win32 hardened-staging write path', () => {
    beforeEach(() => {
      vi.stubEnv('USERNAME', 'tester');
      vi.stubEnv('SystemRoot', 'C:\\Windows');
      vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    });

    it('hardens the staging DIRECTORY first, births the file owner-only, then renames it in', async () => {
      stubWhoamiSid('S-1-5-21-1-2-3-1001');

      const { secureWriteTokenFile } = await import('../security');
      const tokenPath = path.join('C:', 'Users', 'tester', '.wmux-auth-token');

      secureWriteTokenFile(tokenPath, 'secret-token');

      // SID resolved via whoami first...
      expect(execFileSyncMock).toHaveBeenCalledWith(
        'C:\\Windows\\System32\\whoami.exe',
        ['/user', '/fo', 'list'],
        { windowsHide: true },
      );
      // ...staging area is a per-operation-unique DIRECTORY...
      const dir = stagingDir();
      expect(dir).toMatch(/\.wmux-auth-token\.harden-tmp\.\d+\.\d+\.[0-9a-f]{12}$/);
      const grants = icaclsGrants();
      expect(grants.length).toBe(2);
      // ...hardened with an INHERITABLE owner-only grant while still empty
      // (a file hardened after creation would leave a handle-race window —
      // Windows ACL changes do not revoke open handles)...
      expect(grants[0]).toEqual([
        dir,
        '/grant:r',
        '*S-1-5-21-1-2-3-1001:(OI)(CI)F',
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
      // ...then the staged file gets the explicit, protected owner-only DACL.
      expect(grants[1]?.slice(0, 4)).toEqual([
        stagedFile(),
        '/grant:r',
        '*S-1-5-21-1-2-3-1001:F',
        '/inheritance:r',
      ]);
      // The target is only ever reached by the atomic rename; the staging dir
      // is discarded afterwards.
      expect(fsMock.renameSync).toHaveBeenCalledWith(stagedFile(), tokenPath);
      expect(fsMock.rmSync).toHaveBeenCalledWith(dir, { force: true, recursive: true });
      expect(fsMock.writeFileSync.mock.calls.filter(([p]) => p === tokenPath)).toEqual([]);
      expectNoPowerShell();
    });

    it('two writes use two DIFFERENT staging directories', async () => {
      stubWhoamiSid('S-1-5-21-1-2-3-1001');

      const { secureWriteTokenFile } = await import('../security');
      const tokenPath = path.join('C:', 'Users', 'tester', '.wmux-auth-token');

      secureWriteTokenFile(tokenPath, 'one');
      const first = stagingDir();
      fsMock.mkdirSync.mockClear();
      secureWriteTokenFile(tokenPath, 'two');
      const second = stagingDir();

      expect(first).toBeDefined();
      expect(second).toBeDefined();
      expect(second).not.toBe(first);
    });

    // Ordering is the whole point: the directory is hardened while EMPTY, and
    // the payload lands on an inode that inherits owner-only at creation.
    it('orders: mkdir → harden dir → write payload → harden file → rename', async () => {
      stubWhoamiSid('S-1-5-21-1-2-3-1001');
      const order: string[] = [];
      fsMock.mkdirSync.mockImplementation((p: unknown) => {
        if (String(p).includes(HARDEN_TMP)) order.push('mkdir');
      });
      fsMock.writeFileSync.mockImplementation(() => {
        order.push('write-payload');
      });
      execFileSyncMock.mockImplementation((cmd: unknown, args: unknown) => {
        const c = typeof cmd === 'string' ? cmd.toLowerCase() : '';
        if (c.includes('whoami')) {
          return Buffer.from('User Name: machine\\user\nSID:       S-1-5-21-1-2-3-1001\n');
        }
        const grant = Array.isArray(args) ? String(args[2]) : '';
        order.push(grant.includes('(OI)(CI)') ? 'icacls-dir' : 'icacls-file');
        return Buffer.from('');
      });
      fsMock.renameSync.mockImplementation(() => {
        order.push('rename');
      });

      const { secureWriteTokenFile } = await import('../security');
      secureWriteTokenFile(path.join('C:', 'Users', 'tester', '.wmux-auth-token'), 'secret-token');

      expect(order).toEqual(['mkdir', 'icacls-dir', 'write-payload', 'icacls-file', 'rename']);
    });

    it('sweeps STALE staging leftovers from an earlier crash, but never a fresh one', async () => {
      stubWhoamiSid('S-1-5-21-1-2-3-1001');
      const tokenPath = path.join('C:', 'Users', 'tester', '.wmux-auth-token');
      const dir = path.dirname(tokenPath);
      const stale = `.wmux-auth-token${HARDEN_TMP}.999.1.aabbccddeeff`;
      const fresh = `.wmux-auth-token${HARDEN_TMP}.998.7.aabbccddeeff`;
      const userBackup = `.wmux-auth-token${HARDEN_TMP}.backup`;
      fsMock.readdirSync.mockReturnValue([stale, fresh, userBackup, 'unrelated-file']);
      fsMock.statSync.mockImplementation((p: unknown) => ({
        mtimeMs: String(p).endsWith(stale) ? Date.now() - 3_600_000 : Date.now(),
      }));

      const { secureWriteTokenFile } = await import('../security');
      secureWriteTokenFile(tokenPath, 'secret-token');

      // The hour-old leftover is removed...
      expect(fsMock.rmSync).toHaveBeenCalledWith(path.join(dir, stale), {
        force: true,
        recursive: true,
      });
      // ...the seconds-old one (a live concurrent harden) is left alone...
      expect(
        fsMock.rmSync.mock.calls.filter(([p]) => String(p).endsWith(fresh)),
      ).toEqual([]);
      // ...and a user file that merely STARTS with the staging prefix is never
      // mistaken for a crash artifact (codex round-3 P2).
      expect(
        fsMock.rmSync.mock.calls.filter(([p]) => String(p).endsWith(userBackup)),
      ).toEqual([]);
    });

    it('fails closed (drops staging, unlinks the UNVERIFIABLE previous token, throws) when icacls denies', async () => {
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
      expect(fsMock.rmSync).toHaveBeenCalledWith(stagingDir(), { force: true, recursive: true });
      // Every icacls is denied, so the previous token's DACL cannot be
      // verified either → fail closed: it is removed.
      expect(fsMock.unlinkSync).toHaveBeenCalledWith(tokenPath);
      expect(fsMock.renameSync).not.toHaveBeenCalled();
    });

    it('keeps the previous token on a rename collision when its DACL VERIFIES owner-only', async () => {
      stubWhoamiSid('S-1-5-21-1-2-3-1001');
      fsMock.renameSync.mockImplementation(() => {
        throw new Error('EPERM: file is open');
      });
      // Verification reads real SDDL via icacls /save + mkdtemp'd save file.
      fsMock.readFileSync.mockImplementation((p: unknown, enc?: unknown) =>
        enc === 'utf16le' && String(p).includes('wmux-dacl-')
          ? OWNER_ONLY_SDDL('S-1-5-21-1-2-3-1001')
          : Buffer.from('existing-token'),
      );

      const { secureWriteTokenFile } = await import('../security');
      const tokenPath = path.join('C:', 'Users', 'tester', '.wmux-auth-token');

      expect(() => secureWriteTokenFile(tokenPath, 'secret-token')).toThrow(
        /Failed to set secure ACL/,
      );
      expect(fsMock.renameSync.mock.calls.length).toBe(3); // bounded retries
      // The previous token was READ BACK and confirmed owner-only → kept.
      expect(icaclsSaveCall()).toBeDefined();
      expect(fsMock.unlinkSync).not.toHaveBeenCalled();
    });

    it('unlinks the previous token on a rename collision when its DACL does NOT verify', async () => {
      stubWhoamiSid('S-1-5-21-1-2-3-1001');
      fsMock.renameSync.mockImplementation(() => {
        throw new Error('EPERM: file is open');
      });
      fsMock.readFileSync.mockImplementation((p: unknown, enc?: unknown) =>
        enc === 'utf16le' && String(p).includes('wmux-dacl-')
          ? BROAD_SDDL('S-1-5-21-1-2-3-1001') // a broad leftover must not survive
          : Buffer.from('existing-token'),
      );

      const { secureWriteTokenFile } = await import('../security');
      const tokenPath = path.join('C:', 'Users', 'tester', '.wmux-auth-token');

      expect(() => secureWriteTokenFile(tokenPath, 'secret-token')).toThrow(
        /Failed to set secure ACL/,
      );
      expect(fsMock.unlinkSync).toHaveBeenCalledWith(tokenPath);
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
      expect(icaclsGrants()[0]?.[2]).toBe('*S-1-5-21-1111111111-2222222222-3333333333-1001:(OI)(CI)F');
      expect(icaclsGrants()[1]?.[2]).toBe('*S-1-5-21-1111111111-2222222222-3333333333-1001:F');
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
      for (const grant of icaclsGrants()) {
        expect(String(grant[2])).toContain('S-1-5-21-1-2-3-1001');
        expect(grant.slice(1).join(' ')).not.toContain('홍길동');
      }
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
      expect(icaclsGrants()[0]?.[2]).toBe('tester:(OI)(CI)F');
      expect(icaclsGrants()[1]?.[2]).toBe('tester:F');
    });

    // When the SID can't be resolved, the %USERNAME% fallback must NOT be used
    // for a non-ASCII account — that would re-create the ghost-principal lock-out
    // and re-apply it on every load.
    it('refuses (throws, no grant tooling, fail-closed unlink) when SID unresolved AND USERNAME is non-ASCII', async () => {
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
      // No GRANT may ever run with a mangling-prone principal.
      expect(icaclsGrants()).toEqual([]);
      expectNoPowerShell();
      // With no SID the previous token cannot be verified owner-only either —
      // fail closed, exactly like the pre-refactor contract for this case.
      expect(fsMock.unlinkSync).toHaveBeenCalledWith(tokenPath);
    });
  });
});

// RCA A12 — re-hardening an EXISTING token file whose VALUE does not change.
describe('reHardenTokenFileAcl', () => {
  beforeEach(resetAll);

  function stubWin32(): void {
    vi.stubEnv('USERNAME', 'tester');
    vi.stubEnv('SystemRoot', 'C:\\Windows');
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
  }

  it('rebuilds the DACL through hardened staging and reports "hardened" on win32', async () => {
    stubWin32();
    stubWhoamiSid('S-1-5-21-1-2-3-1001');

    const { reHardenTokenFileAcl } = await import('../security');
    const tokenPath = path.join('C:', 'Users', 'tester', '.wmux-auth-token');

    expect(reHardenTokenFileAcl(tokenPath)).toBe('hardened');

    // The existing bytes are carried over verbatim — the VALUE never changes.
    expect(fsMock.readFileSync).toHaveBeenCalledWith(tokenPath);
    expect(fsMock.writeFileSync).toHaveBeenCalledWith(stagedFile(), Buffer.from('existing-token'), {
      mode: 0o600,
      flag: 'wx', // exclusive create: a pre-planted file/hardlink at this name must fail
    });
    expect(icaclsGrants()[0]?.[0]).toBe(stagingDir());
    expect(icaclsGrants()[1]?.[0]).toBe(stagedFile());
    expect(fsMock.renameSync).toHaveBeenCalledWith(stagedFile(), tokenPath);
    expect(fsMock.rmSync).toHaveBeenCalledWith(stagingDir(), { force: true, recursive: true });
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

  // The lost-update guard (3-reviewer review): the commit compares the file
  // against the snapshot this harden staged FROM, inside one synchronous
  // block. A newer write (e.g. PipeServer.rotateToken) must never be clobbered
  // by a stale snapshot.
  it('aborts as "unchanged" when a newer write supersedes the harden AND its DACL verifies', async () => {
    stubWin32();
    stubWhoamiSid('S-1-5-21-1-2-3-1001');
    // Snapshot read sees the old token; the commit-time compare sees newer
    // bytes; the DACL read-back confirms the superseding writer's output is
    // owner-only (an in-process secureWriteTokenFile hardens its own output).
    let tokenReads = 0;
    fsMock.readFileSync.mockImplementation((p: unknown, enc?: unknown) => {
      if (enc === 'utf16le' && String(p).includes('wmux-dacl-')) {
        return OWNER_ONLY_SDDL('S-1-5-21-1-2-3-1001');
      }
      tokenReads += 1;
      return Buffer.from(tokenReads === 1 ? 'existing-token' : 'rotated-token');
    });

    const { reHardenTokenFileAcl } = await import('../security');
    const tokenPath = path.join('C:', 'Users', 'tester', '.wmux-auth-token');

    expect(reHardenTokenFileAcl(tokenPath)).toBe('unchanged');
    // The stale snapshot must NOT be installed over the newer write.
    expect(fsMock.renameSync).not.toHaveBeenCalled();
    expect(fsMock.rmSync).toHaveBeenCalledWith(stagingDir(), { force: true, recursive: true });
  });

  // codex round-3 P1: "a newer write exists" is not proof it is SAFE. An
  // EXTERNAL writer replacing the file mid-harden must not ride 'unchanged'
  // past the fail-closed callers.
  it('reports "failed" when a superseding write cannot be verified owner-only', async () => {
    stubWin32();
    stubWhoamiSid('S-1-5-21-1-2-3-1001');
    let tokenReads = 0;
    fsMock.readFileSync.mockImplementation((p: unknown, enc?: unknown) => {
      if (enc === 'utf16le' && String(p).includes('wmux-dacl-')) {
        return BROAD_SDDL('S-1-5-21-1-2-3-1001'); // replacement is broad-readable
      }
      tokenReads += 1;
      return Buffer.from(tokenReads === 1 ? 'existing-token' : 'planted-token');
    });

    const { reHardenTokenFileAcl } = await import('../security');

    expect(reHardenTokenFileAcl(path.join('C:', 'Users', 'tester', '.wmux-auth-token'))).toBe(
      'failed',
    );
    expect(fsMock.renameSync).not.toHaveBeenCalled();
  });

  // A swap collision now falls back to an IN-PLACE DACL repair: ACL edits need
  // only WRITE_DAC, not exclusive access, so they succeed even while the reader
  // that defeated the rename still holds the file (GLM round-3). The read-back
  // then decides honestly.
  it('repairs the DACL in place on a rename collision and reports "hardened" once verified', async () => {
    stubWin32();
    stubWhoamiSid('S-1-5-21-1-2-3-1001');
    fsMock.renameSync.mockImplementation(() => {
      throw new Error('EPERM: another process has the file open');
    });
    // icacls /save writes an SDDL file into a mkdtemp'd dir; serve owner-only.
    fsMock.readFileSync.mockImplementation((p: unknown, enc?: unknown) =>
      enc === 'utf16le' && String(p).includes('wmux-dacl-')
        ? OWNER_ONLY_SDDL('S-1-5-21-1-2-3-1001')
        : Buffer.from('existing-token'),
    );

    const { reHardenTokenFileAcl } = await import('../security');
    const tokenPath = path.join('C:', 'Users', 'tester', '.wmux-auth-token');

    expect(reHardenTokenFileAcl(tokenPath)).toBe('hardened');
    expect(fsMock.renameSync.mock.calls.length).toBe(3); // retried before repairing
    // The last-resort grant targets the ORIGINAL file, in place.
    const inPlace = icaclsGrants().find((args) => args[0] === tokenPath);
    expect(inPlace?.slice(1, 4)).toEqual(['/grant:r', '*S-1-5-21-1-2-3-1001:F', '/inheritance:r']);
    const save = icaclsSaveCall();
    expect(save?.[1]?.[0]).toBe(path.basename(tokenPath));
    expect(save?.[2]?.cwd).toBe(path.dirname(tokenPath));
    // The save file lives in an UNPREDICTABLE mkdtemp'd directory (hardlink-
    // plant defense) and is cleaned up with it.
    expect(fsMock.mkdtempSync).toHaveBeenCalled();
    expect(fsMock.unlinkSync).not.toHaveBeenCalled();
  });

  // THE upgrade-boot case (GLM+Codex consensus): the original ACL is the WEAK
  // one. A swap failure there must report 'failed' so the fail-closed callers
  // (machine-key regeneration) actually fire.
  it('reports "failed" on a rename collision when the original DACL is NOT owner-only', async () => {
    stubWin32();
    stubWhoamiSid('S-1-5-21-1-2-3-1001');
    fsMock.renameSync.mockImplementation(() => {
      throw new Error('EPERM: another process has the file open');
    });
    fsMock.readFileSync.mockImplementation((p: unknown, enc?: unknown) =>
      enc === 'utf16le' && String(p).includes('wmux-dacl-')
        ? BROAD_SDDL('S-1-5-21-1-2-3-1001') // extra Everyone ACE survives
        : Buffer.from('existing-token'),
    );

    const { reHardenTokenFileAcl } = await import('../security');
    const tokenPath = path.join('C:', 'Users', 'tester', '.wmux-auth-token');

    expect(reHardenTokenFileAcl(tokenPath)).toBe('failed');
    // Best-effort contract: report, never delete the working token here —
    // the CALLER decides (PeerStore discards its key; RemoteHostsStore ignores).
    expect(fsMock.unlinkSync).not.toHaveBeenCalled();
  });

  it('reports "failed" on a collision when the DACL read-back itself fails (never trusts blindly)', async () => {
    stubWin32();
    stubWhoamiSid('S-1-5-21-1-2-3-1001');
    fsMock.renameSync.mockImplementation(() => {
      throw new Error('EPERM');
    });
    execFileSyncMock.mockImplementation((cmd: unknown, args: unknown) => {
      const c = typeof cmd === 'string' ? cmd.toLowerCase() : '';
      if (c.includes('whoami')) {
        return Buffer.from('User Name: machine\\user\nSID:       S-1-5-21-1-2-3-1001\n');
      }
      if (Array.isArray(args) && args[1] === '/save') throw new Error('save denied');
      return Buffer.from('');
    });

    const { reHardenTokenFileAcl } = await import('../security');

    expect(reHardenTokenFileAcl(path.join('C:', 'Users', 'tester', '.wmux-auth-token'))).toBe(
      'failed',
    );
  });

  // LIVE DOGFOOD REGRESSION: a file opened with FILE_SHARE_NONE (what several
  // AV/backup products do while scanning) cannot be READ at all, so the
  // snapshot read at the top of the rewrite threw EBUSY and the whole harden
  // reported 'failed' — re-arming the exact self-DoS the collision handling
  // exists to prevent. Mocks never showed this; the real daemon did.
  it('falls back to the in-place repair when the file is LOCKED AGAINST READS', async () => {
    stubWin32();
    stubWhoamiSid('S-1-5-21-1-2-3-1001');
    fsMock.readFileSync.mockImplementation((p: unknown, enc?: unknown) => {
      if (enc === 'utf16le' && String(p).includes('wmux-dacl-')) {
        return OWNER_ONLY_SDDL('S-1-5-21-1-2-3-1001');
      }
      const err = new Error('EBUSY: resource busy or locked') as NodeJS.ErrnoException;
      err.code = 'EBUSY';
      throw err;
    });

    const { reHardenTokenFileAcl } = await import('../security');
    const tokenPath = path.join('C:', 'Users', 'tester', '.wmux-auth-token');

    // Reading the security descriptor is not blocked by share modes and an ACL
    // edit needs only WRITE_DAC, so the in-place path still works.
    expect(reHardenTokenFileAcl(tokenPath)).toBe('hardened');
    // No staging was attempted — there was nothing to copy.
    expect(fsMock.mkdirSync).not.toHaveBeenCalled();
    expect(fsMock.renameSync).not.toHaveBeenCalled();
    // The repair targets the ORIGINAL file, in place.
    const inPlace = icaclsGrants().find((args) => args[0] === tokenPath);
    expect(inPlace?.slice(1, 4)).toEqual(['/grant:r', '*S-1-5-21-1-2-3-1001:F', '/inheritance:r']);
  });

  it('still reports "failed" when the file is read-locked AND the in-place repair is not enough', async () => {
    stubWin32();
    stubWhoamiSid('S-1-5-21-1-2-3-1001');
    fsMock.readFileSync.mockImplementation((p: unknown, enc?: unknown) => {
      if (enc === 'utf16le' && String(p).includes('wmux-dacl-')) {
        return BROAD_SDDL('S-1-5-21-1-2-3-1001'); // a custom ACE the strip cannot remove
      }
      const err = new Error('EBUSY') as NodeJS.ErrnoException;
      err.code = 'EBUSY';
      throw err;
    });

    const { reHardenTokenFileAcl } = await import('../security');

    expect(reHardenTokenFileAcl(path.join('C:', 'Users', 'tester', '.wmux-auth-token'))).toBe(
      'failed',
    );
  });

  it('reports "failed" when the staging area cannot be hardened at all', async () => {
    stubWin32();
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
    expect(fsMock.unlinkSync).not.toHaveBeenCalled();
  });

  // Fail soft: never run an ACL tool with a mangling-prone name, never delete
  // the working token.
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
    expect(callsMatching(execFileSyncMock, 'icacls')).toEqual([]);
    expectNoPowerShell();
    expect(fsMock.unlinkSync).not.toHaveBeenCalled();
  });
});

describe('scheduleTokenFileReHarden (deferred re-harden)', () => {
  beforeEach(resetAll);

  /** setImmediate + the internal async chain need a few macrotask turns. */
  async function drain(turns = 10): Promise<void> {
    for (let i = 0; i < turns; i++) await new Promise((r) => setImmediate(r));
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

  it('win32: stages inside an async-hardened directory, commits via the SYNC compare+rename block', async () => {
    vi.stubEnv('USERNAME', 'tester');
    vi.stubEnv('SystemRoot', 'C:\\Windows');
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    stubAsyncExecFile('S-1-5-21-1-2-3-1001');

    const { scheduleTokenFileReHarden } = await import('../security');
    const tokenPath = path.join('C:', 'Users', 'tester', '.wmux-auth-token');
    scheduleTokenFileReHarden(tokenPath);
    await drain();

    // Staging (the slow part) is fully async: mkdir + dir grant + file grant.
    const dirCall = fsMock.promises.mkdir.mock.calls.find(([p]) =>
      String(p).includes(`${HARDEN_TMP}.`),
    );
    const dir = dirCall?.[0] as string;
    expect(dir).toMatch(/\.wmux-auth-token\.harden-tmp\.\d+\.\d+\.[0-9a-f]{12}$/);
    const grants = callsMatching(execFileMock, 'icacls').filter(
      ([, args]) => args?.[1] === '/grant:r',
    );
    expect(grants[0]?.[1]?.[0]).toBe(dir);
    expect(grants[0]?.[1]?.[2]).toBe('*S-1-5-21-1-2-3-1001:(OI)(CI)F');
    expect(grants[1]?.[1]?.[0]).toBe(path.join(dir, 'staged'));
    expect(fsMock.promises.writeFile).toHaveBeenCalledWith(
      path.join(dir, 'staged'),
      Buffer.from('existing-token'),
      { mode: 0o600, flag: 'wx' },
    );
    // ...but the COMMIT is the synchronous pair, so no in-process writer can
    // interleave between the compare and the rename. promises.rename would
    // reopen the lost-update window.
    expect(fsMock.renameSync).toHaveBeenCalledWith(path.join(dir, 'staged'), tokenPath);
    expect(fsMock.promises.rename).not.toHaveBeenCalled();
    expectNoPowerShell();
  });

  it('win32: a superseding write aborts the deferred harden instead of being clobbered', async () => {
    vi.stubEnv('USERNAME', 'tester');
    vi.stubEnv('SystemRoot', 'C:\\Windows');
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    stubAsyncExecFile('S-1-5-21-1-2-3-1001');
    // Async snapshot reads the old token; the sync commit compare sees newer bytes.
    fsMock.promises.readFile.mockResolvedValue(Buffer.from('existing-token'));
    fsMock.readFileSync.mockReturnValue(Buffer.from('rotated-token'));

    const { scheduleTokenFileReHarden } = await import('../security');
    const tokenPath = path.join('C:', 'Users', 'tester', '.wmux-auth-token');
    scheduleTokenFileReHarden(tokenPath);
    await drain();

    expect(fsMock.renameSync).not.toHaveBeenCalled();
    expect(fsMock.promises.rm).toHaveBeenCalled(); // staging discarded
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
    // The staging area is cleaned up rather than left holding the secret.
    expect(fsMock.promises.rm).toHaveBeenCalled();
  });
});
