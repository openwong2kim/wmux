// The native MCP launcher's copy in the stable MCP directory, beside the
// bundle it falls back to (core/wmux-native/src/mcp_shim/fallback.rs looks for
// `index.js` next to itself first).
//
// Installed by shared/probedNative.ts: the new copy is staged and its
// self-test run where it will live, and only a pass moves it into place. A
// copy that fails never takes the place of one that works; that one stays,
// and is still offered when its own bytes have a recorded pass. A timeout, or
// a copy that could not be started at all, proves nothing either way: nothing
// new is offered or recorded, and the next boot tests again.

import { NATIVE_HOOKS_MARKER } from '../../shared/hooks/hookFlavours';
import { NATIVE_SELF_TEST_LINE, nativeLauncherPath, type SelfTestVerdict } from '../../shared/mcpLauncher';
import { prepareProbedNative } from '../../shared/probedNative';

export interface NativeLauncherOptions {
  /** The binary this build ships, or null when it ships none. */
  sourcePath: string | null;
  /** The stable MCP directory, already holding the stabilized bundle. */
  stableDir: string;
  selfTest: (binary: string) => Promise<SelfTestVerdict>;
  platform?: NodeJS.Platform;
}

export interface NativeLauncherResult {
  /** The launcher to register, or null to register a node launcher. */
  binary: string | null;
  /** Always false: a failing copy never replaces a working one, so none is
   *  put back. Kept for callers that read it. */
  restored: boolean;
  /** Why no new launcher is offered; for the log. */
  reason?: string;
}

export async function prepareNativeLauncher(opts: NativeLauncherOptions): Promise<NativeLauncherResult> {
  const result = await prepareProbedNative({
    sourcePath: opts.sourcePath,
    destinationPath: nativeLauncherPath(opts.stableDir, opts.platform),
    recordDir: opts.stableDir,
    line: NATIVE_SELF_TEST_LINE,
    probe: opts.selfTest,
    ownershipMarkers: [NATIVE_HOOKS_MARKER],
    platform: opts.platform,
  });
  return { binary: result.binary, restored: false, ...(result.reason ? { reason: result.reason } : {}) };
}
