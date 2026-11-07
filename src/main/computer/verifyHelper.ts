// Integrity checks of the bundled computer-use helper, run before main spawns
// it. Electron-free so the rules are unit-testable; the codesign call, the
// hash and the stat are injectable.
//
// macOS: the code signature (below). Windows: a SHA-256 pinned at build time
// (see verifyWindowsHelper).
//
// Packaged builds only: a dev build runs whatever helper the developer built
// (ad-hoc signed), and helperPath.ts already refuses the env override in
// packaged builds. A packaged build spawns the helper only if it is signed by
// the wmux team with the helper's permanent identifier — the identity its TCC
// grants are bound to. An unsigned wmux build ships an ad-hoc helper, which
// fails the requirement, so computer use is unavailable there by design.

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, promises as fs } from 'node:fs';
import { ComputerError } from '../../shared/computer/errors';

export const HELPER_TEAM_ID = '8RGHH2F237';
export const HELPER_SIGNING_ID = 'com.electron.wmux.computer-use';
export const HELPER_REQUIREMENT =
  `anchor apple generic and certificate leaf[subject.OU] = "${HELPER_TEAM_ID}" and identifier "${HELPER_SIGNING_ID}"`;
/**
 * The agent-desktop binary nested in the macOS helper bundle. The helper's
 * runner mode (native/computer-use-macos Runner.swift, ChildGate) holds a
 * team-signed helper to starting only a binary signed by the same team with
 * this identifier; build.sh signs it so.
 */
export const AGENT_DESKTOP_SIGNING_ID = 'com.electron.wmux.agent-desktop';

/** Absolute path: a PATH lookup inside a security check is a hijack vector. */
const CODESIGN = '/usr/bin/codesign';
const CODESIGN_TIMEOUT_MS = 10_000;
const DEFINITIVE_EXIT_CODES: ReadonlySet<number> = new Set([0, 1, 3]);

export interface CodesignResult {
  /** 0 = valid and satisfies the requirement; 1 = not signed / invalid; 3 = requirement failed. */
  code: number;
  stderr: string;
}

export type RunCodesign = (args: readonly string[]) => Promise<CodesignResult>;
/** Identity of the file on disk: changes whenever the binary is replaced or modified. */
export type ReadFileIdentity = (path: string) => Promise<string>;

/** Lower-case hex SHA-256 of a file. */
export type HashFile = (path: string) => Promise<string>;

/**
 * What a packaged Windows build baked in about the helper it ships
 * (helperPin.ts): the SHA-256 of the final bytes, and whether those bytes
 * carry a release (not test) signature, which only Settings reports.
 */
export interface WindowsHelperPin {
  sha256: string;
  releaseSigned: boolean;
}

export interface HelperVerifierOptions {
  platform: NodeJS.Platform;
  isPackaged: boolean;
  runCodesign?: RunCodesign;
  fileIdentity?: ReadFileIdentity;
  windowsPin?: WindowsHelperPin;
  hashFile?: HashFile;
}

/** The .app bundle around `…/X.app/Contents/MacOS/<exe>`, or null. */
export function helperBundlePath(exePath: string): string | null {
  const match = /^(.+\.app)\/Contents\/MacOS\/[^/]+$/.exec(exePath);
  return match ? match[1] : null;
}

const runCodesignDefault: RunCodesign = (args) =>
  new Promise((resolve) => {
    execFile(CODESIGN, [...args], { timeout: CODESIGN_TIMEOUT_MS }, (error, _stdout, stderr) => {
      const code = error ? (typeof error.code === 'number' ? error.code : -1) : 0;
      resolve({ code, stderr: String(stderr ?? '') });
    });
  });

// Device, inode, size and ctime, not mtime: mtime can be set back with
// utimes (`touch -r`) after swapping the binary, ctime cannot.
const fileIdentityDefault: ReadFileIdentity = async (p) => {
  const st = await fs.stat(p, { bigint: true });
  return `${st.dev}:${st.ino}:${st.size}:${st.ctimeNs}`;
};

const hashFileDefault: HashFile = (p) =>
  new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(p)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', () => resolve(hash.digest('hex')));
  });

/**
 * What the Windows pin check found: `ok` the bytes match; `no_pin` the build
 * carries no pin; `unreadable` the helper could not be read; `changed` it
 * changed while being hashed; `mismatch` its bytes do not match the pin.
 */
export type WindowsPinVerdict = 'ok' | 'no_pin' | 'unreadable' | 'changed' | 'mismatch';

/** The Windows pin check, shared by the spawn (verifyWindowsHelper) and Settings (createWindowsPinCheck). */
async function checkWindowsHelper(
  exePath: string,
  pin: WindowsHelperPin | undefined,
  readIdentity: ReadFileIdentity,
  hashFile: HashFile,
): Promise<{ verdict: WindowsPinVerdict; identity?: string }> {
  if (!pin || !/^[0-9a-f]{64}$/.test(pin.sha256)) return { verdict: 'no_pin' };
  let before: string;
  let digest: string;
  try {
    before = await readIdentity(exePath);
    digest = (await hashFile(exePath)).toLowerCase();
  } catch {
    return { verdict: 'unreadable' };
  }
  let after: string | null = null;
  try {
    after = await readIdentity(exePath);
  } catch {
    // Gone or unreadable now; refused below.
  }
  if (after !== before) return { verdict: 'changed' };
  return { verdict: digest === pin.sha256 ? 'ok' : 'mismatch', identity: before };
}

/**
 * Windows, packaged builds. The helper's bytes must hash to the SHA-256 baked
 * into the main bundle at build time. A release signature is not required.
 *
 * The pin detects corruption, a partial update and antivirus tampering. It is
 * NOT a security boundary: everything under the install directory
 * (%LOCALAPPDATA%\wmux) is writable by the same user, who could rewrite the
 * main bundle and its pin as easily as the helper, and any same-user process
 * can call SendInput itself anyway (docs/computer-use-windows.md, trust model).
 * For the same reason the gap between this check and the spawn (a swap right
 * after hashing) is accepted. Hashed on every spawn, not cached: a few
 * milliseconds for a helper that starts at most once per idle period.
 */
async function verifyWindowsHelper(
  exePath: string,
  pin: WindowsHelperPin | undefined,
  readIdentity: ReadFileIdentity,
  hashFile: HashFile,
): Promise<void> {
  const { verdict } = await checkWindowsHelper(exePath, pin, readIdentity, hashFile);
  switch (verdict) {
    case 'ok':
      return;
    case 'no_pin':
      throw new ComputerError('helper_unavailable', 'this wmux build carries no fingerprint for its computer-use helper');
    case 'unreadable':
      throw new ComputerError('helper_unavailable', 'the computer-use helper is missing from this wmux build');
    case 'changed':
      throw new ComputerError('helper_unavailable', 'the computer-use helper changed while it was being checked');
    case 'mismatch':
      throw new ComputerError(
        'helper_unavailable',
        'the computer-use helper does not match this wmux build (damaged, partly updated or changed by antivirus); reinstall wmux',
      );
  }
}

/**
 * Returns `check(exePath)`: the same Windows pin check a spawn runs, for
 * Settings, so a helper that would be refused does not read as ready. Its
 * `ok` and `mismatch` verdicts are cached per path by file identity (device,
 * inode, size, ctime), so the helper is hashed once per binary, not on every
 * Settings read. Advisory only: the spawn re-hashes regardless
 * (verifyWindowsHelper), so a stale verdict here never lets a changed helper
 * run.
 */
export function createWindowsPinCheck(opts: {
  windowsPin?: WindowsHelperPin;
  fileIdentity?: ReadFileIdentity;
  hashFile?: HashFile;
}): (exePath: string) => Promise<WindowsPinVerdict> {
  const readIdentity = opts.fileIdentity ?? fileIdentityDefault;
  const hashFile = opts.hashFile ?? hashFileDefault;
  const cache = new Map<string, { identity: string; verdict: WindowsPinVerdict }>();

  return async (exePath) => {
    const cached = cache.get(exePath);
    if (cached) {
      let identity: string | null = null;
      try {
        identity = await readIdentity(exePath);
      } catch {
        // Gone or unreadable; checked afresh below.
      }
      if (identity === cached.identity) return cached.verdict;
      cache.delete(exePath);
    }
    const { verdict, identity } = await checkWindowsHelper(exePath, opts.windowsPin, readIdentity, hashFile);
    // A read failure or a change mid-hash says nothing lasting about the
    // binary, so the next read checks again.
    if (identity !== undefined) cache.set(exePath, { identity, verdict });
    return verdict;
  };
}

/**
 * Returns `verify(exePath)`, which resolves when the helper may be spawned and
 * rejects with `helper_unavailable` otherwise. macOS verdicts are cached by path and
 * the file identity (device, inode, size, ctime) of the helper and of the
 * agent-desktop binary nested beside it, so the codesign call (tens of ms)
 * runs once per pair of binaries, not per spawn.
 */
export function createHelperVerifier(opts: HelperVerifierOptions): (exePath: string) => Promise<void> {
  const runCodesign = opts.runCodesign ?? runCodesignDefault;
  const readIdentity = opts.fileIdentity ?? fileIdentityDefault;
  const cache = new Map<string, string | null>();

  return async (exePath) => {
    if (!opts.isPackaged) return;
    if (opts.platform === 'win32') {
      return verifyWindowsHelper(exePath, opts.windowsPin, readIdentity, opts.hashFile ?? hashFileDefault);
    }
    if (opts.platform !== 'darwin') return;

    const bundle = helperBundlePath(exePath);
    if (!bundle) {
      throw new ComputerError('helper_unavailable', 'the computer-use helper is not inside its signed app bundle');
    }
    let identity: string;
    try {
      identity = await readIdentity(exePath);
    } catch {
      throw new ComputerError('helper_unavailable', 'the computer-use helper is missing from this wmux build');
    }
    // The nested agent-desktop binary is part of the verdict: replacing it
    // alone must trigger a fresh check. A bundle without one keys on 'absent'.
    const nestedPath = `${bundle}/Contents/MacOS/agent-desktop`;
    const nestedIdentity = async (): Promise<string> => readIdentity(nestedPath).catch(() => 'absent');
    const nested = await nestedIdentity();

    const key = `${exePath}\u0000${identity}\u0000${nested}`;
    let failure = cache.get(key);
    if (failure === undefined) {
      // The bundle, not the bare binary, so Info.plist is covered by the seal;
      // --deep, so the nested binary's own code is checked too (the bundle's
      // seal alone does not open its pages).
      const { code, stderr } = await runCodesign(['--verify', '--strict', '--deep', `-R=${HELPER_REQUIREMENT}`, bundle]);
      // The files codesign judged must be the files we spawn: a swap during
      // the check fails it, and that verdict is not cached.
      let after: string | null = null;
      try {
        after = await readIdentity(exePath);
      } catch {
        // Gone or unreadable now; refused below.
      }
      if (after !== identity || (await nestedIdentity()) !== nested) {
        throw new ComputerError('helper_unavailable', 'the computer-use helper changed while its signature was being checked');
      }
      failure = code === 0 ? null : (stderr.trim().split('\n')[0] || `codesign exited with ${code}`);
      // Only codesign's verdicts are cached: 0 valid, 1 not signed or broken,
      // 3 requirement not met. A timeout or a signal says nothing about the
      // binary, so the next spawn checks again.
      if (DEFINITIVE_EXIT_CODES.has(code)) cache.set(key, failure);
    }
    if (failure !== null) {
      throw new ComputerError(
        'helper_unavailable',
        `the computer-use helper failed its code-signature check (${failure}); reinstall wmux`,
      );
    }
  };
}
