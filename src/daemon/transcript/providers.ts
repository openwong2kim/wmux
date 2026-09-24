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
  try {
    const home = fs.realpathSync(env?.CODEX_HOME || process.env.CODEX_HOME || path.join(os.homedir(), '.codex'));
    const root = fs.realpathSync(path.join(home, 'sessions'));
    const resolved = fs.realpathSync(file);
    if (!root.startsWith(home + path.sep) || !resolved.startsWith(root + path.sep) || !fs.lstatSync(file).isFile() ||
        !path.basename(resolved).endsWith(`-${id}.jsonl`)) return { ok: false, reason: 'outside-account-session' };
    return { ok: true, reason: '' };
  } catch { return { ok: false, reason: 'unreadable' }; }
}
