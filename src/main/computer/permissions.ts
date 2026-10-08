// Settings › Computer use › Permissions (macOS). Electron-free so the exact
// commands are unit-testable; index.ts supplies spawn, execFile, the verifier
// and shell.showItemInFolder.
//
// TCC grants belong to the helper app (its own signing identifier), not to
// wmux, so every button acts on the helper.

import { helperAppBundlePath } from './helperPath';
import { HELPER_SIGNING_ID } from './verifyHelper';

/** Absolute path: never a PATH lookup for a command that edits privacy grants. */
export const TCCUTIL_PATH = '/usr/bin/tccutil';
/** TCC service names for the two grants the helper needs. */
export const TCC_SERVICES = ['Accessibility', 'ScreenCapture'] as const;

export type PermissionOp = 'request' | 'reset' | 'reveal';

export function isPermissionOp(value: unknown): value is PermissionOp {
  return value === 'request' || value === 'reset' || value === 'reveal';
}

export interface PermissionDeps {
  /** The helper binary main spawns (inside its .app); null when this build has none. */
  helperPath: string | null;
  /** The same check main runs before every helper spawn (verifyHelper.ts). */
  verify: (command: string) => Promise<void>;
  spawn: (command: string, args: readonly string[]) => { unref(): void; on(event: 'error', listener: (err: Error) => void): unknown };
  execFile: (file: string, args: readonly string[]) => Promise<void>;
  showItemInFolder: (fullPath: string) => void;
}

function requireHelper(helperPath: string | null): string {
  if (!helperPath) throw new Error('this wmux build has no computer-use helper');
  return helperPath;
}

/**
 * Request access: runs the verified helper with `--request-permissions`, which
 * shows the system prompts and adds it to both Privacy & Security lists, then
 * exits. Not awaited past the spawn: the person answers in System Settings,
 * and Settings re-reads the grants when wmux's window gets focus again.
 */
export async function requestHelperPermissions(deps: PermissionDeps, log: (m: string) => void = () => undefined): Promise<void> {
  const command = requireHelper(deps.helperPath);
  await deps.verify(command);
  const child = deps.spawn(command, ['--request-permissions']);
  child.on('error', (err) => log(`[computer] request access failed: ${err.message}`));
  child.unref();
}

/**
 * Reset access: drops the helper's Accessibility and Screen Recording rows,
 * including a stale one (an older build's signature) that reads as on in
 * System Settings while macOS denies the installed helper.
 */
export async function resetHelperPermissions(deps: Pick<PermissionDeps, 'execFile'>): Promise<void> {
  for (const service of TCC_SERVICES) {
    await deps.execFile(TCCUTIL_PATH, ['reset', service, HELPER_SIGNING_ID]);
  }
}

/** Show helper in Finder: selects the .app, which can be dragged into the lists. */
export function revealHelper(deps: Pick<PermissionDeps, 'helperPath' | 'showItemInFolder'>): void {
  const command = requireHelper(deps.helperPath);
  deps.showItemInFolder(helperAppBundlePath(command) ?? command);
}
