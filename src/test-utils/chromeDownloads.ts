import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Point a test profile's default download folder at a new temp dir, and
 * return that dir. Call it before the profile's Chrome starts. `preferences`
 * are other Preferences the profile starts with.
 *
 * Chrome on macOS takes its default Downloads folder from the account, not
 * from HOME; on Windows it follows USERPROFILE, which the test setup points at
 * its temp home, unless the account's Downloads is redirected to an absolute
 * path. Either way a pinned folder keeps a download with no path set in one
 * known place.
 */
export function pinDownloadDir(profileDir: string, preferences: Record<string, unknown> = {}): string {
  const downloads = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-test-downloads-'));
  try {
    fs.mkdirSync(path.join(profileDir, 'Default'), { recursive: true });
    fs.writeFileSync(
      path.join(profileDir, 'Default', 'Preferences'),
      JSON.stringify({ ...preferences, download: { default_directory: downloads, prompt_for_download: false } }),
    );
  } catch (err) {
    // The caller never learns this dir's name, so it can't remove it.
    fs.rmSync(downloads, { recursive: true, force: true });
    throw err;
  }
  return downloads;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The entries in the Downloads folders a test's Chrome could fall back to (or
 * in `dir`) that Chrome could have saved for a file named one of `names`:
 * the name, its " (n)" variants and their in-progress ".crdownload" forms.
 * Read only; a folder that can't be read adds nothing. By default it reads
 * both the account's real Downloads (os.userInfo()) and the test home's
 * (os.homedir(); on Windows the browser resolves Downloads there).
 */
export function accountDownloads(names: readonly string[], dir?: string): Set<string> {
  const patterns = names.map((name) => {
    const ext = path.extname(name);
    const stem = name.slice(0, name.length - ext.length);
    return new RegExp(`^${escape(stem)}( \\(\\d+\\))?${escape(ext)}(\\.crdownload)?$`);
  });
  const dirs = dir !== undefined
    ? [dir]
    : [...new Set([path.join(os.userInfo().homedir, 'Downloads'), path.join(os.homedir(), 'Downloads')])];
  const found = new Set<string>();
  for (const d of dirs) {
    let entries: string[];
    try {
      entries = fs.readdirSync(d);
    } catch {
      continue;
    }
    for (const entry of entries) if (patterns.some((p) => p.test(entry))) found.add(entry);
  }
  return found;
}
