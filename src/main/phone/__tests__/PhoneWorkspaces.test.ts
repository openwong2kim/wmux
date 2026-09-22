import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const send = vi.hoisted(() => vi.fn());
vi.mock('../../pipe/handlers/_bridge', () => ({ sendToRenderer: send }));
import { handlePhoneWorkspaces } from '../PhoneWorkspaces';
let directory: string;
const requestId = '01234567-89ab-4cde-8123-456789abcdef';
beforeEach(() => { send.mockReset(); directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-phone-workspace-')); });
afterEach(() => fs.rmSync(directory, { recursive: true, force: true }));
describe('phone workspace bridge', () => {
  it('validates the folder and forwards only the fixed creation operation', async () => {
    send.mockResolvedValue({ id: `ws-phone-${requestId}`, name: 'Project' });
    const getWindow = () => null;
    await handlePhoneWorkspaces('workspaces.create', { requestId, name: ' Project ', cwd: directory, command: 'rm -rf /', env: { SECRET: 'bad' } }, getWindow);
    expect(send).toHaveBeenCalledWith(getWindow, 'workspace.phoneCreate', { id: `ws-phone-${requestId}`, name: 'Project', cwd: await fs.promises.realpath(directory) });
  });
  it('refuses nonexistent or relative folders before creation', async () => {
    for (const cwd of ['relative', path.join(directory, 'missing')]) {
      await expect(handlePhoneWorkspaces('workspaces.create', { requestId, name: 'Project', cwd }, () => null)).rejects.toThrow();
    }
    expect(send).not.toHaveBeenCalled();
  });
  it('preserves only named creation refusals for phone recovery', async () => {
    for (const error of ['workspace-request-closed', 'workspace-request-history-full']) {
      send.mockResolvedValue({error,secret:'not forwarded'});
      expect(await handlePhoneWorkspaces('workspaces.create', {requestId,name:'Project'}, () => null)).toEqual({error});
    }
  });
  it('does not interpret renderer startup errors as a created workspace', async () => {
    send.mockResolvedValue({ error: 'still starting' });
    await expect(handlePhoneWorkspaces('workspaces.create', { requestId, name: 'Project' }, () => null)).rejects.toThrow('unconfirmed');
  });
  it('limits list responses to workspace identity and active session', async () => {
    send.mockResolvedValue([{ id: 'ws-1', name: 'One', activePtyId: 's1', metadata: { cwd: '/private' }, hidden: 'secret' }]);
    expect(await handlePhoneWorkspaces('workspaces.list', {}, () => null)).toEqual({ workspaces: [{ id: 'ws-1', name: 'One', sessionId: 's1' }] });
  });
  it('does not dispatch arbitrary operations', async () => {
    await expect(handlePhoneWorkspaces('workspace.close', {}, () => null)).rejects.toThrow('Unsupported');
    expect(send).not.toHaveBeenCalled();
  });
});
