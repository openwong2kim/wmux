import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';

// The launcher's ready state: stopped → probing (a candidate endpoint bound)
// → ready (it answered) → stopped, and probing → stopped when the candidate is
// dead. isRunning() and currentPort() keep their old meaning: a candidate
// still being probed counts. Same fakes as ChromeLauncher.os.test.ts.

const { spawnMock, state } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  state: { portFiles: {} as Record<string, string> },
}));
vi.mock('child_process', () => ({ spawn: spawnMock }));
vi.mock('electron', () => ({ app: { getVersion: () => '0.0.0' }, autoUpdater: {}, ipcMain: {}, net: {}, shell: {} }));
vi.mock('node:fs', async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return {
    ...real,
    existsSync: () => true,
    mkdirSync: () => undefined,
    readFileSync: vi.fn((p: unknown) => {
      const s = String(p).replace(/\\/g, '/');
      if (s.endsWith('DevToolsActivePort')) {
        for (const [dir, content] of Object.entries(state.portFiles)) {
          if (s.startsWith(dir)) return content;
        }
      }
      throw new Error('ENOENT (unit test)');
    }),
    writeFileSync: () => undefined,
  };
});

import { ChromeLauncher } from '../ChromeLauncher';

type Observed = { state: string; running: boolean; port: number | null };

/** The private state, read for this test only, next to the public reads. */
function observe(launcher: ChromeLauncher): Observed {
  return {
    state: (launcher as unknown as { state: string }).state,
    running: launcher.isRunning(),
    port: launcher.currentPort(),
  };
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  spawnMock.mockReset();
  state.portFiles = {};
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ChromeLauncher ready state', () => {
  it('goes stopped → probing → ready on an adopted endpoint, and back to stopped on dispose', async () => {
    state.portFiles['/tmp/ready-profile'] = '9333\n/devtools/browser/old\n';
    const launcher = new ChromeLauncher('/tmp/ready-profile');
    expect(observe(launcher)).toEqual({ state: 'stopped', running: false, port: null });

    let seenWhileProbing: Observed | null = null;
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith('/json/version')) seenWhileProbing ??= observe(launcher);
      return { ok: true, status: 200, text: async () => '{}' };
    });

    expect(await launcher.ensureRunning()).toBe(9333);
    // A candidate being probed already counts as running, as cdpPort > 0 did.
    expect(seenWhileProbing).toEqual({ state: 'probing', running: true, port: 9333 });
    expect(observe(launcher)).toEqual({ state: 'ready', running: true, port: 9333 });

    await launcher.dispose();
    expect(observe(launcher)).toEqual({ state: 'stopped', running: false, port: null });
  });

  it('drops a dead candidate back to stopped before launching its own Chrome', async () => {
    state.portFiles['/tmp/dead-profile'] = '9444\n/devtools/browser/dead\n';
    const launcher = new ChromeLauncher('/tmp/dead-profile');
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));

    let seenAtSpawn: Observed | null = null;
    spawnMock.mockImplementationOnce(() => {
      seenAtSpawn = observe(launcher);
      const child = new EventEmitter() as EventEmitter & { kill: () => void };
      child.kill = () => undefined;
      // The new Chrome dies at once: the launch fails and leaves nothing bound.
      setTimeout(() => child.emit('exit', 1), 0);
      return child;
    });

    await expect(launcher.ensureRunning()).rejects.toThrow('Chrome exited during startup');
    expect(seenAtSpawn).toEqual({ state: 'stopped', running: false, port: null });
    expect(observe(launcher)).toEqual({ state: 'stopped', running: false, port: null });
  });
});
