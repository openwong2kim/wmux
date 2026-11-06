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

import * as fs from 'fs';
import * as path from 'path';
import type { WmuxLauncher } from './configIO';
import { nativeHooksBasename } from './hooks/hookFlavours';
import { fileSha256, probeKey, recordedProbe, runProbe, type ProbeVerdict } from './probedNative';

/** What `wmux-native mcp-shim --self-test` prints when it speaks the broker
 *  protocol this wmux expects (core/wmux-native/src/mcp_shim.rs). */
export const NATIVE_SELF_TEST_LINE = 'wmux-mcp-shim protocol 1';
export const NATIVE_SELF_TEST_TIMEOUT_MS = 5000;

/** What a self-test proved (see shared/probedNative.ts). */
export type SelfTestVerdict = ProbeVerdict;

/** Run the native launcher's self-test. Never throws. */
export function runNativeSelfTest(binary: string, timeoutMs = NATIVE_SELF_TEST_TIMEOUT_MS): Promise<SelfTestVerdict> {
  return runProbe(binary, ['mcp-shim', '--self-test'], NATIVE_SELF_TEST_LINE, timeoutMs);
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
  // The app records verdicts there (shared/probedNative.ts); the CLI only reads.
  return hash && recordedProbe(stableDir, probeKey(hash, NATIVE_SELF_TEST_LINE)) === 'pass' ? binary : null;
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
