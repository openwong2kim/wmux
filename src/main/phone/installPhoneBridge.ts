import type { DaemonClient } from '../DaemonClient';
import type { DaemonEvent } from '../../shared/rpc';
import { DESKTOP_ACCOUNT_ENV_COMMAND } from '../../shared/phonePaneAccount';
import { MOA_WAKE_COMMAND } from '../../shared/moaWake';

export function installPhoneBridge(client: DaemonClient, handle: (command: string, payload: Record<string,unknown>) => Promise<unknown>): () => void {
  let active = true;
  const seen = new Set<string>();
  const listener = (event: DaemonEvent) => {
    if (!active || event.type !== 'phone.request') return;
    const data = event.data as {requestId?:unknown;command?:unknown;payload?:unknown;expiresAt?:unknown};
    if (!data || typeof data.requestId !== 'string' || typeof data.command !== 'string' ||
        typeof data.expiresAt !== 'number' || !Number.isFinite(data.expiresAt) || data.expiresAt <= Date.now() ||
        !data.payload || typeof data.payload !== 'object' || Array.isArray(data.payload) || seen.has(data.requestId)) return;
    const requestId = data.requestId;
    seen.add(requestId);
    if (seen.size > 1024) seen.delete(seen.values().next().value!);
    void handle(data.command,data.payload as Record<string,unknown>).then(
      result => client.rpc('daemon.phone.complete',{requestId,ok:true,result}),
      () => client.rpc('daemon.phone.complete',{requestId,ok:false}),
    ).catch(() => { /* Caller observes timeout/disconnect; never retry a write. */ });
  };
  client.on('event',listener);
  // Announce the optional commands this desktop handles; a daemon that predates
  // the announcement ignores the params.
  void client.rpc('daemon.phone.register',{commands:[DESKTOP_ACCOUNT_ENV_COMMAND,MOA_WAKE_COMMAND]}).catch(() => { /* Older daemon: no capability. */ });
  return () => { active = false; client.off('event',listener); };
}
