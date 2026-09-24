import { compatibleChatSkills, compatibleCodexSettings } from './chatSkillCompatibility';
import { wrapHandler } from '../wrapHandler';
import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron';
import type { DaemonClient } from '../../DaemonClient';
import type { DaemonEvent } from '../../../shared/rpc';
import { validTerminalLaunchMode } from '../../../shared/transcript/terminalChat';
import { CHAT_IPC } from '../../../shared/transcript/chatIpc';
import type { ChatBridgeApi, TranscriptStatus } from '../../../shared/transcript/turnEvents';

const unavailable: TranscriptStatus = { available: false, reason: 'unavailable' };
const validId = (id: unknown): id is string => typeof id === 'string' && id.length > 0 && id.length < 256;

/** Transcript IPC belongs only to the application renderer, never a webview
 * or the public RPC router. Subscriptions end on reload and handler swaps. */
export function registerChatHandlers(
  client: DaemonClient | undefined,
  getWindow: () => BrowserWindow | null,
): () => void {
  const subscribers = new Map<string, number>();
  let disposed = false;
  let generation = 0;
  let timer: ReturnType<typeof setInterval> | undefined;
  let gatePollInFlight = false;
  let gates = new Set<string>();
  const rpc = async <T>(method: string, params: Record<string, unknown>, fallback: T): Promise<T> => {
    if (disposed || !client?.isConnected) return fallback;
    try { return await (method.startsWith('daemon.chat.') ? client.rpc(method, params, { timeoutMs: 30_000 }) : client.rpc(method, params)) as T; } catch { return fallback; }
  };
  const trusted = (e: IpcMainInvokeEvent) => {
    watchWindow();
    const wc = getWindow()?.webContents;
    return !!wc && !wc.isDestroyed() && e.sender === wc && e.senderFrame === wc.mainFrame;
  };
  const send = (channel: string, ...args: unknown[]) => {
    const wc = getWindow()?.webContents;
    if (!disposed && wc && !wc.isDestroyed()) wc.send(channel, ...args);
  };
  const openGates = async (): Promise<string[] | null> => {
    const result = await rpc<{ pending: { sessionId: string }[] } | null>('daemon.approvals.list', {}, null);
    return result ? [...new Set(result.pending.map((r) => r.sessionId))] : null;
  };
  const pollGates = async () => {
    if (gatePollInFlight || disposed) return;
    const epoch = generation;
    gatePollInFlight = true;
    try {
      const result = await openGates();
      if (disposed || epoch !== generation) return;
      // Unknown is closed to input. Never clear a known gate on a failed RPC.
      const next = new Set(result ?? subscribers.keys());
      for (const id of new Set([...gates, ...next])) {
        if (gates.has(id) !== next.has(id)) send(CHAT_IPC.gate, id, { kind: next.has(id) ? 'open' : 'closed' });
      }
      gates = next;
    } finally { gatePollInFlight = false; }
  };
  const clear = () => {
    generation++;
    for (const id of subscribers.keys()) void rpc('daemon.transcript.unsubscribe', { id }, null);
    subscribers.clear();
    if (timer) clearInterval(timer);
    timer = undefined;
    gates.clear();
  };
  let wc: BrowserWindow['webContents'] | undefined;
  const onNavigation = (event: unknown, _url?: string, _inPlace?: boolean, mainFrame?: boolean) => {
    const isMainFrame = event && typeof event === 'object' && 'isMainFrame' in event ? event.isMainFrame : mainFrame;
    if (isMainFrame) clear();
  };
  const watchWindow = () => {
    const next = getWindow()?.webContents;
    if (next === wc) return;
    wc?.off('did-start-navigation', onNavigation);
    wc?.off('render-process-gone', clear);
    clear();
    wc = next;
    wc?.on('did-start-navigation', onNavigation);
    wc?.on('render-process-gone', clear);
  };
  watchWindow();
  const onEvent = (event: DaemonEvent) => {
    if (event.type === 'transcript.appended' && subscribers.has(event.sessionId)) {
      send(CHAT_IPC.append, event.sessionId, event.data);
    }
  };
  client?.on('event', onEvent);

  const handlers: Record<string, (e: IpcMainInvokeEvent, ...args: any[]) => unknown> = {
    [CHAT_IPC.status]: async (e, id) => {
      if (!trusted(e) || !validId(id)) return unavailable;
      const [status, live] = await Promise.all([
        rpc<TranscriptStatus>('daemon.transcript.status', { id }, unavailable),
        rpc<{ agentName: string | null; agentStatus: NonNullable<TranscriptStatus['agentStatus']> } | null>('daemon.getAgentState', { id }, null),
      ]);
      return { ...(live ? { agentStatus: live.agentStatus, agentAlive: live.agentName === 'Claude Code' } : {}), ...status };
    },
    [CHAT_IPC.snapshot]: (e, id, before) => trusted(e) && validId(id) &&
      (before === undefined || (Number.isSafeInteger(before) && before >= 0))
      ? rpc('daemon.transcript.snapshot', { id, ...(before === undefined ? {} : { before }) }, null) : null,
    [CHAT_IPC.subscribe]: async (e, id) => {
      if (!trusted(e) || !validId(id) || !client?.isConnected) return { ok: false, status: unavailable };
      const epoch = generation;
      subscribers.set(id, (subscribers.get(id) ?? 0) + 1);
      if (!timer) timer = setInterval(() => void pollGates(), 1000);
      void pollGates();
      const response = await rpc('daemon.transcript.subscribe', { id }, { ok: false, status: unavailable });
      if (disposed || epoch !== generation) return { ok: false, status: unavailable };
      return response;
    },
    [CHAT_IPC.unsubscribe]: async (e, id) => {
      if (!trusted(e) || !validId(id)) return { ok: false };
      const count = subscribers.get(id) ?? 0;
      if (count > 1) subscribers.set(id, count - 1);
      else {
        subscribers.delete(id);
        await rpc('daemon.transcript.unsubscribe', { id }, null);
      }
      if (!subscribers.size && timer) { clearInterval(timer); timer = undefined; }
      return { ok: true };
    },
    [CHAT_IPC.codeBlock]: (e, args) => trusted(e) && args && validId(args.ptyId) &&
      Number.isSafeInteger(args.srcOffset) && args.srcOffset >= 0 && Number.isSafeInteger(args.n) && args.n >= 0 &&
      (args.eventId === undefined || typeof args.eventId === 'string')
      ? rpc('daemon.transcript.codeBlock', { id: args.ptyId, srcOffset: args.srcOffset, n: args.n, eventId: args.eventId }, null) : null,
    [CHAT_IPC.openGates]: (e) => trusted(e) ? openGates() : null,
    [CHAT_IPC.send]: (e, args) => trusted(e) && args && validId(args.ptyId) && validId(args.agentSessionId) &&
      typeof args.text === 'string' && args.text.trim() && args.text.length <= 16_000
      ? rpc<Awaited<ReturnType<ChatBridgeApi['send']>>>('daemon.transcript.send', {
        id: args.ptyId, agentSessionId: args.agentSessionId, text: args.text,
        ...(typeof args.requestId === 'string' ? { requestId: args.requestId } : {}),
      }, { result: 'error' }) : { result: 'unavailable' },
  };
  handlers[CHAT_IPC.settings] = async (e, args) => {
    if (!trusted(e) || !args || !validId(args.ptyId) || disposed || !client?.isConnected) return { ok: false, error: 'unavailable' };
    const choice = args.choice;
    if (choice !== undefined && (!choice || !validId(choice.model) || !validId(choice.effort) || !validId(choice.expectedRevision))) return { ok: false, error: 'unavailable' };
    const scopedRpc = (method: string, params: Record<string, unknown>) => {
      if (disposed || !trusted(e)) return Promise.reject(new Error('unavailable'));
      return client.rpc(method, params);
    };
    try { return { ok: true, settings: await compatibleCodexSettings(scopedRpc, args.ptyId, choice) }; }
    catch (error) {
      const reason = error instanceof Error && ['busy', 'stale', 'unconfirmed', 'unsupported-choice'].includes(error.message) ? error.message : 'unavailable';
      return { ok: false, error: reason };
    }
  };
  handlers[CHAT_IPC.skills] = async (e, args) => {
    const empty = { skills: [], state: 'unavailable' };
    if (!trusted(e) || !args || !validId(args.ptyId) || !['claude', 'codex'].includes(args.agent) || disposed || !client?.isConnected) return empty;
    try { return await client.rpc('daemon.chat.skills', { id: args.ptyId, agent: args.agent }, { timeoutMs: 30_000 }); }
    catch (error) {
      if (!(error instanceof Error) || !error.message.includes('Unknown method: daemon.chat.skills')) return empty;
      const result = await compatibleChatSkills((method, params) => client.rpc(method, params), args.ptyId, args.agent);
      return !disposed && trusted(e) ? result : empty;
    }
  };
  handlers[CHAT_IPC.launchTerminal] = (e, args) => trusted(e) && args && validId(args.ptyId) && ['claude', 'codex'].includes(args.agent) && typeof args.prompt === 'string' && args.prompt.trim() && args.prompt.length <= 2000 && validTerminalLaunchMode(args.agent, args.mode)
    ? rpc('daemon.chat.launchTerminal', { id: args.ptyId, agent: args.agent, prompt: args.prompt, ...(args.mode === undefined ? {} : { mode: args.mode }) }, { ok: false, error: 'Launch could not be confirmed. Check Terminal before retrying.' })
    : { ok: false, error: 'Invalid terminal launch' };
  handlers[CHAT_IPC.providers] = (e) => trusted(e) ? rpc('daemon.chat.providers', {}, []) : [];
  for (const action of ['start', 'reconnect', 'cancel', 'respond', 'close'] as const) {
    handlers[CHAT_IPC[action]] = (e, args) => {
      if (!trusted(e) || !args || !validId(args.ptyId)) return { ok: false, error: 'Unavailable' };
      if (action === 'start' ? !validId(args.providerId) : !validId(args.agentSessionId)) return { ok: false, error: 'Invalid session' };
      if (action === 'respond' && (!validId(args.requestId) || !args.answer || JSON.stringify(args.answer).length > 32_000)) return { ok: false, error: 'Invalid response' };
      return rpc(`daemon.chat.${action}`, { id: args.ptyId, providerId: args.providerId,
        agentSessionId: args.agentSessionId, requestId: args.requestId, answer: args.answer }, { ok: false, error: 'Chat service unavailable' });
    };
  }
  for (const [channel, handler] of Object.entries(handlers)) {
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, wrapHandler(channel, handler));
  }
  return () => {
    clear();
    disposed = true;
    client?.off('event', onEvent);
    wc?.off('did-start-navigation', onNavigation);
    wc?.off('render-process-gone', clear);
    for (const channel of Object.keys(handlers)) ipcMain.removeHandler(channel);
  };
}
