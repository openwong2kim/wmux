// ─── handOut.list / handOut.add — the To hand out list for agent panes ──────
//
// An agent in a pane (MCP `hand_out`) reads the list and adds to it; it picks
// an item with a2a.task.send and a `handOutId` (a2a.rpc.ts). Local origin
// only. Identity is server-resolved, never taken from params: the caller's
// senderPtyId resolves to its workspace and pane. A bot, a commander brain, a
// plugin and a caller with no resolvable pane are refused. The app (the
// operator lane) may read the list. Every refusal has one shape,
// `{ok: false, code, message}`, with the codes the add and the pick use.

import type { BrowserWindow } from 'electron';
import type { RpcRouter } from '../RpcRouter';
import { isHostedCaller, type RpcContext } from '../../../shared/rpc';
import { HUMAN_WORKSPACE_ID } from '../../../shared/channels';
import {
  HAND_OUT_LIMITS,
  folderWithin,
  isHandOutId,
  parseHandOutAdd,
  type HandOutAddResult,
  type HandOutEntry,
} from '../../../shared/handOut';
import { getHandOutStore, type HandOutStore } from '../../handOut/handOutStore';
import { refuseHandoffMarker } from '../handoffMarkerTripwire';
import { resolvePtyOwnerWorkspace } from '../../workspace/ptyOwnership';
import { sendToRenderer } from './_bridge';

type GetWindow = () => BrowserWindow | null;

/** The pane a senderPtyId resolves to, with its name as its header shows it. */
export interface HandOutCaller {
  workspaceId: string;
  paneId: string;
  name?: string;
}

export interface HandOutRpcDeps {
  /** Injected in tests; default the process-wide list. */
  store?: Pick<HandOutStore, 'list' | 'get' | 'add'>;
  /** Injected in tests; default the mirror and one pane.list read. */
  resolveCaller?: (senderPtyId: string) => Promise<HandOutCaller | null>;
}

type Denial = { ok: false; code: 'refused' | 'invalid'; message: string };

function deny(code: Denial['code'], message: string): Denial {
  return { ok: false, code, message };
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** The caller's workspace from its pty, then its pane (and name) from one read of that workspace's panes. */
async function resolveCallerPane(getWindow: GetWindow, ptyId: string): Promise<HandOutCaller | null> {
  try {
    const workspaceId = await resolvePtyOwnerWorkspace(getWindow, ptyId);
    if (!workspaceId) return null;
    const panes = await sendToRenderer(getWindow, 'pane.list', { workspaceId, includeStashed: true });
    if (!Array.isArray(panes)) return null;
    for (const pane of panes) {
      if (!isRecord(pane) || typeof pane.id !== 'string' || !Array.isArray(pane.surfacePtyIds)) continue;
      if (!pane.surfacePtyIds.includes(ptyId)) continue;
      const name = typeof pane.paneName === 'string' ? pane.paneName.trim() : '';
      return { workspaceId, paneId: pane.id, ...(name ? { name } : {}) };
    }
    return null;
  } catch {
    // Renderer unavailable (early boot / reload): unresolvable, fail closed.
    return null;
  }
}

export function registerHandOutRpc(router: RpcRouter, getWindow: GetWindow, deps: HandOutRpcDeps = {}): void {
  const storeOf = () => deps.store ?? getHandOutStore();
  const resolveCaller = deps.resolveCaller ?? ((ptyId: string) => resolveCallerPane(getWindow, ptyId));

  /** The agent pane making the call, or why it may not. */
  async function callerOf(method: string, params: Record<string, unknown>, ctx: RpcContext | undefined): Promise<HandOutCaller | Denial> {
    if (ctx?.origin !== 'local') return deny('refused', `${method} is local-origin only`);
    if (ctx.commanderWorkspace || ctx.bot || isHostedCaller(ctx)) {
      return deny('refused', `${method} is for an agent in a pane; a bot, Moa or a plugin has none`);
    }
    const senderPtyId = typeof params.senderPtyId === 'string' ? params.senderPtyId.trim() : '';
    const caller = senderPtyId ? await resolveCaller(senderPtyId) : null;
    if (!caller) return deny('refused', `${method} requires a verifiable caller (no resolvable senderPtyId)`);
    if (caller.workspaceId === HUMAN_WORKSPACE_ID) return deny('refused', `'${HUMAN_WORKSPACE_ID}' cannot call ${method} from the pipe`);
    return caller;
  }

  router.register('handOut.list', async (params, ctx): Promise<{ items: HandOutEntry[]; total: number } | Denial> => {
    if (ctx?.operator !== true) {
      const caller = await callerOf('handOut.list', params, ctx);
      if ('ok' in caller) return caller;
    }
    const store = storeOf();
    const { id, folder } = params;
    if (id !== undefined) {
      if (!isHandOutId(id)) return deny('invalid', 'handOut.list: id is not an item id');
      const item = store.get(id);
      return { items: item ? [item] : [], total: item ? 1 : 0 };
    }
    let within: string | undefined;
    if (folder !== undefined) {
      if (typeof folder !== 'string' || !folder.trim() || folder.length > HAND_OUT_LIMITS.MAX_FOLDER || folder.includes('\0')) {
        return deny('invalid', 'handOut.list: folder must be a path');
      }
      within = folder;
    }
    const open = store.list()
      .filter((item) => item.state === 'open' && (within === undefined || folderWithin(item.folder, within)));
    // `total` says how many matched, so a caller knows the list was cut.
    return { items: open.slice(0, HAND_OUT_LIMITS.MAX_LISTED), total: open.length };
  });

  router.register('handOut.add', async (params, ctx): Promise<HandOutAddResult | Denial> => {
    const caller = await callerOf('handOut.add', params, ctx);
    if ('ok' in caller) return caller;
    // The app's pick sends an item on the operator lane, so an agent's item
    // may not carry the line only an operator's hand-off writes.
    const marked = refuseHandoffMarker('handOut.add', [params.title, params.note, params.folder], ctx);
    if (marked) return deny('refused', marked.error);
    const req = parseHandOutAdd(params);
    if (!req) {
      return { ok: false, code: 'invalid', message: 'handOut.add needs a one-line title and an absolute folder; agent is an agent slug such as claude' };
    }
    return storeOf().add(req, {
      kind: 'pane',
      workspaceId: caller.workspaceId,
      paneId: caller.paneId,
      ...(caller.name ? { name: caller.name } : {}),
    });
  });
}
