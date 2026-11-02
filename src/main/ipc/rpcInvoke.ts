// The renderer's RPC bridge (`rpc:invoke`): the main window asks main to
// dispatch one pipe RPC as the operator. It answers only the main window's
// top frame (mainWindowSender.ts); any other sender gets a refusal and
// nothing is dispatched.
//
// It also dispatches only the methods the window itself calls
// (RENDERER_RPC_METHODS). Every other pipe method is refused here; a window
// action with lasting effect (keys, connectors, approvals, browser policy,
// folder trust) has its own IPC channel instead.

import type { BrowserWindow } from 'electron';
import { isMainWindowSender } from './mainWindowSender';

export type RendererRpcInvoke = (method: string, params: Record<string, unknown>) => Promise<unknown>;

export const RPC_INVOKE_NOT_MAIN_WINDOW = { ok: false, error: 'rpc:invoke: only the main window may call it' } as const;

/** Every method the renderer sends through `rpc:invoke`, and nothing else.
 *  A new renderer call adds its method here; rpcInvokeAllowlist.test.ts
 *  checks the renderer's call sites against this list. */
export const RENDERER_RPC_METHODS: readonly string[] = Object.freeze([
  // Event feed and channel reads (useRpcBridge, useChannelsHydration, DiffPanel).
  'events.poll',
  'a2a.channel.list',
  'a2a.channel.get',
  'a2a.channel.getMessages',
  'a2a.channel.getMembers',
  // Missions (useRpcBridge __wmuxMissionRpc.list, DiffPanel).
  'task.mission.list',
  // Agent tasks (AgentMentionPicker, FleetView TicketList).
  'a2a.task.send',
  'a2a.task.query',
  // Bots (preload factoryBotCall, routine list).
  'bot.wake',
  'bot.park',
  'bot.resume',
  'bot.interrupt',
  'bot.update',
  'bot.remove',
  'routine.list',
]);

const allowed: ReadonlySet<string> = new Set(RENDERER_RPC_METHODS);

/** Longest method name accepted; every listed method is far shorter. */
const MAX_METHOD_LEN = 120;
/** How many distinct refused names are remembered for logging once. */
const MAX_LOGGED_REFUSALS = 256;
const loggedRefusals = new Set<string>();

export function createRpcInvokeHandler(
  getWindow: () => BrowserWindow | null,
  invoke: () => RendererRpcInvoke | undefined,
): (event: { sender?: unknown; senderFrame?: unknown }, method: unknown, params: unknown) => Promise<unknown> {
  return async (event, method, params) => {
    if (!isMainWindowSender(event, getWindow())) return RPC_INVOKE_NOT_MAIN_WINDOW;
    if (typeof method !== 'string' || method.length === 0) {
      return { ok: false, error: 'rpc:invoke: missing method' };
    }
    if (method.length > MAX_METHOD_LEN) {
      return { ok: false, error: 'rpc:invoke: method name too long' };
    }
    if (!allowed.has(method)) {
      if (!loggedRefusals.has(method) && loggedRefusals.size < MAX_LOGGED_REFUSALS) {
        loggedRefusals.add(method);
        console.warn(`[rpc:invoke] method not allowed: ${method}`);
      }
      return { ok: false, error: `rpc:invoke: method not allowed: ${method}` };
    }
    // An object-typed params is required (the router validates this too).
    const safeParams =
      params !== undefined && params !== null && typeof params === 'object'
        ? (params as Record<string, unknown>)
        : {};
    const run = invoke();
    if (!run) return { ok: false, error: 'rpc:invoke: renderer RPC bridge not wired' };
    return run(method, safeParams);
  };
}
