// agent-desktop's state directory (AGENT_DESKTOP_HOME), private to wmux.
//
// Every snapshot leaves snapshots/<id>/refmap.json behind, holding the names,
// values and window titles the app showed, and upstream keeps up to 128 of
// them. wmux's records of those snapshots live in memory only, so after a
// restart the files can no longer be used, yet still hold what other apps
// showed. They are removed when the computer service starts and when it is
// disposed. Only this directory is touched, and never through a symlink.

import { promises as fs } from 'node:fs';
import * as path from 'node:path';

/** Creates the directory (0700) if needed and tightens it if it exists. */
export async function prepareDesktopHome(home: string): Promise<void> {
  await fs.mkdir(home, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(home);
  if (!stat.isDirectory()) throw new Error(`${home} is not a directory`);
  await fs.chmod(home, 0o700);
}

/** Removes agent-desktop's saved snapshots from `home`. */
export async function clearDesktopSnapshots(home: string): Promise<void> {
  let stat;
  try {
    stat = await fs.lstat(home);
  } catch {
    return;
  }
  // A symlink (or anything but a real directory) is left alone: what it
  // points at is not wmux's.
  if (!stat.isDirectory()) return;
  await fs.rm(path.join(home, 'snapshots'), { recursive: true, force: true });
  await fs.rm(path.join(home, 'latest_snapshot_id'), { force: true });
}
