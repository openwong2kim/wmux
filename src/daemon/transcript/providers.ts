import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AgentSlug } from '../../shared/agentIdentity';
import { checkTranscriptPath, type TranscriptPathCheck } from '../hooks/transcriptPathGuard';
import { parseTranscriptLineDetailed, type ParsedTranscriptLine } from './parseEntry';
import { parseCodexLineDetailed } from './parseCodexEntry';

/** Each native transcript adapter supplies BOTH decoding and account/identity
 * containment. Unknown agents cannot inherit another agent's parser or guard.
 * API-backed agents can supply a different reader without changing TurnEvent. */
export interface FileTranscriptProvider {
  parse(line: string, offset: number): ParsedTranscriptLine;
  check(file: string, nativeSessionId: string, env?: Record<string, string>): TranscriptPathCheck;
}
// Keyed by registry slug; Partial on purpose: an agent without a file
// transcript reader is `unsupported-agent`. Parsers are code, so the table
// stays here rather than on the registry row.
const providers: Readonly<Record<string, FileTranscriptProvider>> = {
  claude: { parse: parseTranscriptLineDetailed, check: checkTranscriptPath },
  codex: { parse: parseCodexLineDetailed, check: checkCodexTranscriptPath },
} satisfies Partial<Record<AgentSlug, FileTranscriptProvider>>;
export function fileTranscriptProvider(agent: string): FileTranscriptProvider | undefined {
  return Object.hasOwn(providers, agent) ? providers[agent] : undefined;
}
export function checkNativeTranscriptPath(agent: string, file: string, nativeSessionId: string, env?: Record<string, string>): TranscriptPathCheck {
  return fileTranscriptProvider(agent)?.check(file, nativeSessionId, env) ?? { ok: false, reason: 'unsupported-agent' };
}
export function codexSessionRoot(env?: Record<string, string>): string {
  return path.join(env?.CODEX_HOME || process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'sessions');
}
function checkCodexTranscriptPath(file: string, id: string, env?: Record<string, string>): TranscriptPathCheck {
  if (!path.isAbsolute(file) || file.includes('\0') || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id)) return { ok: false, reason: 'invalid-identity' };
  let home: string;
  let root: string;
  try {
    home = fs.realpathSync(env?.CODEX_HOME || process.env.CODEX_HOME || path.join(os.homedir(), '.codex'));
    root = fs.realpathSync(path.join(home, 'sessions'));
  } catch { return { ok: false, reason: 'unreadable' }; }
  try {
    const resolved = fs.realpathSync(file);
    if (!root.startsWith(home + path.sep) || !resolved.startsWith(root + path.sep) || !fs.lstatSync(file).isFile() ||
        !path.basename(resolved).endsWith(`-${id}.jsonl`)) return { ok: false, reason: 'outside-account-session' };
    return { ok: true, reason: '' };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return { ok: false, reason: 'unreadable' };
    return pendingCodexSessionFile(file, id, home, root);
  }
}

/** Same bound as the Claude guard's ancestor walk (`resolveIfPossible`). */
const MAX_PENDING_WALK = 64;

/**
 * Codex names its session file at thread start but writes it on the first
 * turn, so a fresh pane's binding points at a file (and possibly date
 * directories) that do not exist yet. That is an empty conversation, not a
 * refusal, as long as containment holds: the path has no `.` or `..`
 * segment, its name is this thread's, every missing component is truly
 * absent (nothing at all, not even a dangling symlink), and the nearest
 * ancestor that does exist resolves inside the account's `sessions` root,
 * so the file, once written, lands there.
 *
 * The segment check reads both separators rather than comparing against
 * `path.normalize`, which on win32 rewrites `/` to `\` and so refused a
 * slash-form path here that the existing-file branch (realpath) accepts.
 */
function pendingCodexSessionFile(file: string, id: string, home: string, root: string): TranscriptPathCheck {
  const refuse = { ok: false, reason: 'outside-account-session' };
  if (file.split(/[\\/]/).some((segment) => segment === '.' || segment === '..')
      || !path.basename(file).endsWith(`-${id}.jsonl`) || !root.startsWith(home + path.sep)) {
    return refuse;
  }
  let dir = file;
  const missing: string[] = [];
  for (let depth = 0; depth < MAX_PENDING_WALK; depth++) {
    // Only an entry that does not exist at all may be skipped: a symlink
    // (dangling or not) or anything else occupying the name refuses, since
    // realpath reports ENOENT for a dangling link exactly as for a gap.
    let occupied: fs.Stats | undefined;
    try { occupied = fs.lstatSync(dir); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return { ok: false, reason: 'unreadable' };
    }
    if (occupied) {
      if (missing.length === 0) return refuse; // the file itself already exists as something else
      let real: string;
      try { real = fs.realpathSync(dir); } catch { return refuse; }
      if (!fs.statSync(real).isDirectory()) return refuse;
      const target = path.join(real, ...missing);
      return target.startsWith(root + path.sep) ? { ok: true, reason: '', pending: true } : refuse;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return { ok: false, reason: 'unreadable' };
    missing.unshift(path.basename(dir));
    dir = parent;
  }
  return refuse;
}
