import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {DaemonSession} from '../types';
import type {CodexRelayObservation} from './codexTuiSelection';
import {isPhoneCodexSession} from './recoverCodexPane';

type Pane = Pick<DaemonSession,'id'|'exec'|'wslTarget'|'env'|'cwd'|'codexRelayResume'> & {cmd?:string};
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function account(pane:Pane):string {return fs.realpathSync(pane.env.CODEX_HOME || path.join(os.homedir(),'.codex'));}
function validTranscript(file:string,root:string,threadId:string):boolean {
  if(!path.isAbsolute(file) || file.includes('\0'))return false;
  const resolved=fs.realpathSync(file);
  const sessions=fs.realpathSync(path.join(root,'sessions'));
  return sessions.startsWith(root+path.sep) && resolved.startsWith(sessions+path.sep) && path.basename(resolved).endsWith(`-${threadId}.jsonl`) && fs.statSync(resolved).isFile();
}
/** Snapshot only an owned foreground selection with a durable account-local rollout.
 * A LIVE relay with no/in-flight/empty selection erases a previous hint rather than
 * resuming another chat. Losing the relay itself (`live:false` — transport closed,
 * pane retired, no relay for this owner) preserves the last confirmed hint: it is
 * not evidence the pane changed threads, and erasing it would strand the
 * conversation on the next recovery. Recovery revalidates account/cwd/rollout. */
export function captureCodexRelayResume(pane:Pane,observed:CodexRelayObservation):void {
  if(!isPhoneCodexSession(pane) || !observed.live)return;
  const selection = observed.selection;
  delete pane.codexRelayResume;
  try {
    if(!selection || !uuid.test(selection.threadId) || !selection.transcriptPath ||
      fs.realpathSync(selection.cwd)!==fs.realpathSync(pane.cwd))return;
    const codeHome=account(pane);
    if(!validTranscript(selection.transcriptPath,codeHome,selection.threadId))return;
    pane.codexRelayResume={threadId:selection.threadId,cwd:fs.realpathSync(selection.cwd),codeHome,
      transcriptPath:fs.realpathSync(selection.transcriptPath)};
  } catch {/* No durable selection is safer than a latest-in-directory guess. */}
}
/** Phone-created relay panes never fall back to `resume --last`.
 * Revalidate the persisted account/cwd/rollout before constructing a fixed argv fragment. */
export function codexRelayResumeCommand(pane:Pane):string|undefined {
  if(!isPhoneCodexSession(pane))return undefined;
  // A pane whose directory is gone gets no launch command — the caller's own
  // "cwd gone → fresh, not wrong-target resume" rule, which its early return on
  // this function sits in front of. Until now that rule was upheld here only as
  // a side effect of `realpathSync(pane.cwd)` throwing inside the try below, so
  // a validation that stopped dereferencing the cwd would have silently
  // resumed a thread in a directory that no longer exists. Say it outright.
  if(!fs.existsSync(pane.cwd))return undefined;
  const base=pane.exec!.command;
  const binding=pane.codexRelayResume;
  try {
    if(binding && uuid.test(binding.threadId) && binding.codeHome===account(pane) &&
      fs.realpathSync(binding.cwd)===fs.realpathSync(pane.cwd) && validTranscript(binding.transcriptPath,binding.codeHome,binding.threadId)) {
      return `codex resume ${binding.threadId}${base.slice('codex'.length)}`;
    }
  } catch {/* Changed/deleted account, cwd or rollout: launch a fresh thread. */}
  return base;
}
