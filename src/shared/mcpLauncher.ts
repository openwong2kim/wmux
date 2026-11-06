// Which command an agent's `wmux` MCP entry launches, decided in one place for
// the app's registrar and the `wmux mcp` CLI.
//
// In order:
//   native     the broker is enabled and the native launcher beside the stable
//              bundle passed its self-test. No readiness probe: the launcher
//              falls back to that bundle by itself while the broker is down,
//              so a slow boot does not flip the entry between launches.
//   node-shim  the broker is enabled and answers now: `node shim.js`.
//   bundle     everything else: `node index.js`, the full server.

import { execFile } from 'child_process';
import { createHash, randomBytes } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { WmuxLauncher } from './configIO';
import { nativeHooksBasename } from './hooks/hookFlavours';

/** What `wmux-native mcp-shim --self-test` prints when it speaks the broker
 *  protocol this wmux expects (core/wmux-native/src/mcp_shim.rs). */
export const NATIVE_SELF_TEST_LINE = 'wmux-mcp-shim protocol 1';
export const NATIVE_SELF_TEST_TIMEOUT_MS = 5000;

/** What a self-test proved: it runs, it does not, or nothing. Nothing is
 *  proved when it timed out (an antivirus scan, load) or could not be started
 *  at all (access denied, the file held or gone): neither says anything about
 *  the bytes, so neither is recorded. */
export type SelfTestVerdict = 'pass' | 'fail' | 'timeout' | 'unstartable';

/** Run the native launcher's self-test. Never throws. */
export function runNativeSelfTest(binary: string, timeoutMs = NATIVE_SELF_TEST_TIMEOUT_MS): Promise<SelfTestVerdict> {
  return new Promise((resolve) => {
    try {
      execFile(binary, ['mcp-shim', '--self-test'], { timeout: timeoutMs, windowsHide: true, encoding: 'utf8' }, (error, stdout) => {
        if (error && (error as { killed?: boolean }).killed) return resolve('timeout');
        // A string code is a spawn error (EACCES, EPERM, EBUSY, ENOENT); an
        // exit status is a number.
        if (error && typeof (error as { code?: unknown }).code === 'string') return resolve('unstartable');
        resolve(!error && String(stdout).trim() === NATIVE_SELF_TEST_LINE ? 'pass' : 'fail');
      });
    } catch {
      resolve('unstartable');
    }
  });
}

/**
 * The verdicts the app recorded for launcher builds, by sha256 of the copy, in
 * the stable MCP directory. Only the app writes it (after a self-test); the
 * CLI reads it, so both offer the same copies. A timeout is never recorded.
 */
export const NATIVE_HEALTH_RECORD = '.wmux-native-health.json';
const MAX_RECORDED_BUILDS = 8;

type HealthRecord = { version: 1; verdicts: Record<string, 'pass' | 'fail'> };

function readHealthRecord(stableDir: string): HealthRecord {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(stableDir, NATIVE_HEALTH_RECORD), 'utf8')) as Partial<HealthRecord>;
    if (parsed && parsed.version === 1 && parsed.verdicts && typeof parsed.verdicts === 'object') return parsed as HealthRecord;
  } catch { /* missing or unreadable: nothing recorded */ }
  return { version: 1, verdicts: {} };
}

export function fileSha256(file: string): string | null {
  try {
    return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  } catch {
    return null;
  }
}

export function recordedVerdict(stableDir: string, hash: string): 'pass' | 'fail' | undefined {
  const verdict = readHealthRecord(stableDir).verdicts[hash];
  return verdict === 'pass' || verdict === 'fail' ? verdict : undefined;
}

/** Record a verdict for a build; the newest few builds are kept. */
export function recordVerdict(stableDir: string, hash: string, verdict: 'pass' | 'fail'): void {
  const record = readHealthRecord(stableDir);
  delete record.verdicts[hash];
  record.verdicts[hash] = verdict;
  const hashes = Object.keys(record.verdicts);
  for (const old of hashes.slice(0, Math.max(0, hashes.length - MAX_RECORDED_BUILDS))) delete record.verdicts[old];
  const file = path.join(stableDir, NATIVE_HEALTH_RECORD);
  const temp = `${file}.${process.pid}-${randomBytes(4).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(temp, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    fs.renameSync(temp, file);
  } catch {
    try { fs.unlinkSync(temp); } catch { /* never written */ }
  }
}

/** Where the native launcher lives inside the stable MCP directory. */
export function nativeLauncherPath(stableDir: string, platform: NodeJS.Platform = process.platform): string {
  return path.join(stableDir, nativeHooksBasename(platform));
}

/**
 * The installed native launcher, when it sits beside the stable bundle it
 * falls back to and the app recorded a passing self-test for these exact
 * bytes; otherwise null. Read-only and runs nothing: the CLI uses it, and only
 * the app installs and tests the launcher.
 */
export function approvedInstalledNative(stableDir: string): string | null {
  const binary = nativeLauncherPath(stableDir);
  if (!fs.existsSync(binary) || !fs.existsSync(path.join(stableDir, 'index.js'))) return null;
  const hash = fileSha256(binary);
  return hash && recordedVerdict(stableDir, hash) === 'pass' ? binary : null;
}

export type LauncherLane = 'native' | 'node-shim' | 'bundle';

export interface LauncherChoiceInputs {
  brokerEnabled: boolean;
  /** A native launcher that passed its self-test, or null. */
  nativeBinary: string | null;
  /** Asked only when the native launcher is not used. */
  brokerReady: () => Promise<boolean>;
  shimScript: string | null;
  bundleScript: string | null;
}

export interface LauncherChoice {
  launcher: WmuxLauncher;
  lane: LauncherLane;
}

export async function chooseLauncher(inputs: LauncherChoiceInputs): Promise<LauncherChoice | null> {
  if (inputs.brokerEnabled && inputs.nativeBinary) {
    return { launcher: { kind: 'native', binary: inputs.nativeBinary }, lane: 'native' };
  }
  if (inputs.brokerEnabled && inputs.shimScript && (await inputs.brokerReady())) {
    return { launcher: { kind: 'node', script: inputs.shimScript }, lane: 'node-shim' };
  }
  return inputs.bundleScript ? { launcher: { kind: 'node', script: inputs.bundleScript }, lane: 'bundle' } : null;
}
