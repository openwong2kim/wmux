// The native MCP launcher's copy in the stable MCP directory, beside the
// bundle it falls back to (core/wmux-native/src/mcp_shim/fallback.rs looks for
// `index.js` next to itself first).
//
// A copy is offered only once its self-test passed, and that verdict is
// recorded by the copy's sha256 (shared/mcpLauncher.ts), so a boot runs the
// test only for bytes it has not judged yet. A copy that fails is replaced by
// the one it replaced, or kept and recorded as failing: never deleted, since
// an agent config may point at the path. A timeout proves nothing either way;
// nothing is offered or recorded, and the next boot tests again.
//
// Calls are serialized: two registrations at once (boot, a re-register from
// the UI) must not sweep the aside the other is about to restore.

import { installLifecycleAsset, settleProbedAsset, sweepAsides } from '../../shared/lifecycleIntegrations';
import { NATIVE_HOOKS_MARKER } from '../../shared/hooks/hookFlavours';
import {
  fileSha256,
  nativeLauncherPath,
  recordVerdict,
  recordedVerdict,
  type SelfTestVerdict,
} from '../../shared/mcpLauncher';
import * as fs from 'fs';

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
  /** True when a failing copy was replaced by the one it had replaced. */
  restored: boolean;
  /** Why no launcher is offered; for the log. */
  reason?: string;
}

let queue: Promise<unknown> = Promise.resolve();

export function prepareNativeLauncher(opts: NativeLauncherOptions): Promise<NativeLauncherResult> {
  const run = queue.then(() => prepareOnce(opts));
  queue = run.catch(() => undefined);
  return run;
}

async function prepareOnce(opts: NativeLauncherOptions): Promise<NativeLauncherResult> {
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
    // back if the new one does not pass.
    replaceAside: true,
  });
  if (outcome.state !== 'current') {
    return { binary: null, restored: false, reason: outcome.error ?? `copy is ${outcome.state}` };
  }
  const hash = fileSha256(destinationPath);
  const known = hash ? recordedVerdict(opts.stableDir, hash) : undefined;
  const verdict: SelfTestVerdict = known ?? (await opts.selfTest(destinationPath));
  if (hash && !known && verdict !== 'timeout') recordVerdict(opts.stableDir, hash, verdict);
  const settled = settleProbedAsset(destinationPath, outcome.previousPath, verdict === 'pass', { keepFailing: true });
  if (settled.runs) return { binary: destinationPath, restored: false };
  const reason = verdict === 'timeout' ? 'self-test timed out' : known === 'fail' ? 'recorded as failing' : 'self-test failed';
  return { binary: null, restored: settled.restored, reason: settled.restored ? `${reason}; the previous copy was put back` : reason };
}
