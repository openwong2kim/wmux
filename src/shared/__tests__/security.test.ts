import * as path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fsMock = vi.hoisted(() => ({
  existsSync: vi.fn(),
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
  unlinkSync: vi.fn(),
  chmodSync: vi.fn(),
  renameSync: vi.fn(),
  openSync: vi.fn(),
  closeSync: vi.fn(),
  fsyncSync: vi.fn(),
  readdirSync: vi.fn(),
  constants: { O_CREAT: 512, O_EXCL: 2048, O_WRONLY: 1, O_NOFOLLOW: 256 },
  promises: { chmod: vi.fn() },
}));

const execFileSyncMock = vi.hoisted(() => vi.fn());
const execFileMock = vi.hoisted(() => vi.fn());
const spawnMock = vi.hoisted(() => vi.fn());

vi.mock('fs', () => ({
  existsSync: fsMock.existsSync,
  mkdirSync: fsMock.mkdirSync,
  writeFileSync: fsMock.writeFileSync,
  unlinkSync: fsMock.unlinkSync,
  chmodSync: fsMock.chmodSync,
  renameSync: fsMock.renameSync,
  openSync: fsMock.openSync,
  closeSync: fsMock.closeSync,
  fsyncSync: fsMock.fsyncSync,
  readdirSync: fsMock.readdirSync,
  constants: fsMock.constants,
  promises: fsMock.promises,
}));

vi.mock('child_process', () => ({
  execFileSync: execFileSyncMock,
  execFile: execFileMock,
  spawn: spawnMock,
}));

// NOTE: these are STRUCTURAL tests — execFileSync is mocked, so they assert the
// invocation shape (which tool, which args, which stdin payload) but never run
// a real ACL operation. The decisive runtime behavior (the DACL-only rebuild
// succeeding on the upgrade-from-icacls state WITHOUT SeSecurityPrivilege, where
// the closed PR #124 `Set-Acl` rebuild threw 10/10) is covered by the
// out-of-band dynamic harness scripts/issue-124-acl-dynamic.mjs, which drives
// the genuine compiled function against seeded on-disk ACLs.

// Answer `whoami /user` with a fixed SID; every other invocation (powershell /
// icacls) returns empty. Mirrors the real flow: applyRestrictiveWindowsAcl
// resolves the SID first, then rebuilds the DACL.
function stubWhoamiSid(sid: string): void {
  execFileSyncMock.mockImplementation((cmd: unknown) =>
    typeof cmd === 'string' && cmd.toLowerCase().includes('whoami')
      ? Buffer.from(`\nUSER INFORMATION\n----------------\nUser Name: machine\\user\nSID:       ${sid}\n`)
      : Buffer.from(''),
  );
}

// The PRIMARY path shells out to powershell.exe; the FALLBACK to icacls.exe.
// These helpers pull the relevant call out of the mock history (the whoami call
// is bookkeeping).
function powershellCall(): [string, unknown[], Record<string, unknown>] | undefined {
  return execFileSyncMock.mock.calls.find(
    ([cmd]) => typeof cmd === 'string' && cmd.toLowerCase().includes('powershell'),
  ) as [string, unknown[], Record<string, unknown>] | undefined;
}

function powershellArgs(): unknown[] | undefined {
  return powershellCall()?.[1];
}

// The JSON identity payload fed to the PowerShell child over stdin.
function powershellPayload(): Record<string, unknown> | undefined {
  const input = powershellCall()?.[2]?.input;
  return typeof input === 'string' ? (JSON.parse(input) as Record<string, unknown>) : undefined;
}

// The decoded -EncodedCommand script body.
function decodedPowershellScript(): string | undefined {
  const args = powershellArgs();
  const i = args?.indexOf('-EncodedCommand');
  const encoded = i === undefined || i < 0 ? undefined : args?.[i + 1];
  return typeof encoded === 'string' ? Buffer.from(encoded, 'base64').toString('utf16le') : undefined;
}

function icaclsCall(): [string, unknown[], Record<string, unknown>] | undefined {
  return execFileSyncMock.mock.calls.find(
    ([cmd]) => typeof cmd === 'string' && cmd.toLowerCase().includes('icacls'),
  ) as [string, unknown[], Record<string, unknown>] | undefined;
}

function icaclsArgs(): unknown[] | undefined {
  return icaclsCall()?.[1];
}

// existsSync(powershell) === true selects the PRIMARY .NET path; === false the
// icacls FALLBACK. The default is true (the overwhelmingly common case).
function stubPowershellPresent(present: boolean): void {
  fsMock.existsSync.mockImplementation((p: unknown) =>
    typeof p === 'string' && p.toLowerCase().includes('powershell') ? present : true,
  );
}

describe('secureWriteTokenFile', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    execFileSyncMock.mockReset();
    // existsSync=true pins every test in this block to the OVERWRITE branch
    // (existedBefore=true → PowerShell-first). The fresh-create branch has its
    // own dedicated describe below ("fresh-vs-overwrite primitive selection").
    fsMock.existsSync.mockReturnValue(true);
  });

  it('creates the parent directory and writes the token file', async () => {
    fsMock.existsSync.mockReturnValue(false);

    const { secureWriteTokenFile } = await import('../security');
    const tokenPath = path.join('C:', 'Users', 'tester', '.wmux', 'daemon-auth-token');

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
      fsMock.existsSync.mockReturnValue(true);

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

  it('rebuilds the DACL via a DACL-only PowerShell primitive (SID payload over stdin, never Set-Acl) on Windows', async () => {
    vi.stubEnv('USERNAME', 'tester');
    vi.stubEnv('SystemRoot', 'C:\\Windows');
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    stubPowershellPresent(true);
    stubWhoamiSid('S-1-5-21-1-2-3-1001');

    const { secureWriteTokenFile } = await import('../security');
    const tokenPath = path.join('C:', 'Users', 'tester', '.wmux-auth-token');
    secureWriteTokenFile(tokenPath, 'secret-token');

    // SID is resolved via whoami first...
    expect(execFileSyncMock).toHaveBeenCalledWith(
      'C:\\Windows\\System32\\whoami.exe',
      ['/user', '/fo', 'list'],
      { windowsHide: true },
    );
    // ...then powershell runs an encoded, non-interactive DACL rebuild.
    const psCall = powershellCall();
    expect(psCall?.[0]).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
    expect(powershellArgs()?.slice(0, 5)).toEqual([
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-EncodedCommand',
    ]);
    // Identity travels over stdin (NOT argv) so a non-ASCII path/name cannot be
    // mangled by the console OEM codepage; the target path travels via env.
    expect(powershellPayload()).toEqual({ sid: 'S-1-5-21-1-2-3-1001' });
    expect((psCall?.[2]?.env as Record<string, string>)?.WMUX_ACL_TARGET).toBe(tokenPath);
    // PSModulePath must be STRIPPED from the 5.1 child — case-insensitively,
    // since Windows env keys are case-insensitive and the parent may have set
    // any casing: an inherited pwsh 7 module path makes 5.1 auto-load the
    // Core-edition module for Get-Item and fail, silently degrading the #124
    // rebuild to the icacls fallback.
    const syncEnvKeys = Object.keys((psCall?.[2]?.env as Record<string, string>) ?? {});
    expect(syncEnvKeys.filter((k) => k.toLowerCase() === 'psmodulepath')).toEqual([]);
    // The child's stdout is discarded (no CLIXML leak); stderr kept for errors.
    expect(psCall?.[2]?.stdio).toEqual(['pipe', 'ignore', 'pipe']);
    // Crucially the DACL-only primitive: protect (discard inheritance) + a fresh
    // FileSecurity written via FileInfo.SetAccessControl (NOT the Set-Acl cmdlet,
    // which would try to re-stamp Owner/Group and throw SeSecurityPrivilege on
    // the upgrade-from-icacls state — issue #124).
    const script = decodedPowershellScript() ?? '';
    expect(script).toContain('SetAccessRuleProtection($true, $false)');
    expect(script).toContain('.SetAccessControl(');
    expect(script).toContain('FileSystemRights]::FullControl');
    expect(script).not.toContain('Set-Acl');
    // icacls is the fallback only; it must NOT run when PowerShell is present.
    expect(icaclsCall()).toBeUndefined();
  });

  it('falls back to the icacls DACL strip (owner FC + /inheritance:r + remove broad SIDs) when PowerShell is absent', async () => {
    vi.stubEnv('USERNAME', 'tester');
    vi.stubEnv('SystemRoot', 'C:\\Windows');
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    stubPowershellPresent(false); // Server Core / hardened SKU
    stubWhoamiSid('S-1-5-21-1-2-3-1001');

    const { secureWriteTokenFile } = await import('../security');
    const tokenPath = path.join('C:', 'Users', 'tester', '.wmux-auth-token');
    secureWriteTokenFile(tokenPath, 'secret-token');

    // PowerShell must NOT run; icacls carries the hardening instead.
    expect(powershellCall()).toBeUndefined();
    expect(icaclsArgs()).toEqual([
      tokenPath,
      '/grant:r',
      '*S-1-5-21-1-2-3-1001:F',
      '/inheritance:r',
      // explicit removal of the well-known broad principals by SID
      '/remove:g',
      '*S-1-1-0', // Everyone
      '/remove:g',
      '*S-1-5-32-545', // BUILTIN\Users
      '/remove:g',
      '*S-1-5-11', // Authenticated Users
      '/remove:g',
      '*S-1-5-4', // INTERACTIVE
    ]);
  });

  // Regression (codex PR #140): PowerShell EXISTS but is unusable — AppLocker /
  // Constrained Language Mode blocks the .NET ACL calls, so the powershell.exe
  // invocation throws. The write path must DEGRADE to the icacls fallback (which
  // still strips the common broad ACEs) rather than abort and delete the token.
  it('falls through to icacls when PowerShell is present but the .NET rebuild throws (AppLocker/CLM)', async () => {
    vi.stubEnv('USERNAME', 'tester');
    vi.stubEnv('SystemRoot', 'C:\\Windows');
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    stubPowershellPresent(true); // powershell.exe is on disk...
    execFileSyncMock.mockImplementation((cmd: unknown) => {
      const c = typeof cmd === 'string' ? cmd.toLowerCase() : '';
      if (c.includes('whoami')) {
        return Buffer.from('User Name: machine\\user\nSID:       S-1-5-21-1-2-3-1001\n');
      }
      if (c.includes('powershell')) {
        throw new Error('AppLocker blocked this script'); // ...but blocked at runtime
      }
      return Buffer.from(''); // icacls succeeds
    });

    const { secureWriteTokenFile } = await import('../security');
    const tokenPath = path.join('C:', 'Users', 'tester', '.wmux-auth-token');

    // Must NOT throw — the icacls fallback hardened the file.
    expect(() => secureWriteTokenFile(tokenPath, 'secret-token')).not.toThrow();
    // PowerShell was attempted, then icacls carried the hardening.
    expect(powershellCall()).toBeDefined();
    expect(icaclsArgs()).toEqual([
      tokenPath,
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
    // The token survives — fail-closed deletion must NOT fire when the fallback worked.
    expect(fsMock.unlinkSync).not.toHaveBeenCalled();
  });

  // When BOTH the PowerShell primary AND the icacls fallback fail, the write path
  // must still fail closed: delete the un-hardenable token and throw.
  it('fails closed (deletes + throws) when BOTH PowerShell and the icacls fallback throw', async () => {
    vi.stubEnv('USERNAME', 'tester');
    vi.stubEnv('SystemRoot', 'C:\\Windows');
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    stubPowershellPresent(true);
    execFileSyncMock.mockImplementation((cmd: unknown) => {
      const c = typeof cmd === 'string' ? cmd.toLowerCase() : '';
      if (c.includes('whoami')) {
        return Buffer.from('User Name: machine\\user\nSID:       S-1-5-21-1-2-3-1001\n');
      }
      throw new Error(c.includes('powershell') ? 'CLM blocked' : 'icacls denied');
    });

    const { secureWriteTokenFile } = await import('../security');
    const tokenPath = path.join('C:', 'Users', 'tester', '.wmux-auth-token');

    expect(() => secureWriteTokenFile(tokenPath, 'secret-token')).toThrow(
      `Failed to set secure ACL on ${tokenPath}: icacls denied`,
    );
    expect(powershellCall()).toBeDefined();
    expect(icaclsCall()).toBeDefined();
    expect(fsMock.unlinkSync).toHaveBeenCalledWith(tokenPath);
  });

  it('parses the SID field instead of SID-like text in the account name', async () => {
    vi.stubEnv('USERNAME', 'victim');
    vi.stubEnv('SystemRoot', 'C:\\Windows');
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    stubPowershellPresent(true);
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
    const tokenPath = path.join('C:', 'Users', 'victim', '.wmux-auth-token');
    secureWriteTokenFile(tokenPath, 'secret-token');

    // The owner identity is the SID FIELD, never the SID-like account-name text.
    expect(powershellPayload()).toEqual({ sid: 'S-1-5-21-1111111111-2222222222-3333333333-1001' });
    expect(JSON.stringify(powershellPayload())).not.toContain('S-1-1-0');
  });

  // Regression: a non-ASCII (Korean) profile name passed verbatim to a native
  // ACL tool is mangled into a ghost principal, granting Full control to a
  // non-existent account while the real owner gets nothing — locking the owner
  // out of their own token file. Identifying by SID (pure ASCII) avoids this.
  it('never passes a non-ASCII username to native ACL tooling (Korean-account lock-out regression)', async () => {
    vi.stubEnv('USERNAME', '홍길동');
    vi.stubEnv('SystemRoot', 'C:\\Windows');
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    stubPowershellPresent(true);
    stubWhoamiSid('S-1-5-21-1-2-3-1001');

    const { secureWriteTokenFile } = await import('../security');
    const tokenPath = path.join('C:', 'Users', '홍길동', '.wmux-auth-token');
    secureWriteTokenFile(tokenPath, 'secret-token');

    // The owner identity passed to native ACL tooling is the SID, never the raw
    // username — the file PATH legitimately still contains the Korean name.
    expect(powershellPayload()).toEqual({ sid: 'S-1-5-21-1-2-3-1001' });
    expect(JSON.stringify(powershellPayload())).not.toContain('홍길동');
  });

  it('falls back to %USERNAME% (over stdin) when the SID cannot be resolved', async () => {
    vi.stubEnv('USERNAME', 'tester');
    vi.stubEnv('SystemRoot', 'C:\\Windows');
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    stubPowershellPresent(true);
    execFileSyncMock.mockImplementation((cmd: unknown) => {
      if (typeof cmd === 'string' && cmd.toLowerCase().includes('whoami')) {
        throw new Error('whoami unavailable');
      }
      return Buffer.from('');
    });

    const { secureWriteTokenFile } = await import('../security');
    const tokenPath = path.join('C:', 'Users', 'tester', '.wmux-auth-token');
    secureWriteTokenFile(tokenPath, 'secret-token');

    expect(powershellPayload()).toEqual({ sid: null, username: 'tester' });
  });

  it('falls back to the icacls strip with an ASCII *USERNAME* principal when SID unresolved AND PowerShell absent', async () => {
    vi.stubEnv('USERNAME', 'tester');
    vi.stubEnv('SystemRoot', 'C:\\Windows');
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    stubPowershellPresent(false);
    execFileSyncMock.mockImplementation((cmd: unknown) => {
      if (typeof cmd === 'string' && cmd.toLowerCase().includes('whoami')) {
        throw new Error('whoami unavailable');
      }
      return Buffer.from('');
    });

    const { secureWriteTokenFile } = await import('../security');
    const tokenPath = path.join('C:', 'Users', 'tester', '.wmux-auth-token');
    secureWriteTokenFile(tokenPath, 'secret-token');

    // Username (pure ASCII) is the principal; no `*` SID prefix.
    expect(icaclsArgs()?.slice(0, 4)).toEqual([
      tokenPath,
      '/grant:r',
      'tester:F',
      '/inheritance:r',
    ]);
  });

  // Guard: when the SID can't be resolved, the %USERNAME% fallback must NOT be
  // used for a non-ASCII account — that would re-create the very ghost-principal
  // lock-out this code exists to prevent (and re-apply it on every load). The
  // write path must refuse: never run any ACL tool with the mangling-prone name,
  // and delete the just-written (now un-hardenable) token rather than leave it loose.
  it('refuses (throws + deletes, no ACL tooling) when SID unresolved AND USERNAME is non-ASCII', async () => {
    vi.stubEnv('USERNAME', '홍길동');
    vi.stubEnv('SystemRoot', 'C:\\Windows');
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    stubPowershellPresent(true);
    // whoami fails → SID unresolved; the only fallback would be the Korean name.
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
    // Neither ACL tool may run with the mangling-prone principal...
    expect(powershellCall()).toBeUndefined();
    expect(icaclsCall()).toBeUndefined();
    // ...and the un-hardenable token is removed (fail-closed, like any ACL fail).
    expect(fsMock.unlinkSync).toHaveBeenCalledWith(tokenPath);
  });

  it('deletes the token file and throws when Windows ACL hardening fails', async () => {
    vi.stubEnv('USERNAME', 'tester');
    vi.stubEnv('SystemRoot', 'C:\\Windows');
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    stubPowershellPresent(true);
    // whoami resolves fine; the PowerShell DACL rebuild is the step that fails.
    execFileSyncMock.mockImplementation((cmd: unknown) => {
      if (typeof cmd === 'string' && cmd.toLowerCase().includes('whoami')) {
        return Buffer.from('User Name: machine\\user\nSID:       S-1-5-21-1-2-3-1001\n');
      }
      throw new Error('ACL rebuild failed');
    });

    const { secureWriteTokenFile } = await import('../security');
    const tokenPath = path.join('C:', 'Users', 'tester', '.wmux-auth-token');

    expect(() => secureWriteTokenFile(tokenPath, 'secret-token')).toThrow(
      `Failed to set secure ACL on ${tokenPath}: ACL rebuild failed`,
    );
    expect(fsMock.unlinkSync).toHaveBeenCalledWith(tokenPath);
  });
});

// RCA A12 — re-hardening an EXISTING token file's permissions without
// rewriting its contents (the bug: tokens loaded from disk kept loose ACLs).
describe('reHardenTokenFileAcl', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    // clearAllMocks resets call history but NOT mockImplementation; the prior
    // describe's failing-ACL test would otherwise leak its throw into here.
    execFileSyncMock.mockReset();
    fsMock.existsSync.mockReset();
    fsMock.existsSync.mockReturnValue(true);
    fsMock.chmodSync.mockReset();
  });

  it('re-applies the DACL-only rebuild on Windows and returns true', async () => {
    vi.stubEnv('USERNAME', 'tester');
    vi.stubEnv('SystemRoot', 'C:\\Windows');
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    stubPowershellPresent(true);
    stubWhoamiSid('S-1-5-21-1-2-3-1001');

    const { reHardenTokenFileAcl } = await import('../security');
    const tokenPath = path.join('C:', 'Users', 'tester', '.wmux-auth-token');

    const ok = reHardenTokenFileAcl(tokenPath);

    expect(ok).toBe(true);
    expect(powershellPayload()).toEqual({ sid: 'S-1-5-21-1-2-3-1001' });
    expect(decodedPowershellScript() ?? '').toContain('.SetAccessControl(');
    // Must NOT rewrite the token contents — only the ACL.
    expect(fsMock.writeFileSync).not.toHaveBeenCalled();
  });

  it('chmods to 0600 on POSIX and returns true', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');

    const { reHardenTokenFileAcl } = await import('../security');
    const tokenPath = '/home/tester/.wmux-auth-token';

    const ok = reHardenTokenFileAcl(tokenPath);

    expect(ok).toBe(true);
    expect(fsMock.chmodSync).toHaveBeenCalledWith(tokenPath, 0o600);
    expect(fsMock.writeFileSync).not.toHaveBeenCalled();
  });

  // Guard (re-harden side): SID unresolved + non-ASCII USERNAME must fail soft —
  // never run an ACL tool with the mangling-prone name, never delete the working
  // token. Re-locking the owner out on every load is worse than leaving the
  // file's current ACL untouched.
  it('returns false without running ACL tooling when SID unresolved AND USERNAME is non-ASCII', async () => {
    vi.stubEnv('USERNAME', '홍길동');
    vi.stubEnv('SystemRoot', 'C:\\Windows');
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    stubPowershellPresent(true);
    execFileSyncMock.mockImplementation((cmd: unknown) => {
      if (typeof cmd === 'string' && cmd.toLowerCase().includes('whoami')) {
        throw new Error('whoami unavailable');
      }
      return Buffer.from('');
    });

    const { reHardenTokenFileAcl } = await import('../security');
    const tokenPath = path.join('C:', 'Users', '홍길동', '.wmux-auth-token');

    expect(reHardenTokenFileAcl(tokenPath)).toBe(false);
    expect(powershellCall()).toBeUndefined();
    expect(icaclsCall()).toBeUndefined();
    expect(fsMock.unlinkSync).not.toHaveBeenCalled();
  });

  it('returns false (does NOT throw) when hardening fails — best-effort', async () => {
    vi.stubEnv('USERNAME', 'tester');
    vi.stubEnv('SystemRoot', 'C:\\Windows');
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    stubPowershellPresent(true);
    execFileSyncMock.mockImplementation((cmd: unknown) => {
      // whoami succeeds; the PowerShell DACL rebuild denies — must fail soft.
      if (typeof cmd === 'string' && cmd.toLowerCase().includes('whoami')) {
        return Buffer.from('User Name: machine\\user\nSID:       S-1-5-21-1-2-3-1001\n');
      }
      throw new Error('ACL rebuild denied');
    });

    const { reHardenTokenFileAcl } = await import('../security');
    const tokenPath = path.join('C:', 'Users', 'tester', '.wmux-auth-token');

    // A live daemon must not crash because it couldn't tighten perms.
    expect(() => reHardenTokenFileAcl(tokenPath)).not.toThrow();
    expect(reHardenTokenFileAcl(tokenPath)).toBe(false);
    // The existing (possibly-loose) token file is NOT deleted — unlike the
    // write path, we keep the working token rather than break auth.
    expect(fsMock.unlinkSync).not.toHaveBeenCalled();
  });
});

// S-A cold-start: the write path picks its primitive by whether the file
// existed BEFORE the write. A fresh file carries only inherited ACEs, so the
// fast icacls strip is security-equivalent to the PowerShell DACL rebuild;
// an OVERWRITE (rotation, empty-file repair) may carry pre-existing EXPLICIT
// broad ACEs that only the PowerShell rebuild removes (#124) — it must keep
// the PowerShell-first order.
describe('secureWriteTokenFile — fresh-vs-overwrite primitive selection (S-A)', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    execFileSyncMock.mockReset();
    fsMock.existsSync.mockReset();
  });

  function stubTokenFileExists(exists: boolean): void {
    // Token file existence drives the fresh/overwrite branch; every other
    // existsSync (parent dir, powershell.exe) stays true.
    fsMock.existsSync.mockImplementation((p: unknown) =>
      typeof p === 'string' && p.toLowerCase().includes('auth-token') ? exists : true,
    );
  }

  it('fresh file (did not exist) → icacls FIRST, PowerShell never runs', async () => {
    vi.stubEnv('USERNAME', 'tester');
    vi.stubEnv('SystemRoot', 'C:\\Windows');
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    stubTokenFileExists(false);
    stubWhoamiSid('S-1-5-21-1-2-3-1001');

    const { secureWriteTokenFile } = await import('../security');
    const tokenPath = path.join('C:', 'Users', 'tester', '.wmux-auth-token');
    secureWriteTokenFile(tokenPath, 'secret-token');

    expect(icaclsArgs()?.slice(0, 4)).toEqual([
      tokenPath,
      '/grant:r',
      '*S-1-5-21-1-2-3-1001:F',
      '/inheritance:r',
    ]);
    expect(powershellCall()).toBeUndefined();
  });

  it('overwrite (existed before) → PowerShell-first order is preserved (#124)', async () => {
    vi.stubEnv('USERNAME', 'tester');
    vi.stubEnv('SystemRoot', 'C:\\Windows');
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    stubTokenFileExists(true);
    stubWhoamiSid('S-1-5-21-1-2-3-1001');

    const { secureWriteTokenFile } = await import('../security');
    const tokenPath = path.join('C:', 'Users', 'tester', '.wmux-auth-token');
    secureWriteTokenFile(tokenPath, 'secret-token');

    expect(powershellCall()).toBeDefined();
    expect(icaclsCall()).toBeUndefined();
  });

  it('fresh file: icacls failure falls back to PowerShell (fail-closed preserved when BOTH fail)', async () => {
    vi.stubEnv('USERNAME', 'tester');
    vi.stubEnv('SystemRoot', 'C:\\Windows');
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    stubTokenFileExists(false);
    execFileSyncMock.mockImplementation((cmd: unknown) => {
      const c = typeof cmd === 'string' ? cmd.toLowerCase() : '';
      if (c.includes('whoami')) {
        return Buffer.from('User Name: machine\\user\nSID:       S-1-5-21-1-2-3-1001\n');
      }
      if (c.includes('icacls')) throw new Error('icacls denied');
      return Buffer.from(''); // PowerShell succeeds
    });

    const { secureWriteTokenFile } = await import('../security');
    const tokenPath = path.join('C:', 'Users', 'tester', '.wmux-auth-token');

    expect(() => secureWriteTokenFile(tokenPath, 'secret-token')).not.toThrow();
    expect(icaclsCall()).toBeDefined();
    expect(powershellCall()).toBeDefined();
    expect(fsMock.unlinkSync).not.toHaveBeenCalled();

    // Now make PowerShell fail too — fail-closed (delete + throw) must fire.
    vi.resetModules();
    execFileSyncMock.mockReset();
    fsMock.unlinkSync.mockReset();
    stubTokenFileExists(false);
    execFileSyncMock.mockImplementation((cmd: unknown) => {
      const c = typeof cmd === 'string' ? cmd.toLowerCase() : '';
      if (c.includes('whoami')) {
        return Buffer.from('User Name: machine\\user\nSID:       S-1-5-21-1-2-3-1001\n');
      }
      throw new Error(c.includes('icacls') ? 'icacls denied' : 'CLM blocked');
    });
    const fresh = await import('../security');
    expect(() => fresh.secureWriteTokenFile(tokenPath, 'secret-token')).toThrow(
      /Failed to set secure ACL/,
    );
    expect(fsMock.unlinkSync).toHaveBeenCalledWith(tokenPath);
  });
});

// S-A deferred re-harden: same best-effort contract and primitive order as the
// sync reHardenTokenFileAcl, but fully async (execFile/spawn, never *Sync) so
// the multi-second PowerShell shell-out can never stall the event loop of the
// process that scheduled it (in the daemon that would time out the launcher's
// first ping against the freshly-opened control pipe).
describe('scheduleTokenFileReHarden (S-A deferred re-harden)', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    execFileSyncMock.mockReset();
    execFileMock.mockReset();
    spawnMock.mockReset();
    fsMock.existsSync.mockReset();
    fsMock.existsSync.mockReturnValue(true);
    fsMock.promises.chmod.mockReset();
    fsMock.promises.chmod.mockResolvedValue(undefined);
  });

  /** Fake spawn() child: stdin sink, stderr emitter, close with exitCode. */
  function stubPowershellSpawn(exitCode: number): {
    stdinWrites: string[];
  } {
    const stdinWrites: string[] = [];
    spawnMock.mockImplementation(() => ({
      stdin: {
        write: (chunk: string) => { stdinWrites.push(chunk); return true; },
        end: vi.fn(),
        on: vi.fn(),
      },
      stderr: { on: vi.fn() },
      on: (ev: string, cb: (arg?: unknown) => void) => {
        if (ev === 'close') setImmediate(() => cb(exitCode));
      },
    }));
    return { stdinWrites };
  }

  /** execFile mock: whoami answers with a SID; icacls succeeds/fails. */
  function stubAsyncExecFile(opts: { icaclsError?: Error } = {}): void {
    execFileMock.mockImplementation(
      (cmd: unknown, _args: unknown, _opts: unknown, cb?: (err: Error | null, stdout?: string) => void) => {
        const done = (typeof _opts === 'function' ? _opts : cb) as (
          err: Error | null,
          stdout?: string,
        ) => void;
        const c = typeof cmd === 'string' ? cmd.toLowerCase() : '';
        setImmediate(() => {
          if (c.includes('whoami')) {
            done(null, 'User Name: machine\\user\nSID:       S-1-5-21-1-2-3-1001\n');
          } else if (c.includes('icacls')) {
            done(opts.icaclsError ?? null, '');
          } else {
            done(null, '');
          }
        });
      },
    );
  }

  async function flushScheduled(): Promise<void> {
    // setImmediate chain: scheduler → whoami → spawn close → possible icacls.
    for (let i = 0; i < 8; i++) {
      await new Promise<void>((r) => setImmediate(r));
    }
  }

  it('POSIX: chmods 0600 asynchronously', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');

    const { scheduleTokenFileReHarden } = await import('../security');
    scheduleTokenFileReHarden('/home/tester/.wmux-auth-token');
    await flushScheduled();

    expect(fsMock.promises.chmod).toHaveBeenCalledWith('/home/tester/.wmux-auth-token', 0o600);
    // No sync primitives on the deferred path — that is its entire point.
    expect(execFileSyncMock).not.toHaveBeenCalled();
    expect(fsMock.chmodSync).not.toHaveBeenCalled();
  });

  it('win32: resolves the SID via async whoami and rebuilds the DACL via spawned PowerShell (stdin payload)', async () => {
    vi.stubEnv('USERNAME', 'tester');
    vi.stubEnv('SystemRoot', 'C:\\Windows');
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    stubAsyncExecFile();
    const ps = stubPowershellSpawn(0);

    const { scheduleTokenFileReHarden } = await import('../security');
    const tokenPath = path.join('C:', 'Users', 'tester', '.wmux-auth-token');
    scheduleTokenFileReHarden(tokenPath);
    await flushScheduled();

    // whoami went through ASYNC execFile…
    expect(execFileMock).toHaveBeenCalledWith(
      'C:\\Windows\\System32\\whoami.exe',
      ['/user', '/fo', 'list'],
      { windowsHide: true },
      expect.any(Function),
    );
    // …PowerShell through spawn with the identity over stdin and the target via env.
    const spawnCall = spawnMock.mock.calls[0];
    expect(String(spawnCall[0]).toLowerCase()).toContain('powershell');
    expect((spawnCall[2] as { env: Record<string, string> }).env.WMUX_ACL_TARGET).toBe(tokenPath);
    // Same case-insensitive PSModulePath strip as the sync path
    // (pwsh7-inherited module path breaks 5.1 cmdlet auto-loading).
    const asyncEnvKeys = Object.keys((spawnCall[2] as { env: Record<string, string> }).env);
    expect(asyncEnvKeys.filter((k) => k.toLowerCase() === 'psmodulepath')).toEqual([]);
    expect(JSON.parse(ps.stdinWrites.join(''))).toEqual({ sid: 'S-1-5-21-1-2-3-1001' });
    // Nothing synchronous ran.
    expect(execFileSyncMock).not.toHaveBeenCalled();
    // PowerShell succeeded → no icacls fallback.
    const icaclsAsync = execFileMock.mock.calls.find(([cmd]) =>
      String(cmd).toLowerCase().includes('icacls'),
    );
    expect(icaclsAsync).toBeUndefined();
  });

  it('win32: falls back to async icacls when the spawned PowerShell exits non-zero', async () => {
    vi.stubEnv('USERNAME', 'tester');
    vi.stubEnv('SystemRoot', 'C:\\Windows');
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    stubAsyncExecFile();
    stubPowershellSpawn(1);

    const { scheduleTokenFileReHarden } = await import('../security');
    const tokenPath = path.join('C:', 'Users', 'tester', '.wmux-auth-token');
    scheduleTokenFileReHarden(tokenPath);
    await flushScheduled();

    const icaclsAsync = execFileMock.mock.calls.find(([cmd]) =>
      String(cmd).toLowerCase().includes('icacls'),
    );
    expect(icaclsAsync).toBeDefined();
    expect((icaclsAsync?.[1] as unknown[])?.slice(0, 4)).toEqual([
      tokenPath,
      '/grant:r',
      '*S-1-5-21-1-2-3-1001:F',
      '/inheritance:r',
    ]);
  });

  it('win32: never throws to the caller when every primitive fails (best-effort, like the sync path)', async () => {
    vi.stubEnv('USERNAME', 'tester');
    vi.stubEnv('SystemRoot', 'C:\\Windows');
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    stubAsyncExecFile({ icaclsError: new Error('icacls denied') });
    stubPowershellSpawn(1);
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
    process.on('unhandledRejection', onUnhandled);

    try {
      const { scheduleTokenFileReHarden } = await import('../security');
      const tokenPath = path.join('C:', 'Users', 'tester', '.wmux-auth-token');
      expect(() => scheduleTokenFileReHarden(tokenPath)).not.toThrow();
      await flushScheduled();
      expect(unhandled).toEqual([]);
      // The existing token is never deleted on the re-harden path.
      expect(fsMock.unlinkSync).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});

/**
 * `secureReplaceTokenFile` — the repeated-write path.
 *
 * The property under test is not "it writes the file". It is that replacing a
 * token file never takes the PowerShell rebuild (the 1.8-3.8s stall that made
 * removing a remote host freeze the app on Windows) AND never publishes the
 * new bytes before they are hardened. Those two pull in opposite directions,
 * which is why this is not just a call to the existing writer.
 */
describe('secureReplaceTokenFile', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    execFileSyncMock.mockReset();
    fsMock.existsSync.mockReset();
    fsMock.renameSync.mockReset();
    fsMock.openSync.mockReset().mockReturnValue(7);
    fsMock.closeSync.mockReset();
    fsMock.fsyncSync.mockReset();
    fsMock.readdirSync.mockReset().mockReturnValue([]);
  });

  const target = () => path.join('C:', 'Users', 'tester', '.wmux', 'remoteHosts.json');

  function winSetup(): void {
    vi.stubEnv('USERNAME', 'tester');
    vi.stubEnv('SystemRoot', 'C:\\Windows');
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    stubPowershellPresent(true);
    stubWhoamiSid('S-1-5-21-1-2-3-1001');
    fsMock.existsSync.mockReturnValue(true);
  }

  it('creates the temp exclusively, under a name an attacker cannot predict', async () => {
    winSetup();
    const { secureReplaceTokenFile } = await import('../security');
    secureReplaceTokenFile(target(), '[]');

    const [tmpPath, flags, mode] = fsMock.openSync.mock.calls.at(-1)!;
    expect(String(tmpPath)).toMatch(/\.[0-9a-f]{24}\.tmp$/);   // random, not pid+time
    // O_EXCL is what refuses a planted symlink instead of following it.
    expect(Number(flags) & fsMock.constants.O_EXCL).toBeTruthy();
    expect(Number(flags) & fsMock.constants.O_CREAT).toBeTruthy();
    expect(mode).toBe(0o600);
  });

  it('hardens the temp BEFORE the credential is written into it', async () => {
    winSetup();
    const { secureReplaceTokenFile } = await import('../security');
    secureReplaceTokenFile(target(), '[{"token":"secret"}]');

    const icaclsOrder = execFileSyncMock.mock.invocationCallOrder.at(-1)!;
    const writeOrder = fsMock.writeFileSync.mock.invocationCallOrder.at(-1)!;
    // The in-place path wrote into an already-hardened file. A fresh inode
    // starts with only the parent's inherited ACEs, so the content must not
    // land before the lockdown does.
    expect(icaclsOrder).toBeLessThan(writeOrder);
  });

  it('never takes the PowerShell rebuild — that stall is the whole point', async () => {
    winSetup();
    const { secureReplaceTokenFile } = await import('../security');
    secureReplaceTokenFile(target(), '[]');

    const ps = execFileSyncMock.mock.calls.find((c) => String(c[0]).includes('powershell.exe'));
    expect(ps).toBeFalsy();
  });

  it('fsyncs the content, then renames', async () => {
    winSetup();
    const { secureReplaceTokenFile } = await import('../security');
    secureReplaceTokenFile(target(), '[]');

    const fsyncOrder = fsMock.fsyncSync.mock.invocationCallOrder[0]!;
    const renameOrder = fsMock.renameSync.mock.invocationCallOrder.at(-1)!;
    expect(fsyncOrder).toBeLessThan(renameOrder);
  });

  // Windows + antivirus is the environment this function exists to serve, and
  // it is the one where a scanner holds the handle of the file icacls just
  // touched. A bare rename would throw there.
  it('retries a transient rename failure on Windows', async () => {
    winSetup();
    let calls = 0;
    fsMock.renameSync.mockImplementation(() => {
      calls++;
      if (calls < 3) {
        const err = new Error('EBUSY') as NodeJS.ErrnoException;
        err.code = 'EBUSY';
        throw err;
      }
    });

    const { secureReplaceTokenFile } = await import('../security');
    expect(() => secureReplaceTokenFile(target(), '[]')).not.toThrow();
    expect(calls).toBe(3);
  });

  it('does not retry a non-transient rename failure', async () => {
    winSetup();
    fsMock.renameSync.mockImplementation(() => {
      const err = new Error('ENOSPC') as NodeJS.ErrnoException;
      err.code = 'ENOSPC';
      throw err;
    });

    const { secureReplaceTokenFile } = await import('../security');
    expect(() => secureReplaceTokenFile(target(), '[]')).toThrow(/Failed to securely replace/);
    expect(fsMock.renameSync).toHaveBeenCalledTimes(1);
  });

  it('leaves the previous file untouched when hardening fails, and drops the temp', async () => {
    vi.stubEnv('USERNAME', 'tester');
    vi.stubEnv('SystemRoot', 'C:\\Windows');
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    stubPowershellPresent(false);
    fsMock.existsSync.mockReturnValue(true);
    execFileSyncMock.mockImplementation(() => { throw new Error('icacls denied'); });

    const { secureReplaceTokenFile } = await import('../security');
    expect(() => secureReplaceTokenFile(target(), '[]')).toThrow(/Failed to securely replace/);

    expect(fsMock.renameSync).not.toHaveBeenCalled();
    const unlinked = fsMock.unlinkSync.mock.calls.at(-1);
    expect(String(unlinked?.[0])).toContain('.tmp');
    // The credential never reached the real name, and nothing was written into
    // the temp either — hardening failed before the content step.
    expect(fsMock.writeFileSync).not.toHaveBeenCalled();
  });

  it('delegates the very first write to the fresh-file path', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    const t = path.join('/home', 'u', '.wmux', 'remoteHosts.json');
    fsMock.existsSync.mockImplementation((p: unknown) => String(p) !== t);

    const { secureReplaceTokenFile } = await import('../security');
    secureReplaceTokenFile(t, '[]');

    expect(fsMock.writeFileSync).toHaveBeenCalledWith(t, '[]', { encoding: 'utf8', mode: 0o600 });
    expect(fsMock.renameSync).not.toHaveBeenCalled();
  });
});

describe('sweepStaleTokenTemps', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    fsMock.readdirSync.mockReset();
    fsMock.unlinkSync.mockReset();
  });

  // A crash between write and rename leaves a full copy of the credentials
  // under a temp name. Owner-only, but nothing else in the tree ever looks at
  // them, so without this they accumulate for the life of the install.
  it('removes only this file\'s leftover temps', async () => {
    const t = path.join('/home', 'u', '.wmux', 'remoteHosts.json');
    fsMock.readdirSync.mockReturnValue([
      'remoteHosts.json',
      'remoteHosts.json.aabbccddeeff001122334455.tmp',
      'remoteHosts.json.99887766554433221100ffee.tmp',
      'devices.json.deadbeefdeadbeefdeadbeef.tmp',
      'unrelated.txt',
    ]);

    const { sweepStaleTokenTemps } = await import('../security');
    sweepStaleTokenTemps(t);

    const removed = fsMock.unlinkSync.mock.calls.map((c) => path.basename(String(c[0]))).sort();
    expect(removed).toEqual([
      'remoteHosts.json.99887766554433221100ffee.tmp',
      'remoteHosts.json.aabbccddeeff001122334455.tmp',
    ]);
  });

  it('never throws when the directory cannot be read', async () => {
    fsMock.readdirSync.mockImplementation(() => { throw new Error('EACCES'); });
    const { sweepStaleTokenTemps } = await import('../security');
    expect(() => sweepStaleTokenTemps('/nope/remoteHosts.json')).not.toThrow();
  });
});
