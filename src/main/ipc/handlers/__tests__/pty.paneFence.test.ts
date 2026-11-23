// A person's pane in the worker fence through pty:create, pty:write-launch
// and paneFence:set (main/agents/paneFence.ts does the fencing; mocked here).
import { describe, it, expect, vi, beforeEach } from 'vitest';

const captured = new Map<string, (...args: unknown[]) => unknown>();
vi.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => '/repo', getPath: () => '/home', on: () => undefined },
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => { captured.set(channel, fn); },
    removeHandler: (channel: string) => { captured.delete(channel); },
    on: () => undefined,
    removeListener: () => undefined,
    removeAllListeners: () => undefined,
  },
  BrowserWindow: { getAllWindows: () => [] },
  safeStorage: {},
}));

const fence = vi.hoisted(() => ({
  calls: [] as Array<{ line: string; cwd: string | undefined }>,
  refuse: null as string | null,
  sessions: new Map<string, { on: boolean }>(),
  noted: [] as string[],
}));
vi.mock('../../../agents/paneFence', () => ({
  paneFenceLaunch: (line: string, cwd: string | undefined) => {
    fence.calls.push({ line, cwd });
    if (fence.refuse) throw new Error(`worker fence: ${fence.refuse}`);
    return /^claude/.test(line) ? { line: `/opt/claude --setting-sources=project --settings="/d/f.json"${line.slice('claude'.length)}`, record: { cwd: cwd ?? '', settingsFile: '/d/f.json' } } : null;
  },
  paneFenceCwdRefusal: () => null,
  paneLineStartsAgent: (line: string) => /^(claude|codex|gemini)\b/.test(line),
}));
vi.mock('../../../agents/paneFenceSessions', () => ({
  getPaneFenceSession: (id: string) => fence.sessions.get(id) ?? null,
  notePaneFenceLaunch: (id: string) => { fence.noted.push(id); fence.sessions.set(id, { on: true }); },
  setPaneFenceOn: (id: string, on: boolean) => { fence.sessions.set(id, { on }); return on; },
}));
vi.mock('../../../agents/botWorkerFence', async (orig) => ({
  ...(await orig<typeof import('../../../agents/botWorkerFence')>()),
  workerFenceSupport: async () => ({ capable: true, exe: '/opt/claude', version: '2.1.316', selfTest: { ok: true } }),
}));

import { registerPTYHandlers } from '../pty.handler';
import { IPC } from '../../../../shared/constants';
import type { PTYManager } from '../../../pty/PTYManager';
import type { PTYBridge } from '../../../pty/PTYBridge';

beforeEach(() => {
  fence.calls = [];
  fence.refuse = null;
  fence.sessions.clear();
  fence.noted = [];
});

async function createLocal(options: Record<string, unknown>): Promise<{ result: unknown; written: string[] }> {
  const written: string[] = [];
  const onData: Array<() => void> = [];
  const ptyManager = {
    createAsync: async () => ({
      id: 'pty-c', cwd: '/tmp', shell: '/bin/zsh',
      process: { onData: (fn: () => void) => { onData.push(fn); return { dispose: () => undefined }; } },
    }),
    write: (_id: string, data: string) => { written.push(data); },
  } as unknown as PTYManager;
  const dispose = registerPTYHandlers(ptyManager, { setupDataForwarding: () => undefined } as unknown as PTYBridge);
  try {
    const create = captured.get(IPC.PTY_CREATE)!;
    const result = await create({}, { shell: '/bin/zsh', cwd: '/tmp', ignoreAccountBinding: true, ...options });
    for (const fn of onData) fn();
    if (typeof options.initialCommand === 'string') await vi.waitFor(() => expect(written.length).toBeGreaterThan(0), { timeout: 5_000 });
    return { result, written };
  } finally {
    dispose();
  }
}

describe('pty:create in an opted-in pane', () => {
  it('types the fenced line, records the session and says so', async () => {
    const { result, written } = await createLocal({ initialCommand: 'claude --dangerously-skip-permissions', workerFence: true });
    expect(fence.calls).toEqual([{ line: 'claude --dangerously-skip-permissions', cwd: '/tmp' }]);
    // The session pin still lands on the fenced claude.
    expect(written[0]).toMatch(/^\/opt\/claude --session-id [0-9a-f-]{36} --setting-sources=project --settings="\/d\/f\.json" --dangerously-skip-permissions\r$/);
    expect(fence.noted).toEqual(['pty-c']);
    expect(result).toMatchObject({ id: 'pty-c', fence: { on: true, launched: true } });
  });

  it('a dead pane\'s respawn is fenced in the folder it comes back in', async () => {
    const folder = process.cwd();
    await createLocal({ cwd: undefined, recoveryCwds: { cwd: folder, spawnCwd: folder }, initialCommand: 'claude', workerFence: true });
    expect(fence.calls).toEqual([{ line: 'claude', cwd: folder }]);
  });

  it('a plain shell still turns the session on for its next launch', async () => {
    const { result } = await createLocal({ workerFence: true });
    expect(fence.sessions.get('pty-c')).toEqual({ on: true });
    expect(result).toMatchObject({ fence: { on: true, launched: false } });
  });

  it('fails the create with the fence\'s reason, typing nothing', async () => {
    fence.refuse = 'the worker fence runs Claude Code only for now';
    await expect(createLocal({ initialCommand: 'codex', workerFence: true })).rejects.toThrow('PTY_CREATE: worker fence: the worker fence runs Claude Code only for now');
  });

  it('refuses a supervised agent unit, which the fence cannot be attached to', async () => {
    await expect(createLocal({ exec: 'claude', supervision: { restart: 'always' }, workerFence: true })).rejects.toThrow('PTY_CREATE: worker fence: a supervised agent unit cannot run inside the fence yet');
  });

  it('a create without the flag is as before', async () => {
    const { result, written } = await createLocal({ initialCommand: 'claude' });
    expect(fence.calls).toEqual([]);
    expect(written[0]).toMatch(/^claude --session-id [0-9a-f-]{36}\r$/);
    expect(result).not.toHaveProperty('fence');
    expect(fence.sessions.size).toBe(0);
  });
});

describe('pty:write-launch and paneFence:set', () => {
  async function writeLaunch(text: string): Promise<{ written: string[]; result?: unknown; error?: string }> {
    const written: string[] = [];
    const ptyManager = { get: () => ({}), write: (_id: string, data: string) => { written.push(data); } } as unknown as PTYManager;
    const dispose = registerPTYHandlers(ptyManager, {} as PTYBridge);
    try {
      const result = await captured.get(IPC.PTY_WRITE_LAUNCH)!({}, 'pty-1', text, true, 'human');
      return { written, result };
    } catch (err) {
      return { written, error: (err as Error).message };
    } finally {
      dispose();
    }
  }

  it('the switch turns the session on, and a fenced session\'s agent line needs the daemon', async () => {
    const dispose = registerPTYHandlers({} as PTYManager, {} as PTYBridge);
    try {
      expect(await captured.get(IPC.PANE_FENCE_SET)!({}, 'pty-1', true)).toBe(true);
    } finally {
      dispose();
    }
    const out = await writeLaunch('claude --resume 7b0e3c2a-1f4d-4c8e-9a6b-2d5f8e1c3a90');
    expect(out.error).toContain('worker fence:');
    expect(out.written).toEqual([]);
    // A plain shell line is typed as given.
    expect((await writeLaunch('ls')).written).toEqual(['ls\r']);
  });

  it('a session that is not opted in types the line as given', async () => {
    const out = await writeLaunch('claude --resume 7b0e3c2a-1f4d-4c8e-9a6b-2d5f8e1c3a90');
    expect(out.written).toEqual(['claude --resume 7b0e3c2a-1f4d-4c8e-9a6b-2d5f8e1c3a90\r']);
    expect(fence.calls).toEqual([]);
    expect(out.result).toBeUndefined();
  });
});
