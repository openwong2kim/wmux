// #3049 — the hold list: the ids of the panes main created as user shells
// (passthrough env policy), written by main into the wmux data directory and
// read by the daemon once at boot. A held plain shell waits as a placeholder
// until main starts it with the credential values it passes in; sessions.json
// never holds those values.
//
// Ids only, never a value and never a grant: credentials reach a shell solely
// through main's promote, which checks main's own record (userData) and the
// env policy again. Editing this file can only delay a shell's start (the
// daemon's fallback starts it without credentials), never hand one anything.

import fs from 'node:fs';

/** The file name, in `~/.wmux{suffix}` (daemon getWmuxDir / shared getWmuxHomeDir). */
export const USER_SHELL_HOLDS_FILE = 'user-shell-holds.json';

/** Held shells started at once, by main's connect pass and by the daemon's fallback alike. */
export const HELD_START_CONCURRENCY = 6;

/** More ids than this are ignored; the hold is a convenience, not a ledger. */
export const USER_SHELL_HOLDS_MAX = 1000;

const SESSION_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;

export interface UserShellHoldsFile {
  version: 1;
  ids: string[];
}

/** The file's content for `ids`: valid session ids only, capped. */
export function userShellHoldsContent(ids: Iterable<string>): UserShellHoldsFile {
  const out: string[] = [];
  for (const id of ids) {
    if (out.length >= USER_SHELL_HOLDS_MAX) break;
    if (typeof id === 'string' && SESSION_ID_RE.test(id)) out.push(id);
  }
  return { version: 1, ids: out };
}

/** The held ids in `text`. Anything unreadable holds nothing (today's recovery). */
export function parseUserShellHolds(text: string): Set<string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return new Set();
  }
  const ids = (parsed as { ids?: unknown } | null)?.ids;
  if (!Array.isArray(ids)) return new Set();
  return new Set(userShellHoldsContent(ids.filter((id): id is string => typeof id === 'string')).ids);
}

/** Read the hold list at `file`; a missing or unreadable file holds nothing. */
export function readUserShellHolds(file: string): Set<string> {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return new Set();
  }
  return parseUserShellHolds(text);
}
