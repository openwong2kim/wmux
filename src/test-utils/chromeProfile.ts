import type { ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ChromeLauncher } from '../main/browser-session/ChromeLauncher';
import { pinDownloadDir } from './chromeDownloads';
import { REMOVE_TEMP_DIR_HOOK_TIMEOUT_MS, removeTempDirs } from './removeTempDir';

/**
 * A real-Chrome suite's temp profile: the user-data-dir, its pinned download
 * folder (pinDownloadDir), and any other temp dir the suite hands Chrome
 * (`scratch`), all removed together by `remove()`.
 *
 * A Chrome profile is tens of MB once Chrome has run on it; suites that left
 * theirs behind filled a test machine's disk. Call `remove()` from afterAll
 * whether or not the launch worked, after Chrome has exited (stopChrome, or
 * the child's exit), so it does not write files back behind the removal.
 * Removal that fails throws (removeTempDirs), except on Windows, where a file
 * another process still holds only warns.
 */
export interface TempChromeProfile {
  /** The user-data-dir. */
  readonly dir: string;
  /** Its default download folder. */
  readonly downloads: string;
  /** Another temp dir, removed with the profile. */
  scratch(prefix: string): string;
  remove(): Promise<void>;
}

/** Budget for a hook that runs stopChrome and then remove(). */
export const CHROME_TEARDOWN_TIMEOUT_MS = REMOVE_TEMP_DIR_HOOK_TIMEOUT_MS + 20_000;

/** How long a disposed Chrome gets to exit before SIGKILL, and again after it. */
const EXIT_WAIT_MS = 5_000;

export function tempChromeProfile(prefix: string, opts: { preferences?: Record<string, unknown> } = {}): TempChromeProfile {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  let downloads: string;
  try {
    downloads = pinDownloadDir(dir, opts.preferences);
  } catch (err) {
    // No profile reaches the caller, so nothing else would remove the dir.
    fs.rmSync(dir, { recursive: true, force: true });
    throw err;
  }
  const owned = [dir, downloads];
  return {
    dir,
    downloads,
    scratch: (scratchPrefix) => {
      const made = fs.mkdtempSync(path.join(os.tmpdir(), scratchPrefix));
      owned.push(made);
      return made;
    },
    remove: async () => {
      try {
        await removeTempDirs(owned);
      } catch (err) {
        if (process.platform !== 'win32') throw err;
        console.warn(`[chromeProfile] ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  };
}

function exited(child: ChildProcess, ms: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.off('exit', onExit);
      resolve(false);
    }, ms);
    const onExit = () => {
      clearTimeout(timer);
      resolve(true);
    };
    child.once('exit', onExit);
  });
}

/**
 * Dispose `launcher` and wait until every Chrome it had has exited. dispose()
 * waits only on its graceful path; its signal fallback, and a let-go pipe
 * Chrome it SIGKILLs, return before the process is gone.
 */
export async function stopChrome(launcher: ChromeLauncher | null | undefined): Promise<void> {
  if (!launcher) return;
  const own = launcher as unknown as { child: ChildProcess | null; exiting: { child: ChildProcess } | null };
  const children = [own.child, own.exiting?.child].filter((c): c is ChildProcess => !!c);
  await launcher.dispose();
  await Promise.all(children.map(async (child) => {
    if (await exited(child, EXIT_WAIT_MS)) return;
    try {
      child.kill('SIGKILL');
    } catch { /* already gone */ }
    await exited(child, EXIT_WAIT_MS);
  }));
}
