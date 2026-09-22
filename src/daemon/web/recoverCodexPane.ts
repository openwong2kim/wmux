import type {DaemonSessionManager} from '../DaemonSessionManager';
import type {CodexPaneRelays} from './codexPaneRelays';
import {CodexRelayUnavailableError} from './codexTuiRelay';
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
    const result = await manager.createSessionAsync({...params,execLaunchCommand:`${command} --remote ${lease.url}`});
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
