import * as path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fsMock = vi.hoisted(() => ({
  existsSync: vi.fn(),
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
  unlinkSync: vi.fn(),
  chmodSync: vi.fn(),
}));

const execFileSyncMock = vi.hoisted(() => vi.fn());

vi.mock('fs', () => ({
  existsSync: fsMock.existsSync,
  mkdirSync: fsMock.mkdirSync,
  writeFileSync: fsMock.writeFileSync,
  unlinkSync: fsMock.unlinkSync,
  chmodSync: fsMock.chmodSync,
}));

vi.mock('child_process', () => ({
  execFileSync: execFileSyncMock,
}));

// Make execFileSync answer `whoami /user` with a fixed SID while leaving every
// other invocation (icacls) returning empty. Mirrors the real two-call flow:
// applyRestrictiveWindowsAcl resolves the SID first, then runs icacls.
function stubWhoamiSid(sid: string): void {
  execFileSyncMock.mockImplementation((cmd: unknown) =>
    typeof cmd === 'string' && cmd.toLowerCase().includes('whoami')
      ? Buffer.from(`\nUser Name        SID\n=============== ${'='.repeat(40)}\nmachine\\user    ${sid}\n`)
      : Buffer.from(''),
  );
}

// Pull out the args of the icacls invocation (the whoami call is bookkeeping).
function icaclsArgs(): unknown[] | undefined {
  const call = execFileSyncMock.mock.calls.find(
    ([cmd]) => typeof cmd === 'string' && cmd.toLowerCase().includes('icacls'),
  );
  return call?.[1] as unknown[] | undefined;
}

describe('secureWriteTokenFile', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    execFileSyncMock.mockReset();
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

  it('grants Full control by SID, with /grant before /inheritance:r, on Windows', async () => {
    vi.stubEnv('USERNAME', 'tester');
    vi.stubEnv('SystemRoot', 'C:\\Windows');
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
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
    // ...then icacls grants by *SID, and crucially /grant comes BEFORE
    // /inheritance:r so the owner keeps WRITE_DAC through the inheritance strip.
    expect(icaclsArgs()).toEqual([
      tokenPath,
      '/grant:r',
      '*S-1-5-21-1-2-3-1001:F',
      '/inheritance:r',
    ]);
  });

  // Regression: a non-ASCII (Korean) profile name passed verbatim to icacls is
  // mangled into a ghost principal (`홍길동\:(F)`), granting Full control to a
  // non-existent account while the real owner gets nothing — locking the owner
  // out of their own token file. Granting by SID (pure ASCII) avoids this.
  it('never passes a non-ASCII username to icacls (Korean-account lock-out regression)', async () => {
    vi.stubEnv('USERNAME', '홍길동');
    vi.stubEnv('SystemRoot', 'C:\\Windows');
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    stubWhoamiSid('S-1-5-21-1-2-3-1001');

    const { secureWriteTokenFile } = await import('../security');
    const tokenPath = path.join('C:', 'Users', '홍길동', '.wmux-auth-token');
    secureWriteTokenFile(tokenPath, 'secret-token');

    expect(icaclsArgs()).toEqual([
      tokenPath,
      '/grant:r',
      '*S-1-5-21-1-2-3-1001:F',
      '/inheritance:r',
    ]);
    // The grant target (the principal arg) must be the *SID, never the raw
    // username — the file PATH legitimately still contains the Korean name.
    expect(icaclsArgs()?.[2]).not.toContain('홍길동');
  });

  it('falls back to %USERNAME% when the SID cannot be resolved', async () => {
    vi.stubEnv('USERNAME', 'tester');
    vi.stubEnv('SystemRoot', 'C:\\Windows');
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    execFileSyncMock.mockImplementation((cmd: unknown) => {
      if (typeof cmd === 'string' && cmd.toLowerCase().includes('whoami')) {
        throw new Error('whoami unavailable');
      }
      return Buffer.from('');
    });

    const { secureWriteTokenFile } = await import('../security');
    const tokenPath = path.join('C:', 'Users', 'tester', '.wmux-auth-token');
    secureWriteTokenFile(tokenPath, 'secret-token');

    expect(icaclsArgs()).toEqual([
      tokenPath,
      '/grant:r',
      'tester:F',
      '/inheritance:r',
    ]);
  });

  // Guard: when the SID can't be resolved, the %USERNAME% fallback must NOT be
  // used for a non-ASCII account — that would re-create the very ghost-principal
  // lock-out this code exists to prevent (and re-apply it on every load). The
  // write path must refuse: never run icacls with the mangling-prone name, and
  // delete the just-written (now un-hardenable) token rather than leave it loose.
  it('refuses (throws + deletes, no icacls) when SID unresolved AND USERNAME is non-ASCII', async () => {
    vi.stubEnv('USERNAME', '홍길동');
    vi.stubEnv('SystemRoot', 'C:\\Windows');
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
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
    // icacls must NEVER run with the mangling-prone principal...
    expect(icaclsArgs()).toBeUndefined();
    // ...and the un-hardenable token is removed (fail-closed, like any ACL fail).
    expect(fsMock.unlinkSync).toHaveBeenCalledWith(tokenPath);
  });

  it('deletes the token file and throws when Windows ACL hardening fails', async () => {
    vi.stubEnv('USERNAME', 'tester');
    vi.stubEnv('SystemRoot', 'C:\\Windows');
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    // whoami resolves fine; icacls is the step that fails.
    execFileSyncMock.mockImplementation((cmd: unknown) => {
      if (typeof cmd === 'string' && cmd.toLowerCase().includes('whoami')) {
        return Buffer.from('user S-1-5-21-1-2-3-1001\n');
      }
      throw new Error('icacls failed');
    });

    const { secureWriteTokenFile } = await import('../security');
    const tokenPath = path.join('C:', 'Users', 'tester', '.wmux-auth-token');

    expect(() => secureWriteTokenFile(tokenPath, 'secret-token')).toThrow(
      `Failed to set secure ACL on ${tokenPath}: icacls failed`,
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
    // describe's failing-icacls test would otherwise leak its throw into here.
    execFileSyncMock.mockReset();
    fsMock.chmodSync.mockReset();
  });

  it('re-applies the SID-based restrictive ACL on Windows and returns true', async () => {
    vi.stubEnv('USERNAME', 'tester');
    vi.stubEnv('SystemRoot', 'C:\\Windows');
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    stubWhoamiSid('S-1-5-21-1-2-3-1001');

    const { reHardenTokenFileAcl } = await import('../security');
    const tokenPath = path.join('C:', 'Users', 'tester', '.wmux-auth-token');

    const ok = reHardenTokenFileAcl(tokenPath);

    expect(ok).toBe(true);
    expect(icaclsArgs()).toEqual([
      tokenPath,
      '/grant:r',
      '*S-1-5-21-1-2-3-1001:F',
      '/inheritance:r',
    ]);
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
  // never run icacls with the mangling-prone name, never delete the working
  // token. Re-locking the owner out on every load is worse than leaving the
  // file's current ACL untouched.
  it('returns false without running icacls when SID unresolved AND USERNAME is non-ASCII', async () => {
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

    expect(reHardenTokenFileAcl(tokenPath)).toBe(false);
    expect(icaclsArgs()).toBeUndefined();
    expect(fsMock.unlinkSync).not.toHaveBeenCalled();
  });

  it('returns false (does NOT throw) when hardening fails — best-effort', async () => {
    vi.stubEnv('USERNAME', 'tester');
    vi.stubEnv('SystemRoot', 'C:\\Windows');
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    execFileSyncMock.mockImplementation((cmd: unknown) => {
      // whoami succeeds; icacls denies — hardening must still fail soft.
      if (typeof cmd === 'string' && cmd.toLowerCase().includes('whoami')) {
        return Buffer.from('user S-1-5-21-1-2-3-1001\n');
      }
      throw new Error('icacls denied');
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
