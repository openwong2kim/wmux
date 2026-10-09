import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkNativeTranscriptPath, codexSessionRoot } from './providers';
import type { ResumeBinding } from '../../shared/agentResume';

/** A liveness check reads the account's files: reuse its answer briefly. */
export const RESUME_CACHE_MS = 30_000;
/** Tests: forget every cached lookup. */
export function clearResumeCache(): void {
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
 * (agent, session, transcript, folder, account root) for RESUME_CACHE_MS;
 * `fresh` skips the cache (a launch re-checks) and stores its answer.
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
