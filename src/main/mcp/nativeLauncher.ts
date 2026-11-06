// The native MCP launcher's copy in the stable MCP directory, beside the
// bundle it falls back to (core/wmux-native/src/mcp_shim/fallback.rs looks for
// `index.js` next to itself first).
//
// Every call re-checks the copy, current or not: a copy that does not run here
// (quarantine, application control, the wrong architecture, a build that
// speaks another broker protocol) must not be registered. A copy that fails is
// replaced by the one it replaced, or removed, and the caller registers a node
// launcher for this boot. A copy that a failed restore left behind reads as
// current, so the next call's self-test is what catches it.

import * as fs from 'fs';
import { installLifecycleAsset, sweepAsides } from '../../shared/lifecycleIntegrations';
import { NATIVE_HOOKS_MARKER } from '../../shared/hooks/hookFlavours';
import { nativeLauncherPath } from '../../shared/mcpLauncher';

export interface NativeLauncherOptions {
  /** The binary this build ships, or null when it ships none. */
  sourcePath: string | null;
  /** The stable MCP directory, already holding the stabilized bundle. */
  stableDir: string;
  selfTest: (binary: string) => Promise<boolean>;
  platform?: NodeJS.Platform;
}

export interface NativeLauncherResult {
  /** The launcher to register, or null to register a node launcher. */
  binary: string | null;
  /** True when a failing copy was replaced by the one it had replaced. */
  restored: boolean;
  /** Why no launcher is offered; for the log. */
  reason?: string;
}

export async function prepareNativeLauncher(opts: NativeLauncherOptions): Promise<NativeLauncherResult> {
  const destinationPath = nativeLauncherPath(opts.stableDir, opts.platform);
  // Asides earlier refreshes left while their copy was still running.
  sweepAsides(destinationPath);
  if (!opts.sourcePath || !fs.existsSync(opts.sourcePath)) {
    return { binary: null, restored: false, reason: 'not shipped with this build' };
  }
  const outcome = installLifecycleAsset({
    sourcePath: opts.sourcePath,
    destinationPath,
    ownershipMarkers: [NATIVE_HOOKS_MARKER],
    // Runnable from the moment it appears: an agent may start it mid-refresh.
    mode: 0o700,
    // The old copy may be running (Windows cannot replace it then) and is put
    // back if the new one fails its self-test.
    replaceAside: true,
  });
  if (outcome.state !== 'current') {
    return { binary: null, restored: false, reason: outcome.error ?? `copy is ${outcome.state}` };
  }
  const { previousPath } = outcome;
  if (await opts.selfTest(destinationPath)) {
    if (previousPath) {
      try { fs.unlinkSync(previousPath); } catch { /* still running: swept next time */ }
    }
    return { binary: destinationPath, restored: false };
  }
  if (previousPath) {
    try {
      fs.renameSync(previousPath, destinationPath);
      return { binary: null, restored: true, reason: 'self-test failed; the previous copy was put back' };
    } catch {
      return { binary: null, restored: false, reason: 'self-test failed; the previous copy could not be put back' };
    }
  }
  try { fs.unlinkSync(destinationPath); } catch { /* in use: the next self-test catches it again */ }
  return { binary: null, restored: false, reason: 'self-test failed' };
}
