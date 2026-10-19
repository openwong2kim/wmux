// The production module list starts the fact log and the bot runtime before
// the trigger engine, the rooms and the handoffs that resolve them as ports.
import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { getPath: () => '/tmp', isPackaged: false, on: vi.fn() }, ipcMain: { handle: vi.fn(), removeHandler: vi.fn(), on: vi.fn() }, BrowserWindow: class {} }));

describe('factory module order', () => {
  it('registers the secret store first (its redaction covers every later write), the connection library, then facts and the bot runtime, the triggers and the wiring, then the taint marks, rooms, the group chats (after the rooms they read), handoffs, roles, the merge lane, approvals, the skills (their cards are approvals), the routines, the worker resume and the worker message', async () => {
    const { registeredFactoryModules } = await import('../factoryHost');
    await import('../modules');
    expect(registeredFactoryModules()).toEqual(['secrets', 'connectors', 'facts', 'bot-runtime', 'triggerEngine', 'wiring', 'wakeTaint', 'rooms', 'groups', 'handoffs', 'roles', 'mergeLane', 'approvals', 'skills', 'routines', 'worker-resume', 'worker-message']);
  });
});
