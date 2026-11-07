import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Point a test profile's default download folder at a new temp dir, and
 * return that dir. Call it before the profile's Chrome starts.
 *
 * Chrome on macOS and Windows takes its default Downloads folder from the
 * account, not from HOME, so the isolated test HOME does not keep a download
 * with no path set out of the account's real Downloads folder. A pinned
 * folder does.
 */
export function pinDownloadDir(profileDir: string): string {
  const downloads = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-test-downloads-'));
  fs.mkdirSync(path.join(profileDir, 'Default'), { recursive: true });
  fs.writeFileSync(
    path.join(profileDir, 'Default', 'Preferences'),
    JSON.stringify({ download: { default_directory: downloads, prompt_for_download: false } }),
  );
  return downloads;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The entries in the account's real Downloads folder (or `dir`) that Chrome
 * could have saved for a file named one of `names`: the name, its " (n)"
 * variants and their in-progress ".crdownload" forms. Read only; empty when
 * the folder can't be read. The default reads the account (os.userInfo()),
 * not HOME, which the test setup points elsewhere.
 */
export function accountDownloads(names: readonly string[], dir = path.join(os.userInfo().homedir, 'Downloads')): Set<string> {
  const patterns = names.map((name) => {
    const ext = path.extname(name);
    const stem = name.slice(0, name.length - ext.length);
    return new RegExp(`^${escape(stem)}( \\(\\d+\\))?${escape(ext)}(\\.crdownload)?$`);
  });
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return new Set();
  }
  return new Set(entries.filter((entry) => patterns.some((p) => p.test(entry))));
}
