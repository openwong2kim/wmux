// ─── Token sign-in: Claude Code's first-run flag in an account's own folder ──
//
// Claude Code reads CLAUDE_CODE_OAUTH_TOKEN only once its first-run setup is
// marked done in `<CLAUDE_CONFIG_DIR>/.claude.json` (`hasCompletedOnboarding`);
// in a fresh folder it starts the setup and asks for a browser login instead.
// When an account is given a long-lived token, wmux sets that one key in the
// account's own folder, under the lock Claude Code saves the file with, and
// leaves every other key, the indent and a byte order mark as they were.
//
// Only a folder wmux provisioned under `<wmuxDir>/accounts/` is edited: an
// account registered on another folder (the home directory, say) could make
// `<configDir>/.claude.json` the operator's own `~/.claude.json`. A symlinked
// `.claude.json` is refused for the same reason.

import fs from 'node:fs';
import path from 'node:path';
import { withClaudeConfigLock, type ClaudeConfigLockDeps } from '../../shared/claudeConfigLock';
import { stripBom } from '../../shared/stripBom';
import { applyConfigEdit } from '../surfaces/safeWrite/applyConfigEdit';

export const CLAUDE_ONBOARDING_KEY = 'hasCompletedOnboarding';

export type OnboardingFlagResult =
  | { ok: true; changed: boolean }
  | { ok: false; reason: 'not_provisioned' | 'symlink' | 'locked' | 'malformed' | 'failed'; message: string };

function realOrResolved(p: string): string {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return path.resolve(p);
  }
}

/** True when `dir` is strictly inside `root`, comparing real paths. */
function isStrictlyInside(root: string, dir: string): boolean {
  const rel = path.relative(realOrResolved(root), realOrResolved(dir));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * Set `hasCompletedOnboarding: true` in `<configDir>/.claude.json`, creating
 * the file when it is missing. Never throws: a held lock, a file that is not a
 * JSON object or a failed write comes back as a refusal with a message, and
 * the file is left as it was.
 */
export function markClaudeOnboardingDone(
  configDir: string,
  accountsRoot: string,
  deps: ClaudeConfigLockDeps = {},
): OnboardingFlagResult {
  let isDir = false;
  try { isDir = fs.statSync(configDir).isDirectory(); } catch { /* missing */ }
  if (!isDir || !isStrictlyInside(accountsRoot, configDir)) {
    return { ok: false, reason: 'not_provisioned', message: 'This account does not use a folder wmux created, so its Claude Code settings were left alone.' };
  }
  const file = path.join(realOrResolved(configDir), '.claude.json');
  try {
    if (fs.lstatSync(file).isSymbolicLink()) {
      return { ok: false, reason: 'symlink', message: 'The account\'s .claude.json is a link to another file, so it was left alone.' };
    }
  } catch { /* missing: created below */ }
  try {
    return withClaudeConfigLock(file, () => {
      let text: string | null = null;
      try { text = fs.readFileSync(file, 'utf8'); } catch { /* missing */ }
      if (text !== null) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(stripBom(text));
        } catch {
          parsed = undefined;
        }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          return { ok: false, reason: 'malformed', message: 'The account\'s .claude.json is not a JSON object, so it was left alone.' } as const;
        }
        if ((parsed as Record<string, unknown>)[CLAUDE_ONBOARDING_KEY] === true) return { ok: true, changed: false } as const;
      }
      // No backup: the edit adds one key and nothing here would restore one.
      const res = applyConfigEdit({ path: file, kind: 'json', edits: [{ path: [CLAUDE_ONBOARDING_KEY], op: 'set', value: true }], backup: false });
      return { ok: true, changed: res.changed } as const;
    }, deps);
  } catch (err) {
    const name = (err as Error)?.name;
    if (name === 'ClaudeConfigLockedError') {
      return { ok: false, reason: 'locked', message: 'Claude Code is saving this account\'s settings right now.' };
    }
    if (name === 'JsonEditError') {
      return { ok: false, reason: 'malformed', message: 'The account\'s .claude.json is not valid JSON, so it was left alone.' };
    }
    return { ok: false, reason: 'failed', message: 'The account\'s .claude.json could not be written.' };
  }
}
