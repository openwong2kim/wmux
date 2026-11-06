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
import { prepareProbedNative, type ProbedNativeResult } from '../../shared/probedNative';

export interface NativeLauncherOptions {
  /** The binary this build ships, or null when it ships none. */
  sourcePath: string | null;
  /** The stable MCP directory, already holding the stabilized bundle. */
  stableDir: string;
  selfTest: (binary: string) => Promise<SelfTestVerdict>;
  platform?: NodeJS.Platform;
}

/** The launcher to register (null: register a node launcher), and why no new
 *  one is offered, for the log. */
export type NativeLauncherResult = ProbedNativeResult;

export function prepareNativeLauncher(opts: NativeLauncherOptions): Promise<NativeLauncherResult> {
  return prepareProbedNative({
    sourcePath: opts.sourcePath,
    destinationPath: nativeLauncherPath(opts.stableDir, opts.platform),
    recordDir: opts.stableDir,
    line: NATIVE_SELF_TEST_LINE,
    probe: opts.selfTest,
    ownershipMarkers: [NATIVE_HOOKS_MARKER],
    platform: opts.platform,
  });
}
