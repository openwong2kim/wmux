import { execFileSync } from 'node:child_process';
import { promises as fs, mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ComputerError } from '../../../shared/computer/errors';
import {
  HELPER_REQUIREMENT,
  createHelperVerifier,
  createWindowsPinCheck,
  helperBundlePath,
  type CodesignResult,
  type RunCodesign,
} from '../verifyHelper';

const BUNDLE = '/Applications/wmux.app/Contents/Resources/computer-use-macos/wmux Computer Use.app';
const EXE = `${BUNDLE}/Contents/MacOS/wmux-computer-use`;
const NESTED = `${BUNDLE}/Contents/MacOS/agent-desktop`;

interface FakeSignature {
  signed: boolean;
  team?: string;
  identifier?: string;
}

/**
 * Stands in for /usr/bin/codesign: evaluates the one requirement verifyHelper
 * sends against a fake signature, with codesign's real exit codes (0 ok,
 * 1 not signed, 3 requirement not satisfied).
 */
function fakeCodesign(sig: FakeSignature): RunCodesign & { calls: string[][] } {
  const calls: string[][] = [];
  const run = async (args: readonly string[]): Promise<CodesignResult> => {
    calls.push([...args]);
    expect(args).toContain(`-R=${HELPER_REQUIREMENT}`);
    expect(args).toContain('--strict');
    // Without --deep the bundle's seal does not open the nested binary's pages.
    expect(args).toContain('--deep');
    expect(args[args.length - 1]).toBe(BUNDLE);
    if (!sig.signed) return { code: 1, stderr: `${BUNDLE}: code object is not signed at all\n` };
    if (sig.team !== '8RGHH2F237' || sig.identifier !== 'com.electron.wmux.computer-use') {
      return { code: 3, stderr: 'test-requirement: code failed to satisfy specified code requirement(s)\n' };
    }
    return { code: 0, stderr: '' };
  };
  return Object.assign(run, { calls });
}

const verifier = (sig: FakeSignature, fileIdentity: (p: string) => Promise<string> = async () => 'dev:ino:1') => {
  const runCodesign = fakeCodesign(sig);
  return { verify: createHelperVerifier({ platform: 'darwin', isPackaged: true, runCodesign, fileIdentity }), runCodesign };
};

async function refusal(promise: Promise<void>): Promise<ComputerError> {
  const error = await promise.then(() => null, (e: unknown) => e);
  expect(error).toBeInstanceOf(ComputerError);
  expect((error as ComputerError).code).toBe('helper_unavailable');
  return error as ComputerError;
}

describe('computer-use helper signature check', () => {
  it('accepts the helper signed by the wmux team with its own identifier', async () => {
    const { verify } = verifier({ signed: true, team: '8RGHH2F237', identifier: 'com.electron.wmux.computer-use' });
    await expect(verify(EXE)).resolves.toBeUndefined();
  });

  it('refuses another binary from the same team (wrong identifier)', async () => {
    const { verify } = verifier({ signed: true, team: '8RGHH2F237', identifier: 'com.electron.wmux' });
    expect((await refusal(verify(EXE))).message).toContain('failed to satisfy');
  });

  it('refuses the right identifier signed by another team', async () => {
    const { verify } = verifier({ signed: true, team: 'ABCDE12345', identifier: 'com.electron.wmux.computer-use' });
    await refusal(verify(EXE));
  });

  it('refuses an unsigned helper binary', async () => {
    const { verify } = verifier({ signed: false });
    expect((await refusal(verify(EXE))).message).toContain('not signed at all');
  });

  it('refuses the ad-hoc helper an unsigned wmux build ships', async () => {
    // build.sh signs ad-hoc without an identity: no team, so the anchor fails.
    const { verify } = verifier({ signed: true, identifier: 'com.electron.wmux.computer-use' });
    await refusal(verify(EXE));
  });

  it('refuses a helper outside an app bundle without running codesign', async () => {
    const { verify, runCodesign } = verifier({ signed: true, team: '8RGHH2F237', identifier: 'com.electron.wmux.computer-use' });
    await refusal(verify('/tmp/wmux-computer-use'));
    expect(runCodesign.calls).toHaveLength(0);
  });

  it('refuses a missing helper', async () => {
    const { verify } = verifier({ signed: true }, async () => {
      throw new Error('ENOENT');
    });
    expect((await refusal(verify(EXE))).message).toContain('missing');
  });

  it('caches the verdict by path and file identity', async () => {
    let identity = 'dev:ino:1';
    const { verify, runCodesign } = verifier(
      { signed: true, team: '8RGHH2F237', identifier: 'com.electron.wmux.computer-use' },
      async () => identity,
    );
    await verify(EXE);
    await verify(EXE);
    expect(runCodesign.calls).toHaveLength(1);
    identity = 'dev:ino2:1'; // the binary was replaced
    await verify(EXE);
    expect(runCodesign.calls).toHaveLength(2);
  });

  it('checks again when the nested agent-desktop binary changes, though the helper did not', async () => {
    const identities: Record<string, string> = { [EXE]: 'dev:ino:1', [NESTED]: 'dev:nested:1' };
    const { verify, runCodesign } = verifier(
      { signed: true, team: '8RGHH2F237', identifier: 'com.electron.wmux.computer-use' },
      async (p: string) => identities[p] ?? 'absent',
    );
    await verify(EXE);
    await verify(EXE);
    expect(runCodesign.calls).toHaveLength(1);
    identities[NESTED] = 'dev:nested2:1'; // the nested binary was replaced
    await verify(EXE);
    expect(runCodesign.calls).toHaveLength(2);
  });

  it('refuses when the nested binary is swapped while codesign ran, and does not cache that', async () => {
    const identities: Record<string, string> = { [EXE]: 'dev:ino:1', [NESTED]: 'dev:nested:1' };
    const runCodesign = fakeCodesign({ signed: true, team: '8RGHH2F237', identifier: 'com.electron.wmux.computer-use' });
    const verify = createHelperVerifier({
      platform: 'darwin',
      isPackaged: true,
      fileIdentity: async (p) => identities[p] ?? 'absent',
      runCodesign: async (args) => {
        const result = await runCodesign(args);
        identities[NESTED] = 'dev:nested2:1';
        return result;
      },
    });
    expect((await refusal(verify(EXE))).message).toContain('changed');
    await expect(verify(EXE)).resolves.toBeUndefined();
    expect(runCodesign.calls).toHaveLength(2);
  });

  it('caches a refusal too, until the binary changes', async () => {
    const { verify, runCodesign } = verifier({ signed: false });
    await refusal(verify(EXE));
    await refusal(verify(EXE));
    expect(runCodesign.calls).toHaveLength(1);
  });

  it('refuses a helper swapped while codesign ran, and does not cache that', async () => {
    let identity = 'dev:ino:1';
    const runCodesign = fakeCodesign({ signed: true, team: '8RGHH2F237', identifier: 'com.electron.wmux.computer-use' });
    const verify = createHelperVerifier({
      platform: 'darwin',
      isPackaged: true,
      fileIdentity: async () => identity,
      runCodesign: async (args) => {
        const result = await runCodesign(args);
        identity = 'dev:ino2:1'; // replaced mid-check
        return result;
      },
    });
    expect((await refusal(verify(EXE))).message).toContain('changed');
    // The new binary is checked on its own next time.
    await expect(verify(EXE)).resolves.toBeUndefined();
    expect(runCodesign.calls).toHaveLength(2);
  });

  it('does not cache a codesign timeout or signal', async () => {
    let calls = 0;
    const verify = createHelperVerifier({
      platform: 'darwin',
      isPackaged: true,
      fileIdentity: async () => 'dev:ino:1',
      runCodesign: async () => {
        calls += 1;
        return { code: -1, stderr: '' };
      },
    });
    await refusal(verify(EXE));
    await refusal(verify(EXE));
    expect(calls).toBe(2);
  });

  it('does not check dev builds or other platforms', async () => {
    const runCodesign = vi.fn<RunCodesign>();
    await createHelperVerifier({ platform: 'darwin', isPackaged: false, runCodesign })(EXE);
    await createHelperVerifier({ platform: 'linux', isPackaged: true, runCodesign })('/opt/wmux/helper');
    await createHelperVerifier({ platform: 'win32', isPackaged: false, runCodesign })('C:\\wmux\\helper.exe');
    expect(runCodesign).not.toHaveBeenCalled();
  });

  it('finds the bundle around the executable', () => {
    expect(helperBundlePath(EXE)).toBe(BUNDLE);
    expect(helperBundlePath('/x/helper')).toBeNull();
  });

  it.runIf(process.platform === 'darwin')('real codesign refuses an unsigned bundle', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wmux-verify-'));
    const exe = path.join(dir, 'Fake.app', 'Contents', 'MacOS', 'fake');
    await fs.mkdir(path.dirname(exe), { recursive: true });
    await fs.writeFile(exe, '#!/bin/sh\n', { mode: 0o755 });
    try {
      await refusal(createHelperVerifier({ platform: 'darwin', isPackaged: true })(exe));
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe('Windows helper pin', () => {
  const WIN_EXE = 'C:\\Users\\me\\AppData\\Local\\wmux\\app-1.0.0\\resources\\computer-use-windows\\wmux-computer-use.exe';
  const GOOD = 'a'.repeat(64);

  const winVerifier = (
    pin: { sha256: string; releaseSigned: boolean } | undefined,
    digest: () => Promise<string> = async () => GOOD,
    fileIdentity: () => Promise<string> = async () => 'dev:ino:1',
  ) => {
    const hashFile = vi.fn(digest);
    return { verify: createHelperVerifier({ platform: 'win32', isPackaged: true, windowsPin: pin, hashFile, fileIdentity }), hashFile };
  };

  it('accepts a release-signed helper whose bytes match the pin, hashing on every spawn', async () => {
    const { verify, hashFile } = winVerifier({ sha256: GOOD, releaseSigned: true });
    await verify(WIN_EXE);
    await verify(WIN_EXE);
    expect(hashFile).toHaveBeenCalledTimes(2);
  });

  it('fails closed on a one-byte mismatch', async () => {
    const { verify } = winVerifier({ sha256: GOOD, releaseSigned: true }, async () => `${'a'.repeat(63)}b`);
    expect((await refusal(verify(WIN_EXE))).message).toContain('reinstall');
  });

  it('accepts a helper without a release signature whose bytes match the pin', async () => {
    const { verify, hashFile } = winVerifier({ sha256: GOOD, releaseSigned: false });
    await expect(verify(WIN_EXE)).resolves.toBeUndefined();
    expect(hashFile).toHaveBeenCalledTimes(1);
  });

  it('still refuses a helper without a release signature whose bytes do not match the pin', async () => {
    const { verify } = winVerifier({ sha256: GOOD, releaseSigned: false }, async () => `${'a'.repeat(63)}b`);
    expect((await refusal(verify(WIN_EXE))).message).toContain('does not match');
  });

  it('refuses a build with no pin', async () => {
    await refusal(winVerifier(undefined).verify(WIN_EXE));
    await refusal(winVerifier({ sha256: '', releaseSigned: true }).verify(WIN_EXE));
    await refusal(winVerifier({ sha256: '', releaseSigned: false }).verify(WIN_EXE));
  });

  it('refuses a missing helper', async () => {
    const { verify } = winVerifier({ sha256: GOOD, releaseSigned: true }, async () => {
      throw new Error('ENOENT');
    });
    expect((await refusal(verify(WIN_EXE))).message).toContain('missing');
  });

  it('refuses a helper replaced while it was hashed', async () => {
    let identity = 'dev:ino:1';
    const { verify } = winVerifier(
      { sha256: GOOD, releaseSigned: true },
      async () => {
        identity = 'dev:ino2:1';
        return GOOD;
      },
      async () => identity,
    );
    expect((await refusal(verify(WIN_EXE))).message).toContain('changed');
  });

  it('hashes real bytes with SHA-256', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wmux-pin-'));
    const exe = path.join(dir, 'helper.exe');
    await fs.writeFile(exe, 'abc');
    const pin = { sha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad', releaseSigned: true };
    try {
      await expect(createHelperVerifier({ platform: 'win32', isPackaged: true, windowsPin: pin })(exe)).resolves.toBeUndefined();
      await fs.writeFile(exe, 'abd');
      await refusal(createHelperVerifier({ platform: 'win32', isPackaged: true, windowsPin: pin })(exe));
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe('Windows pin check for Settings', () => {
  const WIN_EXE = 'C:\\wmux\\resources\\computer-use-windows\\wmux-computer-use.exe';
  const GOOD = 'a'.repeat(64);
  const BAD = `${'a'.repeat(63)}b`;

  // The helper on disk: its identity and digest change together, as a write does.
  const disk = () => {
    const file = { identity: 'dev:ino:1:100', digest: GOOD as string | null };
    const hashFile = vi.fn(async () => {
      if (file.digest === null) throw new Error('ENOENT');
      return file.digest;
    });
    const fileIdentity = vi.fn(async () => {
      if (file.digest === null) throw new Error('ENOENT');
      return file.identity;
    });
    const check = createWindowsPinCheck({ windowsPin: { sha256: GOOD, releaseSigned: false }, hashFile, fileIdentity });
    return { file, hashFile, check };
  };

  it('hashes a helper once per file identity, not on every Settings read', async () => {
    const { check, hashFile } = disk();
    expect(await check(WIN_EXE)).toBe('ok');
    expect(await check(WIN_EXE)).toBe('ok');
    expect(await check(WIN_EXE)).toBe('ok');
    expect(hashFile).toHaveBeenCalledTimes(1);
  });

  it('reports a tampered helper as a mismatch, and a restored one as ok again', async () => {
    const { check, file, hashFile } = disk();
    expect(await check(WIN_EXE)).toBe('ok');
    Object.assign(file, { identity: 'dev:ino:1:200', digest: BAD });
    expect(await check(WIN_EXE)).toBe('mismatch');
    expect(await check(WIN_EXE)).toBe('mismatch');
    Object.assign(file, { identity: 'dev:ino:1:300', digest: GOOD });
    expect(await check(WIN_EXE)).toBe('ok');
    expect(hashFile).toHaveBeenCalledTimes(3);
  });

  it('re-hashes when only the ctime part of the identity moves (same size, mtime set back)', async () => {
    const { check, file, hashFile } = disk();
    expect(await check(WIN_EXE)).toBe('ok');
    Object.assign(file, { identity: 'dev:ino:1:101', digest: BAD });
    expect(await check(WIN_EXE)).toBe('mismatch');
    expect(hashFile).toHaveBeenCalledTimes(2);
  });

  it('does not cache a helper that is gone, or one that changed while it was hashed', async () => {
    const { check, file, hashFile } = disk();
    file.digest = null;
    expect(await check(WIN_EXE)).toBe('unreadable');
    file.digest = GOOD;
    hashFile.mockImplementationOnce(async () => {
      file.identity = 'dev:ino:1:400';
      return GOOD;
    });
    expect(await check(WIN_EXE)).toBe('changed');
    expect(await check(WIN_EXE)).toBe('ok');
    expect(await check(WIN_EXE)).toBe('ok');
    // The changed read and the first ok one; the gone file was never hashed.
    expect(hashFile).toHaveBeenCalledTimes(2);
  });

  it('reports a build with no pin without reading the helper', async () => {
    const hashFile = vi.fn(async () => GOOD);
    const check = createWindowsPinCheck({ windowsPin: { sha256: '', releaseSigned: false }, hashFile, fileIdentity: async () => 'x' });
    expect(await check(WIN_EXE)).toBe('no_pin');
    expect(hashFile).not.toHaveBeenCalled();
  });

  it('leaves the spawn check uncached: a cached ok does not let a changed helper start', async () => {
    const { check, file } = disk();
    const verify = createHelperVerifier({
      platform: 'win32',
      isPackaged: true,
      windowsPin: { sha256: GOOD, releaseSigned: false },
      hashFile: async () => file.digest ?? '',
      fileIdentity: async () => file.identity,
    });
    expect(await check(WIN_EXE)).toBe('ok');
    // Same identity (a same-user edit that also restored the ctime): Settings
    // keeps its verdict, the spawn hashes again and refuses.
    file.digest = BAD;
    expect(await check(WIN_EXE)).toBe('ok');
    expect((await refusal(verify(WIN_EXE))).message).toContain('does not match');
  });
});

// The real codesign, on a helper-shaped bundle built here and signed ad-hoc
// like build.sh signs it. Ad-hoc never meets the team requirement (exit 3);
// what matters is that a tampered nested binary is reported as a broken
// signature (exit 1), which only a --deep check sees.
describe.skipIf(process.platform !== 'darwin')('helper signature check against the real codesign', () => {
  function bundle(): { exe: string; nested: string } {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'vh-'));
    const app = path.join(dir, 'wmux Computer Use.app');
    mkdirSync(path.join(app, 'Contents/MacOS'), { recursive: true });
    const src = path.join(dir, 'main.c');
    writeFileSync(src, 'int main(void) { return 0; }\n');
    const exe = path.join(app, 'Contents/MacOS/wmux-computer-use');
    const nested = path.join(app, 'Contents/MacOS/agent-desktop');
    execFileSync('cc', ['-arch', 'arm64', '-o', exe, src]);
    execFileSync('cc', ['-arch', 'arm64', '-o', nested, src]);
    writeFileSync(path.join(app, 'Contents/Info.plist'), '<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict><key>CFBundleExecutable</key><string>wmux-computer-use</string><key>CFBundleIdentifier</key><string>com.electron.wmux.computer-use</string></dict></plist>\n');
    execFileSync('codesign', ['--force', '--sign', '-', '--identifier', 'com.electron.wmux.agent-desktop', nested], { stdio: 'pipe' });
    execFileSync('codesign', ['--force', '--sign', '-', '--identifier', 'com.electron.wmux.computer-use', app], { stdio: 'pipe' });
    return { exe, nested };
  }

  it('reports a tampered nested binary as a broken signature, not only as an unmet requirement', async () => {
    const intact = bundle();
    const tampered = bundle();
    const bytes = readFileSync(tampered.nested);
    bytes[0x3000] ^= 0xff; // a code page, not the unhashed signature blob at the end
    writeFileSync(tampered.nested, bytes);
    const verify = createHelperVerifier({ platform: 'darwin', isPackaged: true });
    expect((await refusal(verify(intact.exe))).message).toContain('satisfy');
    expect((await refusal(verify(tampered.exe))).message).toMatch(/invalid signature|modified/);
  });
});
