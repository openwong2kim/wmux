// Main keeps each daemon security notice until the renderer acknowledges it,
// and tells every live window about a new one.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { SecurityNotice } from '../../../shared/securityNotice';

type Handler = (event: unknown, ...args: unknown[]) => Promise<unknown>;
const { handlers, windows } = vi.hoisted(() => ({
  handlers: new Map<string, Handler>(),
  windows: [] as Array<{ isDestroyed: () => boolean; webContents: { isDestroyed: () => boolean; send: (...args: unknown[]) => void } }>,
}));

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => windows },
  ipcMain: {
    handle: (channel: string, fn: Handler) => { handlers.set(channel, fn); },
    removeHandler: (channel: string) => { handlers.delete(channel); },
  },
}));

function fakeWindow(destroyed = false, contentsDestroyed = false) {
  return { isDestroyed: () => destroyed, webContents: { isDestroyed: () => contentsDestroyed, send: vi.fn() } };
}

async function load() {
  vi.resetModules();
  const mod = await import('../securityNotices');
  mod.registerSecurityNoticeHandlers();
  const invoke = (channel: string, ...args: unknown[]) => {
    const handler = handlers.get(channel);
    if (!handler) throw new Error(`no handler for ${channel}`);
    return handler({}, ...args);
  };
  const list = () => invoke('security-notice:list') as Promise<SecurityNotice[]>;
  const acknowledge = (id: unknown) => invoke('security-notice:acknowledge', id);
  return { record: mod.recordSecurityNotice, list, acknowledge };
}

describe('securityNotices', () => {
  beforeEach(() => { handlers.clear(); windows.length = 0; });

  it('lists recorded notices oldest first and sends each to every live window', async () => {
    const live = fakeWindow();
    const closed = fakeWindow(true);
    const closedContents = fakeWindow(false, true);
    windows.push(live, closed, closedContents);
    const { record, list } = await load();
    record({ title: 'Phone launch', body: 'Codex started with approvals off', ptyId: 'pty-a' });
    record({ title: 'wmux', body: 'second', ptyId: null });
    const notices = await list();
    expect(notices.map((n) => [n.title, n.body, n.ptyId])).toEqual([
      ['Phone launch', 'Codex started with approvals off', 'pty-a'],
      ['wmux', 'second', null],
    ]);
    expect(notices[0].id).not.toBe(notices[1].id);
    expect(typeof notices[0].timestamp).toBe('number');
    expect(live.webContents.send).toHaveBeenCalledTimes(2);
    expect(live.webContents.send).toHaveBeenNthCalledWith(1, 'security-notice:added', notices[0]);
    expect(closed.webContents.send).not.toHaveBeenCalled();
    expect(closedContents.webContents.send).not.toHaveBeenCalled();
  });

  it('keeps the notice and reaches the other windows when one send throws', async () => {
    const broken = fakeWindow();
    broken.webContents.send.mockImplementation(() => { throw new Error('frame disposed'); });
    const live = fakeWindow();
    windows.push(broken, live);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => { /* expected */ });
    const { record, list } = await load();
    expect(() => record({ title: 'Phone launch', body: 'x', ptyId: null })).not.toThrow();
    const notices = await list();
    expect(notices.map((n) => n.title)).toEqual(['Phone launch']);
    expect(live.webContents.send).toHaveBeenCalledWith('security-notice:added', notices[0]);
    warn.mockRestore();
  });

  it('forgets an acknowledged notice and ignores an unknown or non-string id', async () => {
    const { record, list, acknowledge } = await load();
    record({ title: 'a', body: 'a', ptyId: null });
    record({ title: 'b', body: 'b', ptyId: null });
    const [first] = await list();
    await acknowledge('no-such-id');
    await acknowledge(42);
    await acknowledge(undefined);
    expect(await list()).toHaveLength(2);
    await acknowledge(first.id);
    expect((await list()).map((n) => n.title)).toEqual(['b']);
  });

  it('keeps at most 50 notices, dropping the oldest', async () => {
    const { record, list } = await load();
    for (let i = 0; i < 52; i++) record({ title: `n${i}`, body: 'x', ptyId: null });
    const notices = await list();
    expect(notices).toHaveLength(50);
    expect(notices[0].title).toBe('n2');
    expect(notices[49].title).toBe('n51');
  });
});
