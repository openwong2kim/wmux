import { isPhoneWorkspaceId } from '../../shared/phoneWorkspaceRequests';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { BrowserWindow } from 'electron';
import { sendToRenderer } from '../pipe/handlers/_bridge';

/** Named workspace operations only; never forward an arbitrary phone RPC. */
export async function handlePhoneWorkspaces(command: string, payload: Record<string, unknown>, getWindow: () => BrowserWindow | null): Promise<unknown> {
  if (command === 'workspaces.list') {
    const rows = await sendToRenderer(getWindow, 'workspace.list');
    if (!Array.isArray(rows)) throw new Error('Workspace list unavailable');
    return { workspaces: rows.filter(row => row && typeof row.id === 'string' && typeof row.name === 'string').map(row => ({
      id: row.id, name: row.name, sessionId: typeof row.activePtyId === 'string' ? row.activePtyId : null,
    })) };
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
