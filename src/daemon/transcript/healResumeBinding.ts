// #1823: repair a resume binding a Codex hook poisoned through the Claude
// bridge. The bridge stamped `agent: 'claude'` and took the transcript's
// basename as the id, so a Codex pane was saved as `claude --resume
// rollout-<local time>-<thread uuid>`. The rollout file is the evidence of
// what really ran: when it resolves to its thread, the binding becomes the
// Codex one it should have been; otherwise the binding is dropped.
import path from 'node:path';
import { parseCodexRolloutStem, type ResumeBinding } from '../../shared/agentResume';
import { checkNativeTranscriptPath, codexSessionRoot } from './providers';
import { readSessionMeta } from './codexRolloutByCwd';

export interface HealableSession {
  resumeBinding?: ResumeBinding;
  env?: Record<string, string>;
  lastDetectedAgent?: string;
}

/**
 * Heal `session` in place. Returns what happened, or undefined when the
 * binding is not a Claude binding over a rollout stem.
 */
export function healCrossProviderBinding(session: HealableSession): 'converted' | 'dropped' | undefined {
  const binding = session.resumeBinding;
  if (!binding || binding.agent !== 'claude' || typeof binding.sessionId !== 'string') return undefined;
  const stem = parseCodexRolloutStem(binding.sessionId);
  if (!stem) return undefined;
  // Codex files a rollout under the local date its name carries.
  const file = path.join(codexSessionRoot(session.env), stem.year, stem.month, stem.day, `${binding.sessionId}.jsonl`);
  const threadId = readSessionMeta(file)?.id;
  if (typeof threadId === 'string' && threadId.toLowerCase() === stem.threadId.toLowerCase()
      && checkNativeTranscriptPath('codex', file, threadId, session.env).ok) {
    // permissionMode is a Claude flag; it does not carry over.
    session.resumeBinding = { agent: 'codex', sessionId: threadId, cwd: binding.cwd, transcriptPath: file, ts: binding.ts };
    // The rollout was the pane's last bound conversation (a later Claude run
    // would have replaced it), so the pill should offer Codex.
    if (!session.lastDetectedAgent || session.lastDetectedAgent === 'claude') session.lastDetectedAgent = 'codex';
    return 'converted';
  }
  delete session.resumeBinding;
  return 'dropped';
}
