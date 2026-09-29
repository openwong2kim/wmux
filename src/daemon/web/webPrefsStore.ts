import fs from 'node:fs';
import path from 'node:path';

/**
 * Operator display preferences for `wmux web` that outlive the server.
 *
 * Not `web-state.json`: that record is the running server and its token, and
 * an operator stop deletes it to revoke every credential. A preference such as
 * "no inline images" must survive that stop, or a bare re-run after `--stop`
 * would quietly turn images back on. This file holds nothing secret.
 */
export interface WebPrefs {
  /** False when the operator ran `wmux web --no-inline-images` (#1641). */
  inlineImages: boolean;
}

const PREFS_FILE = 'web-prefs.json';

export function getWebPrefsPath(wmuxDir: string): string {
  return path.join(wmuxDir, PREFS_FILE);
}

/** The saved preferences; a missing or malformed file reads as the defaults. */
export function loadWebPrefs(wmuxDir: string): WebPrefs {
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(getWebPrefsPath(wmuxDir), 'utf8'));
    const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
    return { inlineImages: o['inlineImages'] !== false };
  } catch {
    return { inlineImages: true };
  }
}

/** Persist the preferences. Best effort: returns false when the write failed. */
export function saveWebPrefs(wmuxDir: string, prefs: WebPrefs): boolean {
  const file = getWebPrefsPath(wmuxDir);
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(wmuxDir, { recursive: true });
    fs.writeFileSync(tmp, `${JSON.stringify({ version: 1, inlineImages: prefs.inlineImages })}\n`, 'utf8');
    fs.renameSync(tmp, file);
    return true;
  } catch {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* nothing was written */
    }
    return false;
  }
}
