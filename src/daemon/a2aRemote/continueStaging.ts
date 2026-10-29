import path from 'node:path';
import { isHostId, type HostId } from '../../shared/a2aRemote';
import { isContinueId, isContinueSessionId, normalizeContinueRel } from '../../shared/a2aContinue';

/**
 * Where the bytes of a conversation another PC hands over wait until they
 * are placed: `<a2aDir>/continue-in/<hostId>/<continueId>/`, laid out as
 * they will sit in Claude's project folder:
 *
 *   <sessionId>.jsonl    the transcript
 *   <sessionId>/<rel>    each file of the manifest
 *
 * A request holds every byte there, checked, from `received` on. Nothing
 * else ever has a name there of the form `<uuid>.jsonl` or `<uuid>/`.
 */
export function continueStagingDir(a2aDir: string, hostId: HostId, continueId: string): string {
  if (!isHostId(hostId) || !isContinueId(continueId)) throw new Error('not a continue request id');
  return path.join(a2aDir, 'continue-in', hostId, continueId);
}

/** The staged transcript of conversation `sessionId`. */
export function continueStagedTranscript(dir: string, sessionId: string): string {
  if (!isContinueSessionId(sessionId)) throw new Error('not a session id');
  return path.join(dir, `${sessionId}.jsonl`);
}

/** The staged copy of one file of the conversation's folder; `rel` as the manifest names it. */
export function continueStagedFile(dir: string, sessionId: string, rel: string): string {
  if (!isContinueSessionId(sessionId) || normalizeContinueRel(rel) !== rel) throw new Error('not a conversation file');
  return path.join(dir, sessionId, ...rel.split('/'));
}
