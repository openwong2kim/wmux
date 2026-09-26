/**
 * #1525 — will Windows Smart App Control refuse to run this installer?
 *
 * The Windows install path quits wmux and hands Setup.exe to a detached
 * waiter. When Smart App Control (SAC) is enforcing and the installer carries
 * no signature Windows trusts, SAC decides by cloud reputation, and a release
 * that is only hours old has none: Start-Process fails with
 * ERROR_SYSTEM_INTEGRITY_POLICY_VIOLATION (4551) AFTER wmux is already gone.
 * The user watched every pane close for an update that could never run.
 *
 * This module answers the question BEFORE the quit, from two facts:
 *   - SAC state: HKLM\SYSTEM\CurrentControlSet\Control\CI\Policy
 *     VerifiedAndReputablePolicyState — 1 enforce (blocks), 2 evaluation
 *     (never blocks), 0 off. Absent on builds without SAC.
 *   - the installer's Authenticode status. SAC allows a file signed by a
 *     trusted publisher regardless of reputation, so only a non-`Valid`
 *     status leaves the verdict to reputation.
 *
 * Detection only. Nothing here tries to get around SAC — the answer is used to
 * warn and keep wmux open, and the user can still choose to go ahead. The real
 * fix is a production code-signing certificate for the release pipeline.
 *
 * Every probe is bounded by a timeout and every failure throws; the caller
 * treats a throw as "cannot tell" and installs exactly as it did before this
 * check existed (fail open).
 */

import { execFile } from 'node:child_process';
import * as path from 'node:path';

export const SAC_POLICY_KEY = 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\CI\\Policy';
export const SAC_POLICY_VALUE = 'VerifiedAndReputablePolicyState';
/** VerifiedAndReputablePolicyState value that means "enforcing — blocks". */
export const SAC_STATE_ENFORCE = 1;

const REG_TIMEOUT_MS = 5_000;
// Get-AuthenticodeSignature hashes the whole file (~150 MB) and may consult
// the catalog store; generous, but still bounded — the user is waiting on it.
const SIGNATURE_TIMEOUT_MS = 15_000;
// Env var the signature probe reads the path from, so the path never has to
// be quoted into a command line.
const PROBE_PATH_ENV = 'WMUX_SAC_PROBE_FILE';

export interface SmartAppControlAssessment {
  /** True only when SAC is enforcing AND the installer's signature is not Valid. */
  likelyBlocked: boolean;
  /** Raw VerifiedAndReputablePolicyState, or null when the value is absent. */
  sacState: number | null;
  /** Authenticode status name, or null when it was not needed (SAC not enforcing). */
  signatureStatus: string | null;
}

export interface SmartAppControlProbes {
  readState: () => Promise<number | null>;
  readSignatureStatus: (filePath: string) => Promise<string>;
}

/**
 * Parse `reg query <key> /v VerifiedAndReputablePolicyState` output. Returns
 * null when the value is not present in it.
 */
export function parseSacPolicyState(regStdout: string): number | null {
  const m = /VerifiedAndReputablePolicyState\s+REG_DWORD\s+0x([0-9a-f]+)/i.exec(regStdout);
  if (!m) return null;
  const n = parseInt(m[1]!, 16);
  return Number.isFinite(n) ? n : null;
}

/** The decision itself, pure. */
export function isLikelyBlockedBySmartAppControl(
  sacState: number | null,
  signatureStatus: string | null,
): boolean {
  return sacState === SAC_STATE_ENFORCE && signatureStatus !== 'Valid';
}

function systemRoot(): string {
  return process.env.SystemRoot || 'C:\\Windows';
}

/** Promise wrapper over execFile that rejects with the error and stdout. */
function run(
  file: string,
  args: string[],
  timeout: number,
  env?: NodeJS.ProcessEnv,
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      { encoding: 'utf-8', timeout, windowsHide: true, env: env ?? process.env },
      (err, stdout) => {
        if (err) {
          reject(Object.assign(err, { stdout }));
          return;
        }
        resolve(stdout);
      },
    );
  });
}

/**
 * Read VerifiedAndReputablePolicyState. Null when the value (or the key) does
 * not exist — a Windows build without SAC. Throws on anything else, including
 * a timeout.
 */
export async function readSmartAppControlState(): Promise<number | null> {
  const regExe = path.join(systemRoot(), 'System32', 'reg.exe');
  try {
    const stdout = await run(regExe, ['query', SAC_POLICY_KEY, '/v', SAC_POLICY_VALUE], REG_TIMEOUT_MS);
    return parseSacPolicyState(stdout);
  } catch (err) {
    // execFile puts the numeric exit status in `code` (a spawn failure puts
    // an errno string there instead). reg.exe exits 1 when the key or value
    // is missing. A kill (timeout) or a spawn failure is a real "cannot tell"
    // and propagates.
    const e = err as { code?: unknown; killed?: boolean };
    if (e.code === 1 && !e.killed) return null;
    throw err;
  }
}

/** `Get-AuthenticodeSignature` status name for a file, e.g. Valid, NotSigned, UnknownError. */
export async function readAuthenticodeStatus(filePath: string): Promise<string> {
  const powershell = path.join(systemRoot(), 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const stdout = await run(
    powershell,
    [
      '-NoProfile', '-NonInteractive', '-Command',
      `(Get-AuthenticodeSignature -LiteralPath $env:${PROBE_PATH_ENV} -ErrorAction Stop).Status`,
    ],
    SIGNATURE_TIMEOUT_MS,
    { ...process.env, [PROBE_PATH_ENV]: filePath },
  );
  const status = stdout.trim();
  if (!/^[A-Za-z]+$/.test(status)) {
    throw new Error(`unexpected Get-AuthenticodeSignature output: ${JSON.stringify(status.slice(0, 80))}`);
  }
  return status;
}

const DEFAULT_PROBES: SmartAppControlProbes = {
  readState: readSmartAppControlState,
  readSignatureStatus: readAuthenticodeStatus,
};

/**
 * Assess one installer. The signature probe (the slow one) runs only when SAC
 * is actually enforcing, so the common case costs a single reg.exe call.
 * Throws when a probe fails; the caller fails open.
 */
export async function assessSmartAppControlBlock(
  installerPath: string,
  probes: SmartAppControlProbes = DEFAULT_PROBES,
): Promise<SmartAppControlAssessment> {
  if (process.platform !== 'win32') {
    return { likelyBlocked: false, sacState: null, signatureStatus: null };
  }
  const sacState = await probes.readState();
  if (sacState !== SAC_STATE_ENFORCE) {
    return { likelyBlocked: false, sacState, signatureStatus: null };
  }
  const signatureStatus = await probes.readSignatureStatus(installerPath);
  return {
    likelyBlocked: isLikelyBlockedBySmartAppControl(sacState, signatureStatus),
    sacState,
    signatureStatus,
  };
}
