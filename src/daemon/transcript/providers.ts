import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
const providers: Readonly<Record<string, FileTranscriptProvider>> = {
  claude: { parse: parseTranscriptLineDetailed, check: checkTranscriptPath },
  codex: { parse: parseCodexLineDetailed, check: checkCodexTranscriptPath },
};
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

/**
 * Codex names its session file at thread start but writes it on the first
 * turn, so a fresh pane's binding points at a file (and possibly date
 * directories) that do not exist yet. That is an empty conversation, not a
 * refusal, as long as containment holds: the path is normalized (no `..`),
 * its name is this thread's, and the nearest ancestor that does exist
 * resolves inside the account's `sessions` root, so the file, once written,
 * lands there.
 */
function pendingCodexSessionFile(file: string, id: string, home: string, root: string): TranscriptPathCheck {
  if (path.normalize(file) !== file || !path.basename(file).endsWith(`-${id}.jsonl`) || !root.startsWith(home + path.sep)) {
    return { ok: false, reason: 'outside-account-session' };
  }
  // Only a name nothing occupies: a dangling symlink also fails realpath with
  // ENOENT, and it is not a file the agent has yet to write.
  try { fs.lstatSync(file); return { ok: false, reason: 'outside-account-session' }; } catch { /* absent: go on */ }
  let dir = path.dirname(file);
  const missing: string[] = [path.basename(file)];
  for (;;) {
    try {
      const real = fs.realpathSync(dir);
      if (!fs.statSync(real).isDirectory()) return { ok: false, reason: 'outside-account-session' };
      const target = path.join(real, ...missing);
      return target.startsWith(root + path.sep) ? { ok: true, reason: '', pending: true } : { ok: false, reason: 'outside-account-session' };
    } catch (error) {
      const parent = path.dirname(dir);
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || parent === dir) return { ok: false, reason: 'unreadable' };
      missing.unshift(path.basename(dir));
      dir = parent;
    }
  }
}
