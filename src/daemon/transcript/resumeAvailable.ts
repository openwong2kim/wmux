import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { TerminalLaunchAgent } from '../../shared/transcript/terminalChat';
import { canonicalDir, hasCodexRolloutForCwd } from './codexRolloutByCwd';

/** Claude Code's project directory name for a cwd; names past 200 characters get a hash suffix. */
const CLAUDE_NAME_MAX = 200;
const claudeProjectName = (cwd: string): string => cwd.replace(/[^A-Za-z0-9]/g, '-');

/**
 * Whether `claude --continue` run in `cwd` has a conversation to continue: a
 * non-empty transcript in the project directory Claude keys on that cwd. Only
 * the root Claude itself reads counts (`CLAUDE_CONFIG_DIR`, else `~/.claude`).
 * The literal and the physical path are both tried: a shell's `$PWD` can be
 * logical (`/tmp`) while Claude records the real one (`/private/tmp`).
 */
export function claudeHasConversationForCwd(cwd: string, env: Record<string, string | undefined>): boolean {
  const root = path.join(env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects');
  let projects: string[] | undefined;
  for (const dir of new Set([cwd, canonicalDir(cwd)])) {
    const name = claudeProjectName(dir);
    let candidates = [name];
    if (name.length > CLAUDE_NAME_MAX) {
      try { projects ??= fs.readdirSync(root); } catch { projects = []; }
      const prefix = `${name.slice(0, CLAUDE_NAME_MAX)}-`;
      candidates = projects.filter((entry) => entry.startsWith(prefix));
    }
    for (const candidate of candidates) {
      const project = path.join(root, candidate);
      let files: string[];
      try { files = fs.readdirSync(project); } catch { continue; }
      for (const file of files) {
        if (!file.endsWith('.jsonl')) continue;
        try {
          const stat = fs.statSync(path.join(project, file));
          if (stat.isFile() && stat.size > 0) return true;
        } catch { /* gone between the listing and the stat */ }
      }
    }
  }
  return false;
}

/** Whether a resume launch of `agent` in `cwd` has a conversation to continue. */
export function resumeAvailable(agent: TerminalLaunchAgent, cwd: string, env: Record<string, string | undefined>): boolean {
  if (agent === 'claude') return claudeHasConversationForCwd(cwd, env);
  const defined: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) if (typeof value === 'string') defined[key] = value;
  return hasCodexRolloutForCwd(cwd, defined);
}
