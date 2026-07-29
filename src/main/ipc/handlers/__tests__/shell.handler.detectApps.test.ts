/**
 * shell.handler — `detect-apps` channel ("Open with…" submenu population).
 *
 * The submenu probes one launcher per candidate editor. Doing that with
 * execFileSync would block the main process event loop for the sum of every
 * probe (measured in seconds when AV intercepts process creation), which stalls
 * PTY pumping and every other IPC channel. These tests pin the properties that
 * keep it cheap:
 *   • no synchronous child_process call on the path (structural guard)
 *   • probes are issued in one batch, not serialized one-after-another
 *   • File Explorer is always offered, with no probe spent on it
 *   • non-Windows returns immediately without probing at all
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as nodePath from 'node:path';

vi.mock('electron', () => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  return {
    ipcMain: {
      handle: vi.fn((channel: string, fn: (...args: unknown[]) => unknown) => {
        handlers.set(channel, fn);
      }),
      removeHandler: vi.fn((channel: string) => {
        handlers.delete(channel);
      }),
    },
    shell: { openPath: vi.fn(), showItemInFolder: vi.fn(), openExternal: vi.fn() },
    app: { isPackaged: false, getAppMetrics: () => [] },
    __handlers: handlers,
  };
});

vi.mock('../../../../shared/ShellDetector', () => ({
  ShellDetector: class {
    detect() {
      return Promise.resolve([]);
    }
  },
}));

// execFile is captured so we can inspect how many probes were issued and when
// their callbacks run. Callbacks are held until the test releases them, which is
// what makes the "issued in parallel" assertion meaningful.
const execFileCalls: { file: string; args: string[]; done: (err: Error | null) => void }[] = [];
vi.mock('child_process', () => ({
  execFile: vi.fn((file: string, args: string[], _opts: unknown, cb: (err: Error | null) => void) => {
    execFileCalls.push({ file, args, done: cb });
    return {};
  }),
  spawn: vi.fn(() => ({ on: vi.fn(), unref: vi.fn() })),
}));

import * as electron from 'electron';
import { registerShellHandlers } from '../shell.handler';
import { IPC } from '../../../../shared/constants';

const handlers = (electron as unknown as { __handlers: Map<string, (...a: unknown[]) => unknown> }).__handlers;

function detectApps(): Promise<{ id: string; name: string }[]> {
  const fn = handlers.get(IPC.SHELL_DETECT_APPS);
  if (!fn) throw new Error(`no handler for ${IPC.SHELL_DETECT_APPS}`);
  return fn({} as unknown) as Promise<{ id: string; name: string }[]>;
}

/** Swap process.platform for one test; restored in afterEach. */
function setPlatform(value: string): void {
  Object.defineProperty(process, 'platform', { value, configurable: true });
}

const REAL_PLATFORM = process.platform;

describe('shell.handler detect-apps', () => {
  let dispose: () => void;

  beforeEach(() => {
    execFileCalls.length = 0;
    dispose = registerShellHandlers();
  });

  afterEach(() => {
    dispose();
    setPlatform(REAL_PLATFORM);
  });

  it('never uses a synchronous child_process call on the detection path', () => {
    // execFileSync blocks the event loop until the spawned process exits; with
    // one probe per candidate editor that is the whole main process frozen for
    // the duration of the context menu opening.
    const src = fs.readFileSync(
      nodePath.join(__dirname, '..', 'shell.handler.ts'),
      'utf8',
    );
    // Matches call sites only, so a comment explaining why the sync variant was
    // dropped does not trip the guard.
    expect(src).not.toMatch(/\b(execFileSync|execSync|spawnSync)\s*\(/);
  });

  it('issues every Windows probe before any of them resolves', async () => {
    setPlatform('win32');
    const pending = detectApps();

    // All probes were fired synchronously in one batch — none of the callbacks
    // has run yet, so a serialized implementation would show exactly 1 here.
    expect(execFileCalls.length).toBeGreaterThan(1);
    const issued = execFileCalls.length;

    // Resolve every probe as "not found" and make sure nothing else is queued
    // afterwards (i.e. the fan-out really was one round, not a chain).
    for (const call of execFileCalls) call.done(new Error('not found'));
    const apps = await pending;
    expect(execFileCalls.length).toBe(issued);

    expect(apps.map(a => a.id)).toEqual(['explorer']);
  });

  it('probes with an absolute where.exe path, never a PATH-resolved name', async () => {
    setPlatform('win32');
    const pending = detectApps();
    for (const call of execFileCalls) {
      expect(nodePath.isAbsolute(call.file)).toBe(true);
      expect(call.file.toLowerCase()).toContain('where.exe');
      call.done(new Error('not found'));
    }
    await pending;
  });

  it('reports the launchers whose probe succeeded, Explorer first', async () => {
    setPlatform('win32');
    const pending = detectApps();
    for (const call of execFileCalls) {
      // Pretend only VS Code is installed.
      call.done(call.args[0] === 'code.cmd' ? null : new Error('not found'));
    }
    const apps = await pending;
    expect(apps.map(a => a.id)).toEqual(['explorer', 'code']);
  });

  it('returns Explorer alone on non-Windows without spawning a probe', async () => {
    setPlatform('darwin');
    const apps = await detectApps();
    expect(apps.map(a => a.id)).toEqual(['explorer']);
    expect(execFileCalls).toHaveLength(0);
  });
});
