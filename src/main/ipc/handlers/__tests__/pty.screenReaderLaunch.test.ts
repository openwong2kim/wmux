// A screen reader's agent starts in its own screen-reader mode: the launch
// line pty:create types and the one pty:write-launch types carry the agent's
// flag while a screen reader is on (shared/screenReaderLaunch.ts).
import { describe, it, expect, vi, afterEach } from 'vitest';

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

const screenReader = vi.hoisted(() => ({ on: false }));
vi.mock('../../../screenReaderService', () => ({ isScreenReaderOn: () => screenReader.on, launcherVersion: () => '2.1.316' }));

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { registerPTYHandlers } from '../pty.handler';
import { IPC } from '../../../../shared/constants';
import type { PTYManager } from '../../../pty/PTYManager';
import type { PTYBridge } from '../../../pty/PTYBridge';

afterEach(() => {
  screenReader.on = false;
});

describe('pty:create typed launch line', () => {
  /** What a local create types into its pane once the shell first prints. */
  async function typedOnCreate(initialCommand: string): Promise<string[]> {
    const written: string[] = [];
    const onData: Array<() => void> = [];
    const ptyManager = {
      createAsync: async () => ({
        id: 'pty-c', cwd: '/tmp', shell: '/bin/zsh',
        process: { onData: (fn: () => void) => { onData.push(fn); return { dispose: () => undefined }; } },
      }),
      write: (_id: string, data: string) => { written.push(data); },
    } as unknown as PTYManager;
    const ptyBridge = { setupDataForwarding: () => undefined } as unknown as PTYBridge;
    const dispose = registerPTYHandlers(ptyManager, ptyBridge);
    try {
      const create = captured.get(IPC.PTY_CREATE);
      if (!create) throw new Error('pty:create not registered');
      await create({}, { initialCommand, shell: '/bin/zsh', ignoreAccountBinding: true });
      for (const fn of onData) fn();
      await vi.waitFor(() => expect(written.length).toBeGreaterThan(0), { timeout: 5_000 });
      return written;
    } finally {
      dispose();
    }
  }

  it('adds the flag while a screen reader is on, beside the session pin', async () => {
    screenReader.on = true;
    expect(await typedOnCreate('claude')).toEqual([expect.stringMatching(/^claude --ax-screen-reader --session-id [0-9a-f-]{36}\r$/)]);
    expect(await typedOnCreate('gemini')).toEqual(['gemini --screen-reader\r']);
  });

  it('types the line as before while no screen reader is on', async () => {
    expect(await typedOnCreate('claude')).toEqual([expect.stringMatching(/^claude --session-id [0-9a-f-]{36}\r$/)]);
    expect(await typedOnCreate('gemini')).toEqual(['gemini\r']);
  });

  it('the daemon create types the same flagged line (source lock: no daemon here)', () => {
    const src = readFileSync(path.resolve(process.cwd(), 'src/main/ipc/handlers/pty.handler.ts'), 'utf8');
    expect(src).toContain('const typedLine = execCommand !== undefined || !options?.initialCommand ? undefined : withScreenReaderFlag(options.initialCommand, isScreenReaderOn(), launcherVersion);');
  });
});

describe('pty:write-launch typed line', () => {
  it('adds the flag to a resume only while a screen reader is on', async () => {
    const written: string[] = [];
    const ptyManager = { get: () => ({}), write: (_id: string, data: string) => { written.push(data); } } as unknown as PTYManager;
    const dispose = registerPTYHandlers(ptyManager, {} as PTYBridge);
    try {
      const writeLaunch = captured.get(IPC.PTY_WRITE_LAUNCH);
      if (!writeLaunch) throw new Error('pty:write-launch not registered');
      const resume = 'claude --resume 7b0e3c2a-1f4d-4c8e-9a6b-2d5f8e1c3a90';
      screenReader.on = true;
      await writeLaunch({}, 'pty-1', resume, true, 'human');
      screenReader.on = false;
      await writeLaunch({}, 'pty-1', resume, true, 'human');
      expect(written).toEqual([
        'claude --ax-screen-reader --resume 7b0e3c2a-1f4d-4c8e-9a6b-2d5f8e1c3a90\r',
        `${resume}\r`,
      ]);
    } finally {
      dispose();
    }
  });
});
