import * as fs from 'fs';
import * as path from 'path';

/**
 * The Claude Code config folders a `claude` can run with, for the commands that
 * write wmux's entries into their settings.json (setup-hooks, setup-statusline,
 * the in-app install).
 *
 * Claude reads `$CLAUDE_CONFIG_DIR/settings.json` when that env is set, else
 * `~/.claude/settings.json`, and wmux itself starts account panes with
 * CLAUDE_CONFIG_DIR set to each registered account's folder (accounts.json).
 * Writing only `~/.claude` left both groups without wmux's hooks.
 */

export type ClaudeTargetKind = 'env' | 'default' | 'account';

export interface ClaudeConfigTarget {
  kind: ClaudeTargetKind;
  label: string;
  configDir: string;
  settingsPath: string;
}

interface AccountRowLoose {
  name?: unknown;
  vendor?: unknown;
  configDir?: unknown;
}

/** Best-effort read of registered claude accounts from `<wmuxDir>/accounts.json`.
 *  The CLI reads the file directly (main owns writes); absence / corruption
 *  degrades to no account targets. */
export function readClaudeAccountTargets(wmuxDir: string): Array<{ label: string; settingsPath: string; configDir: string }> {
  try {
    const raw = fs.readFileSync(path.join(wmuxDir, 'accounts.json'), 'utf8');
    const parsed = JSON.parse(raw) as { accounts?: unknown };
    if (!Array.isArray(parsed?.accounts)) return [];
    const out: Array<{ label: string; settingsPath: string; configDir: string }> = [];
    for (const a of parsed.accounts as AccountRowLoose[]) {
      if (!a || a.vendor !== 'claude') continue;
      if (typeof a.configDir !== 'string' || a.configDir.length === 0) continue;
      out.push({
        label: typeof a.name === 'string' && a.name ? a.name : a.configDir,
        settingsPath: path.join(a.configDir, 'settings.json'),
        configDir: a.configDir,
      });
    }
    return out;
  } catch {
    return [];
  }
}

/** One identity for one settings.json, used by both the target dedupe and the
 *  backup filenames — they must not disagree about what "the same file" means.
 *
 *  realpath first: a configDir symlinked at the dotfiles repo is the same file
 *  under two names, and resolving only lexically let the alias slip past the
 *  dedupe and split its backup in two. Case folding covers Windows AND macOS —
 *  APFS is case-insensitive by default, so `~/.Claude` and `~/.claude` are one
 *  file there too, which the old win32-only fold got wrong. */
export function normalizedTargetKey(settingsPath: string): string {
  const absolute = path.resolve(settingsPath);
  let resolved = absolute;
  try {
    // The file itself usually does not exist yet; its directory is what matters
    // for the symlink question.
    resolved = path.join(fs.realpathSync(path.dirname(absolute)), path.basename(absolute));
  } catch {
    /* directory absent — the lexical path is the best identity available */
  }
  const foldCase = process.platform === 'win32' || process.platform === 'darwin';
  return foldCase ? resolved.toLowerCase() : resolved;
}

/** A UNC folder (`\\wsl.localhost\…`, a network share): the hook commands wmux
 *  writes name this machine's node and bridge path, which a Claude running
 *  behind that path cannot run. */
export function isUncPath(dir: string): boolean {
  return /^[\\/]{2}/.test(dir);
}

/**
 * CLAUDE_CONFIG_DIR as Claude would use it: an absolute folder, or none.
 * A relative value is refused, with the reason, rather than resolved against
 * whatever folder this process happens to run in.
 */
export function envClaudeConfigDir(value: string | undefined): { dir: string | null; refused: string | null } {
  const trimmed = value?.trim();
  if (!trimmed) return { dir: null, refused: null };
  if (!path.isAbsolute(trimmed)) {
    return { dir: null, refused: `CLAUDE_CONFIG_DIR is not an absolute path (${trimmed}); it was left out.` };
  }
  return { dir: path.resolve(trimmed), refused: null };
}

export interface ClaudeConfigTargetOptions {
  /** CLAUDE_CONFIG_DIR, already checked by envClaudeConfigDir. */
  envDir: string | null;
  /** `~/.claude/settings.json` (callers pass their own, so tests never reach a real home). */
  defaultSettingsPath: string;
  /** `~/.wmux<suffix>`: where this instance's accounts.json lives. */
  wmuxDir: string;
  /** The Claude accounts, when the caller holds them already (main's account
   *  store); else they are read from `<wmuxDir>/accounts.json`. */
  accounts?: ReadonlyArray<{ label: string; configDir: string }>;
  /**
   * Whether `~/.claude` is a target when CLAUDE_CONFIG_DIR points elsewhere:
   * a removal clears it, an install updates it only when it already holds
   * wmux's entries. Unused when the env is unset: it is then the primary.
   */
  includeDefault: (settingsPath: string) => boolean;
}

/**
 * The targets, primary first: the env folder when set, else `~/.claude`. Then
 * `~/.claude` again when the env points elsewhere and `includeDefault` says so,
 * then every Claude account on a local folder. A file reached under two names
 * (an account at the env folder, a junction, a case variant) is listed once.
 */
export function claudeConfigTargets(opts: ClaudeConfigTargetOptions): ClaudeConfigTarget[] {
  const defaultSettings = opts.defaultSettingsPath;
  const defaultDir = path.dirname(defaultSettings);
  const candidates: ClaudeConfigTarget[] = [];
  if (opts.envDir) {
    candidates.push({ kind: 'env', label: `CLAUDE_CONFIG_DIR (${opts.envDir})`, configDir: opts.envDir, settingsPath: path.join(opts.envDir, 'settings.json') });
    if (opts.includeDefault(defaultSettings)) {
      candidates.push({ kind: 'default', label: 'default (~/.claude)', configDir: defaultDir, settingsPath: defaultSettings });
    }
  } else {
    candidates.push({ kind: 'default', label: 'default (~/.claude)', configDir: defaultDir, settingsPath: defaultSettings });
  }
  for (const account of opts.accounts ?? readClaudeAccountTargets(opts.wmuxDir)) {
    if (isUncPath(account.configDir)) continue;
    candidates.push({ kind: 'account', label: `account ${account.label}`, configDir: account.configDir, settingsPath: path.join(account.configDir, 'settings.json') });
  }
  const seen = new Set<string>();
  return candidates.filter((t) => {
    const key = normalizedTargetKey(t.settingsPath);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
