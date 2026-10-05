import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { TerminalLaunchAgent } from '../../shared/transcript/terminalChat';
import { canonicalDir, latestCodexRolloutForCwd } from './codexRolloutByCwd';
import { checkNativeTranscriptPath, codexSessionRoot } from './providers';
import type { ResumeBinding } from '../../shared/agentResume';

/** Claude Code's project directory name for a cwd; names past 200 characters get a hash suffix. */
const CLAUDE_NAME_MAX = 200;
const claudeProjectName = (cwd: string): string => cwd.replace(/[^A-Za-z0-9]/g, '-');
/** How much of a transcript is searched for the `cwd` it was recorded in. */
const CWD_SCAN_BYTES = 64 * 1024;

/** The first `cwd` a Claude transcript records, from its first CWD_SCAN_BYTES. */
async function transcriptCwd(file: string): Promise<string | undefined> {
  let handle: fs.promises.FileHandle | undefined;
  try {
    handle = await fs.promises.open(file, 'r');
    const buf = Buffer.alloc(CWD_SCAN_BYTES);
    const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
    for (const line of buf.subarray(0, bytesRead).toString('utf8').split('\n')) {
      try {
        const cwd = (JSON.parse(line) as { cwd?: unknown }).cwd;
        if (typeof cwd === 'string') return cwd;
      } catch { /* a partial last line, or not JSON */ }
    }
    return undefined;
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/**
 * The session `claude --continue` run in `cwd` would pick: the most recently
 * modified non-empty transcript in the project directory Claude keys on that
 * cwd. Only the root Claude itself reads counts (`CLAUDE_CONFIG_DIR`, else
 * `~/.claude`). The literal and the physical path are both tried: a shell's
 * `$PWD` can be logical (`/tmp`) while Claude records the real one. A name
 * past 200 characters ends in a hash this code cannot recompute, so a project
 * matched by its prefix counts only when its transcript records this cwd.
 */
export async function latestClaudeSessionForCwd(cwd: string, env: Record<string, string | undefined>): Promise<string | undefined> {
  const root = path.join(env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects');
  const dirs = new Set([cwd, canonicalDir(cwd)]);
  let projects: string[] | undefined;
  let best: { id: string; mtime: number } | undefined;
  for (const dir of dirs) {
    const name = claudeProjectName(dir);
    const long = name.length > CLAUDE_NAME_MAX;
    let candidates = [name];
    if (long) {
      try { projects ??= await fs.promises.readdir(root); } catch { projects = []; }
      const prefix = `${name.slice(0, CLAUDE_NAME_MAX)}-`;
      candidates = projects.filter((entry) => entry.startsWith(prefix));
    }
    for (const candidate of candidates) {
      const project = path.join(root, candidate);
      let files: string[];
      try { files = await fs.promises.readdir(project); } catch { continue; }
      let newest: { id: string; mtime: number; file: string } | undefined;
      for (const file of files) {
        if (!file.endsWith('.jsonl')) continue;
        try {
          const stat = await fs.promises.stat(path.join(project, file));
          if (stat.isFile() && stat.size > 0 && (!newest || stat.mtimeMs > newest.mtime)) {
            newest = { id: file.slice(0, -'.jsonl'.length), mtime: stat.mtimeMs, file: path.join(project, file) };
          }
        } catch { /* gone between the listing and the stat */ }
      }
      if (!newest) continue;
      if (long) {
        const recorded = await transcriptCwd(newest.file);
        if (recorded === undefined || !dirs.has(recorded) && canonicalDir(recorded) !== canonicalDir(cwd)) continue;
      }
      if (!best || newest.mtime > best.mtime) best = { id: newest.id, mtime: newest.mtime };
    }
  }
  return best?.id;
}

/** A lookup reads many files (Codex: up to thousands of stats): reuse it briefly. */
export const RESUME_CACHE_MS = 30_000;
const cache = new Map<string, { until: number; result: Promise<string | undefined> }>();

/**
 * The session a resume launch of `agent` in `cwd` would continue, or
 * undefined when there is none. Cached per (agent, cwd, account root) for
 * RESUME_CACHE_MS.
 */
export function latestResumeSession(
  agent: TerminalLaunchAgent, cwd: string, env: Record<string, string | undefined>, now = Date.now(),
): Promise<string | undefined> {
  const defined: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) if (typeof value === 'string') defined[key] = value;
  const account = agent === 'claude' ? defined.CLAUDE_CONFIG_DIR ?? '' : codexSessionRoot(defined);
  const key = JSON.stringify([agent, cwd, account]);
  for (const [k, entry] of cache) if (entry.until <= now) cache.delete(k);
  const hit = cache.get(key);
  if (hit) return hit.result;
  const result = (agent === 'claude' ? latestClaudeSessionForCwd(cwd, defined) : latestCodexRolloutForCwd(cwd, defined))
    .catch(() => undefined);
  cache.set(key, { until: now + RESUME_CACHE_MS, result });
  return result;
}

/** Tests: forget every cached lookup. */
export function clearResumeCache(): void {
  cache.clear();
  boundCache.clear();
}

const boundCache = new Map<string, { until: number; result: Promise<boolean> }>();

/** Whether `file` resolves inside `root` (both through their real paths). */
async function realInside(file: string, root: string): Promise<boolean> {
  const [real, base] = await Promise.all([fs.promises.realpath(file), fs.promises.realpath(root)]);
  return real.startsWith(base + path.sep);
}

/**
 * Whether a pane's resume binding still names a conversation the agent can
 * continue: its recorded transcript is a non-empty file inside the session
 * root of the account the launch will use (Claude: `CLAUDE_CONFIG_DIR`, else
 * `~/.claude`, and no other root), and its folder still exists. Cached per
 * (agent, session, transcript, folder, account root) for RESUME_CACHE_MS,
 * like the lookup above; `fresh` skips the cache (a launch re-checks) and
 * stores its answer.
 */
export function boundSessionLives(
  binding: Pick<ResumeBinding, 'agent' | 'sessionId' | 'cwd' | 'transcriptPath'>,
  env: Record<string, string | undefined>, opts: { now?: number; fresh?: boolean } = {},
): Promise<boolean> {
  const now = opts.now ?? Date.now();
  const defined: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) if (typeof value === 'string') defined[key] = value;
  const account = binding.agent === 'claude' ? defined.CLAUDE_CONFIG_DIR ?? '' : codexSessionRoot(defined);
  const key = JSON.stringify([binding.agent, binding.sessionId, binding.transcriptPath ?? '', binding.cwd, account]);
  for (const [k, entry] of boundCache) if (entry.until <= now) boundCache.delete(k);
  const hit = opts.fresh ? undefined : boundCache.get(key);
  if (hit) return hit.result;
  const file = binding.transcriptPath;
  const result = (async () => {
    if (!file || !checkNativeTranscriptPath(binding.agent, file, binding.sessionId, defined).ok) return false;
    // The Claude guard also accepts the default root when CLAUDE_CONFIG_DIR is set.
    if (binding.agent === 'claude' && !await realInside(file, path.join(defined.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects'))) return false;
    const [record, folder] = await Promise.all([fs.promises.stat(file), fs.promises.stat(binding.cwd)]);
    return record.isFile() && record.size > 0 && folder.isDirectory();
  })().catch(() => false);
  boundCache.set(key, { until: now + RESUME_CACHE_MS, result });
  return result;
}
