import { isPhoneWorkspaceId } from '../../shared/phoneWorkspaceRequests';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { BrowserWindow } from 'electron';
import { sendToRenderer } from '../pipe/handlers/_bridge';
import { parsePhoneSidebarSnapshot, type PhoneSidebarSnapshot } from '../../shared/phoneFleetSidebar';

/** How long the list waits for the optional sidebar projection. */
const PHONE_SIDEBAR_RENDERER_TIMEOUT_MS = 1500;
/**
 * Serialized reply budget. The daemon's desktop bridge refuses a reply over
 * 128 KiB (see DesktopPhoneBridge); this leaves room for the envelope.
 */
export const PHONE_WORKSPACES_REPLY_BUDGET_BYTES = 112 * 1024;

/** Named workspace operations only; never forward an arbitrary phone RPC. */
export async function handlePhoneWorkspaces(command: string, payload: Record<string, unknown>, getWindow: () => BrowserWindow | null): Promise<unknown> {
  if (command === 'workspaces.list') {
    // The sidebar projection rides along, fetched in parallel and optional: a
    // failure or a slow renderer omits it and the list answers as before.
    const [rows, sidebarRaw] = await Promise.all([
      sendToRenderer(getWindow, 'workspace.list'),
      sendToRenderer(getWindow, 'workspace.phoneSidebar', {}, { timeoutMs: PHONE_SIDEBAR_RENDERER_TIMEOUT_MS }).catch(() => null),
    ]);
    if (!Array.isArray(rows)) throw new Error('Workspace list unavailable');
    const reply: { workspaces: Array<{ id: string; name: string; sessionId: string | null }>; sidebar?: PhoneSidebarSnapshot } = {
      workspaces: rows.filter(row => row && typeof row.id === 'string' && typeof row.name === 'string').map(row => ({
        id: row.id, name: row.name, sessionId: typeof row.activePtyId === 'string' ? row.activePtyId : null,
      })),
    };
    const sidebar = parsePhoneSidebarSnapshot(sidebarRaw);
    if (sidebar) {
      reply.sidebar = sidebar;
      // The daemon drops a reply over its per-request byte cap without
      // answering, which would turn every list call into a timeout. Past the
      // budget the optional part goes, never the list.
      if (Buffer.byteLength(JSON.stringify(reply)) > PHONE_WORKSPACES_REPLY_BUDGET_BYTES) delete reply.sidebar;
    }
    return reply;
  }
  if (command !== 'workspaces.create') throw new Error('Unsupported workspace operation');
  if (typeof payload.requestId !== 'string' || !isPhoneWorkspaceId(`ws-phone-${payload.requestId.toLowerCase()}`) ||
      // eslint-disable-next-line no-control-regex
      typeof payload.name !== 'string' || !payload.name.trim() || payload.name.length > 100 || /[\u0000-\u001f]/.test(payload.name)) throw new Error('Invalid workspace request');
  let cwd: string | undefined;
  if (payload.cwd !== undefined) {
    if (typeof payload.cwd !== 'string' || payload.cwd.length > 4096 || !path.isAbsolute(payload.cwd) || payload.cwd.includes('\0')) throw new Error('Invalid workspace directory');
    cwd = await fs.realpath(payload.cwd);
    if (!(await fs.stat(cwd)).isDirectory()) throw new Error('Workspace directory is not a folder');
  }
  const result = await sendToRenderer(getWindow, 'workspace.phoneCreate', {
    id: `ws-phone-${payload.requestId.toLowerCase()}`, name: payload.name.trim(), ...(cwd ? { cwd } : {}),
  });
  if (result && typeof result === 'object' && 'error' in result &&
      ['workspace-request-closed','workspace-request-history-full'].includes(String(result.error))) return {error:result.error};
  if (!result || typeof result !== 'object' || !('id' in result) || typeof result.id !== 'string') throw new Error('Workspace creation unconfirmed');
  return result;
}
