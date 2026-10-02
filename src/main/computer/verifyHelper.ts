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
 * (helperPin.ts): the SHA-256 of the final, signed bytes, and whether those
 * bytes carry a release (not test) signature.
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
 * Windows, packaged builds. The helper must be release-signed (until the
 * signing policy is a real one, computer use stays off in packaged builds) and
 * its bytes must hash to the SHA-256 baked into the main bundle at build time.
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
  if (!pin?.releaseSigned) {
    throw new ComputerError('helper_unavailable', 'this wmux build does not include a release-signed computer-use helper');
  }
  if (!/^[0-9a-f]{64}$/.test(pin.sha256)) {
    throw new ComputerError('helper_unavailable', 'this wmux build carries no fingerprint for its computer-use helper');
  }
  let before: string;
  let digest: string;
  try {
    before = await readIdentity(exePath);
    digest = (await hashFile(exePath)).toLowerCase();
  } catch {
    throw new ComputerError('helper_unavailable', 'the computer-use helper is missing from this wmux build');
  }
  let after: string | null = null;
  try {
    after = await readIdentity(exePath);
  } catch {
    // Gone or unreadable now; refused below.
  }
  if (after !== before) {
    throw new ComputerError('helper_unavailable', 'the computer-use helper changed while it was being checked');
  }
  if (digest !== pin.sha256) {
    throw new ComputerError(
      'helper_unavailable',
      'the computer-use helper does not match this wmux build (damaged, partly updated or changed by antivirus); reinstall wmux',
    );
  }
}

/**
 * Returns `verify(exePath)`, which resolves when the helper may be spawned and
 * rejects with `helper_unavailable` otherwise. macOS verdicts are cached by path and
 * file identity (device, inode, size, ctime), so the codesign call (tens of ms) runs once per helper
 * binary, not per spawn.
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

    const key = `${exePath}\u0000${identity}`;
    let failure = cache.get(key);
    if (failure === undefined) {
      // The bundle, not the bare binary, so Info.plist is covered by the seal.
      const { code, stderr } = await runCodesign(['--verify', '--strict', `-R=${HELPER_REQUIREMENT}`, bundle]);
      // The file codesign judged must be the file we spawn: a swap during the
      // check fails it, and that verdict is not cached.
      let after: string | null = null;
      try {
        after = await readIdentity(exePath);
      } catch {
        // Gone or unreadable now; refused below.
      }
      if (after !== identity) {
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
