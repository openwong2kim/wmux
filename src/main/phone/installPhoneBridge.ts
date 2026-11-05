import type { DaemonClient } from '../DaemonClient';
import type { DaemonEvent } from '../../shared/rpc';
import { DESKTOP_ACCOUNT_ENV_COMMAND } from '../../shared/phonePaneAccount';
import { FACTORY_PHONE_MESSAGE_CAPABILITY, FACTORY_THREAD_ATTACHMENTS_CAPABILITY, FACTORY_THREAD_MESSAGE_CAPABILITY, MOA_WAKE_COMMAND } from '../../shared/moaWake';
import { FLEET_TICKET_DETAIL_COMMAND } from '../../shared/phoneFleetTickets';
import { PHONE_ROOM_ATTACHMENT_COMMAND, PHONE_ROOM_CARDS_COMMAND, PHONE_ROOM_FILE_COMMAND, PHONE_ROOM_THREADS_COMMAND } from '../../shared/phoneRooms';
import { PHONE_BOTS_COMMAND } from '../../shared/phoneBots';
import { GUEST_ROOM_CARDS_COMMAND, GUEST_ROOM_POST_COMMAND } from '../../shared/guestBots';
import { PHONE_BOT_APPROVAL_COMMAND, PHONE_BOT_APPROVAL_DECIDE_COMMAND } from '../../shared/phoneBotApprovals';
import { PHONE_WORKER_RESUME_COMMAND } from '../../shared/phoneWorkerResume';
import { BROWSER_HELP_CAPABILITY, PHONE_BROWSER_HELP_DECIDE_COMMAND } from '../../shared/phoneBrowserHelp';
import { BROWSER_CHROME_PREVIEW_CAPABILITY, BROWSER_STREAM_CAPABILITY } from '../../shared/phoneBrowserPreview';
import type { PhoneBrowserStreams } from './PhoneBrowserStream';
import { AGENT_ENV_COMMAND } from '../../shared/agentEnvSummary';

/**
 * `streams`: the phone browser stream's manager for this connection, when the
 * stream is on. It takes the `browser.stream*` commands, the desktop then
 * announces BROWSER_STREAM_CAPABILITY, and every screencast stops when the
 * daemon connection drops or the bridge is disposed.
 */
export function installPhoneBridge(client: DaemonClient, handle: (command: string, payload: Record<string,unknown>) => Promise<unknown>, streams: PhoneBrowserStreams | null = null): () => void {
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
    // A handler that throws synchronously is a failed request, never an
    // exception out of this event listener.
    let pending: Promise<unknown>;
    try {
      pending = streams && data.command.startsWith('browser.stream')
        ? streams.handle(data.command,data.payload as Record<string,unknown>)
        : handle(data.command,data.payload as Record<string,unknown>);
    }
    catch (err) { pending = Promise.reject(err); }
    void pending.then(
      result => client.rpc('daemon.phone.complete',{requestId,ok:true,result}),
      () => client.rpc('daemon.phone.complete',{requestId,ok:false}),
    ).catch(() => { /* Caller observes timeout/disconnect; never retry a write. */ });
  };
  client.on('event',listener);
  const stopStreams = () => streams?.stopAll();
  client.on('disconnected',stopStreams);
  // Announce the optional commands this desktop handles; a daemon that predates
  // the announcement ignores the params.
  void client.rpc('daemon.phone.register',{commands:[DESKTOP_ACCOUNT_ENV_COMMAND,MOA_WAKE_COMMAND,FACTORY_PHONE_MESSAGE_CAPABILITY,FLEET_TICKET_DETAIL_COMMAND,PHONE_ROOM_THREADS_COMMAND,PHONE_ROOM_CARDS_COMMAND,PHONE_BOT_APPROVAL_COMMAND,PHONE_BOT_APPROVAL_DECIDE_COMMAND,PHONE_BOTS_COMMAND,FACTORY_THREAD_MESSAGE_CAPABILITY,FACTORY_THREAD_ATTACHMENTS_CAPABILITY,PHONE_ROOM_ATTACHMENT_COMMAND,PHONE_ROOM_FILE_COMMAND,PHONE_WORKER_RESUME_COMMAND,GUEST_ROOM_POST_COMMAND,GUEST_ROOM_CARDS_COMMAND,BROWSER_HELP_CAPABILITY,PHONE_BROWSER_HELP_DECIDE_COMMAND,BROWSER_CHROME_PREVIEW_CAPABILITY,AGENT_ENV_COMMAND,...(streams ? [BROWSER_STREAM_CAPABILITY] : [])]}).catch(() => { /* Older daemon: no capability. */ });
  return () => { active = false; client.off('event',listener); client.off('disconnected',stopStreams); stopStreams(); };
}
