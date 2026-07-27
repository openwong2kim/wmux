// Validation for the `transcript_path` a hook payload asks the daemon to
// persist on a pane's resume binding.
//
// The hook envelope is AUTHENTICATED but not TRUSTED: the token proves the
// caller can read the daemon token file, not that the values inside the payload
// are the ones Claude Code would have sent. Whatever lands in
// `resumeBinding.transcriptPath` is later opened and read by the daemon
// (`TranscriptProjector`) and its contents are rendered as a pane's
// conversation, so an unvalidated path is a daemon-side arbitrary-file-read
// primitive with a UI attached — point it at `~/.ssh/config` or a secrets file
// and the "chat" shows the file.
//
// Two conditions, both cheap, together leaving nothing useful to point at:
//   1. the path must resolve INSIDE the Claude projects root, and
//   2. its basename must be exactly `${agentSessionId}.jsonl` — the same id the
//      bridge already derived from the transcript basename, so a real payload
//      satisfies it by construction while a forged one has to guess a uuid it
//      does not control.
//
// `realpath` is used where it can be: containment has to be checked on the
// RESOLVED path or a symlink inside the projects directory walks straight out of
// it. A transcript that does not exist yet cannot be resolved, so the lexical
// form is checked instead — and a path that does not exist is refused later
// anyway by `readTail`'s regular-file guard.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Separator-agnostic last segment. Windows paths relayed to a POSIX daemon (or
 *  replayed from a state file written elsewhere) must not come back whole. */
function lastSegment(value: string): string {
  const segments = value.replace(/\\/g, '/').split('/');
  for (let i = segments.length - 1; i >= 0; i--) {
    if (segments[i]) return segments[i];
  }
  return '';
}

/** Lexically normalize for comparison: one separator, resolved `.`/`..`. */
function normalizeForCompare(value: string): string {
  const unified = value.replace(/\\/g, '/');
  const isAbsolute = unified.startsWith('/');
  const out: string[] = [];
  for (const segment of unified.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      if (out.length > 0 && out[out.length - 1] !== '..') out.pop();
      else if (!isAbsolute) out.push('..');
      continue;
    }
    out.push(segment);
  }
  const joined = out.join('/');
  const prefix = unified.startsWith('//') ? '//' : isAbsolute ? '/' : '';
  // Windows drive letters and macOS/Windows filesystems are case-insensitive;
  // comparing case-sensitively there would reject a legitimate `C:\Users\…` that
  // differs only in case from the derived root.
  const full = `${prefix}${joined}`;
  return process.platform === 'linux' ? full : full.toLowerCase();
}

/** Is `candidate` the same as, or inside, `root`? Both already normalized. */
function isInside(candidate: string, root: string): boolean {
  if (!root) return false;
  return candidate === root || candidate.startsWith(root.endsWith('/') ? root : `${root}/`);
}

/** `realpath` when the path exists, the input otherwise (a not-yet-created
 *  transcript is legal — SessionStart fires before the `.jsonl` is written). */
function resolveIfPossible(value: string): string {
  try {
    return fs.realpathSync(value);
  } catch {
    return value;
  }
}

/**
 * Directories a Claude transcript may legitimately live under.
 *
 * `~/.claude/projects` is the default. `CLAUDE_CONFIG_DIR` relocates it, and
 * wmux already lets a workspace profile set that variable per pane
 * (`workspaceSlice` profile env), so the RESOLVED session's env is consulted
 * too — otherwise a user with a relocated config dir would silently lose Chat
 * View rather than be protected by anything.
 */
export function claudeProjectRoots(sessionEnv?: Record<string, string>): string[] {
  const roots: string[] = [path.join(os.homedir(), '.claude', 'projects')];
  const configured = sessionEnv?.['CLAUDE_CONFIG_DIR'] || process.env['CLAUDE_CONFIG_DIR'];
  if (configured) roots.push(path.join(configured, 'projects'));
  return roots;
}

export interface TranscriptPathCheck {
  ok: boolean;
  /** Why it was refused, for the warn log. Empty when `ok`. */
  reason: string;
}

/**
 * Is this hook-supplied `transcript_path` safe to persist for `agentSessionId`?
 *
 * Refusal is not a fallback to something looser — the binding is stored without
 * a transcript path, which degrades to "Chat View unavailable" for that pane and
 * changes nothing else about the signal.
 */
export function checkTranscriptPath(
  transcriptPath: string,
  agentSessionId: string,
  sessionEnv?: Record<string, string>,
): TranscriptPathCheck {
  if (!transcriptPath || typeof transcriptPath !== 'string') {
    return { ok: false, reason: 'empty' };
  }
  if (transcriptPath.includes('\u0000')) return { ok: false, reason: 'nul-byte' };
  if (!agentSessionId) return { ok: false, reason: 'no-agent-session-id' };

  const expected = `${agentSessionId}.jsonl`;
  const actual = lastSegment(transcriptPath);
  // Case-insensitive because the two filesystems that matter here are, and the
  // id is a uuid either way.
  if (actual.toLowerCase() !== expected.toLowerCase()) {
    return { ok: false, reason: `basename ${actual} != ${expected}` };
  }

  const resolved = normalizeForCompare(resolveIfPossible(transcriptPath));
  for (const root of claudeProjectRoots(sessionEnv)) {
    if (isInside(resolved, normalizeForCompare(resolveIfPossible(root)))) {
      return { ok: true, reason: '' };
    }
  }
  return { ok: false, reason: 'outside the Claude projects root' };
}
