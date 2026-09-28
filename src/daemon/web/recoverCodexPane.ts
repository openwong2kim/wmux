import type {DaemonSessionManager} from '../DaemonSessionManager';
import type {CodexPaneRelays} from './codexPaneRelays';
import {CodexRelayUnavailableError} from './codexTuiRelay';
import path from 'node:path';
import {isWslShell} from '../../shared/wsl';

type CreateParams = Parameters<DaemonSessionManager['createSessionAsync']>[0];
type Manager = Pick<DaemonSessionManager,'createSessionAsync'|'getSession'|'destroySession'>;
const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
// Exactly the fixed command grammar emitted by the phone launcher. Never append
// a flag to arbitrary shell syntax, a user prompt, or an existing remote command.
const flags = '(?: --model [A-Za-z0-9][A-Za-z0-9._-]{0,100})?(?: -c model_reasoning_effort=(?:none|minimal|low|medium|high|xhigh|max|ultra))?';
const original = new RegExp(`^codex${flags}$`);
export function isPhoneCodexSession(session:{id:string;exec?:{command:string};cmd?:string;wslTarget?:unknown}):boolean {
  return new RegExp(`^web-${uuid}$`, 'i').test(session.id) && !!session.exec && original.test(session.exec.command) && !session.wslTarget && !isWslShell(session.cmd);
}
/** The `--cd` operand for a relay launch. A remote TUI does not send its own cwd,
 * so without --cd a thread runs in the shared app-server's directory. A known
 * absolute spawn directory goes in as a literal: single quotes read the same in
 * POSIX shells, fish and pwsh when the path has no quote or backslash; cmd gets
 * double quotes when nothing in the path expands there. Anything else falls back
 * to the shell's own current directory, which is the spawn directory too. */
export function codexCdOperand(cwd?:string, shell?:string):string {
  const cmd = /(?:^|[\\/])cmd(?:\.exe)?$/i.test(shell ?? '');
  if (cwd && !/[\0-\x1f\x7f]/.test(cwd)) {
    if (cmd && path.win32.isAbsolute(cwd) && !/["%!]/.test(cwd)) return `"${cwd}"`;
    if (!cmd && path.posix.isAbsolute(cwd) && !/['\\\u2018-\u201b]/.test(cwd)) return `'${cwd}'`;
  }
  return cmd ? '"%CD%"' : '"$PWD"';
}
/** Attach relay flags right after `codex` / `codex resume`, ahead of any other
 * argument, so a trailing `--` prompt or a resume target keeps its position. */
export const withCodexRemote = (command:string, url:string, cd:string) =>
  command.replace(/^codex(?: resume)?(?= |$)/, head => `${head} --remote ${url} --cd ${cd}`);
const replay = new RegExp(`^codex(?: resume (?:--last|${uuid}))?${flags}$`, 'i');

/** Rebuild ephemeral relay ownership when replaying a phone-created Codex pane.
 * Persisted exec metadata remains the original command; only this spawn uses the URL. */
export async function recoverCodexPane(manager:Manager, relays:Pick<CodexPaneRelays,'prepare'>,
  params:CreateParams, platform:NodeJS.Platform = process.platform) {
  const command = params.execLaunchCommand ?? params.exec?.command;
  if (platform === 'win32' || isWslShell(params.cmd) || params.wslTarget ||
      !isPhoneCodexSession(params) || !command || !replay.test(command)) {
    return manager.createSessionAsync(params);
  }
  let lease:Awaited<ReturnType<CodexPaneRelays['prepare']>>;
  try {lease = await relays.prepare(params.id,params.env?.CODEX_HOME);}
  catch(error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof CodexRelayUnavailableError) {
      return manager.createSessionAsync(params);
    }
    throw error;
  }
  try {
    if (!/^unix:\/\/\/[A-Za-z0-9_./-]+$/.test(lease.url)) throw new Error('Unsupported Codex relay path');
    const result = await manager.createSessionAsync({...params,execLaunchCommand:withCodexRemote(command,lease.url,codexCdOperand(params.cwd,params.cmd))});
    const owner = manager.getSession(params.id);
    const matchesSpawn = owner?.meta.id === result.id && owner.meta.pid === result.pid &&
      owner.meta.incarnationId === result.incarnationId;
    if (!owner || !matchesSpawn || !lease.commit(owner)) {
      // Do not destroy a replacement installed under a recycled pane ID.
      if (matchesSpawn) manager.destroySession(params.id);
      throw new Error('Recovered Codex pane closed during launch');
    }
    return result;
  } catch(error) {await lease.close();throw error;}
}
