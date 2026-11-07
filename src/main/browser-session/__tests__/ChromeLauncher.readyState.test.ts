import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough } from 'node:stream';

// The launcher's ready state, seen through its public reads. A candidate
// endpoint being probed counts as running, as it did with cdpPort; a probe
// that loses its Chrome meanwhile (dispose, the child exiting) must not leave
// the launcher reporting one. Same fakes as ChromeLauncher.os.test.ts.

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

type Seen = { running: boolean; port: number | null };

const seen = (launcher: ChromeLauncher): Seen => ({ running: launcher.isRunning(), port: launcher.currentPort() });

/** Running exactly when a port is reported: the two reads never disagree. */
function expectConsistent(launcher: ChromeLauncher): void {
  expect(launcher.isRunning()).toBe(launcher.currentPort() !== null);
}

const ok = (body = '{}') => ({ ok: true, status: 200, text: async () => body });

/** A list holding only a startup tab: the restored-tab pass has nothing to close. */
const STARTUP_LIST = '[{"id":"S","type":"page","url":"about:blank"}]';

type FakeChild = EventEmitter & { kill: () => void };

/** The next spawn writes a fresh DevToolsActivePort for `dir` naming `port`. */
function spawnWithPort(dir: string, port: number): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.kill = () => undefined;
  spawnMock.mockImplementationOnce(() => {
    state.portFiles[dir] = `${port}\n/devtools/browser/fresh-${port}\n`;
    return child;
  });
  return child;
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
  it('reports an adopted endpoint while it is probed and once it answers, and nothing after dispose', async () => {
    state.portFiles['/tmp/ready-profile'] = '9333\n/devtools/browser/old\n';
    const launcher = new ChromeLauncher('/tmp/ready-profile');
    expect(seen(launcher)).toEqual({ running: false, port: null });

    let whileProbing: Seen | null = null;
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith('/json/version')) {
        whileProbing ??= seen(launcher);
        expectConsistent(launcher);
      }
      return ok();
    });

    expect(await launcher.ensureRunning()).toBe(9333);
    expect(whileProbing).toEqual({ running: true, port: 9333 });
    expect(seen(launcher)).toEqual({ running: true, port: 9333 });

    await launcher.dispose();
    expect(seen(launcher)).toEqual({ running: false, port: null });
  });

  it('drops a dead candidate before launching its own Chrome', async () => {
    state.portFiles['/tmp/dead-profile'] = '9444\n/devtools/browser/dead\n';
    const launcher = new ChromeLauncher('/tmp/dead-profile');
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));

    let atSpawn: Seen | null = null;
    spawnMock.mockImplementationOnce(() => {
      atSpawn = seen(launcher);
      const child = new EventEmitter() as FakeChild;
      child.kill = () => undefined;
      // The new Chrome dies at once: the launch fails and leaves nothing bound.
      setTimeout(() => child.emit('exit', 1), 0);
      return child;
    });

    await expect(launcher.ensureRunning()).rejects.toThrow('Chrome exited during startup');
    expect(atSpawn).toEqual({ running: false, port: null });
    expect(seen(launcher)).toEqual({ running: false, port: null });
  });

  it('quotes what a port Chrome said before it exited, even when stderr ends after the exit', async () => {
    const launcher = new ChromeLauncher('/tmp/refused-profile');
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));
    spawnMock.mockImplementationOnce(() => {
      const child = new EventEmitter() as FakeChild & { stderr: PassThrough };
      child.kill = () => undefined;
      child.stderr = new PassThrough();
      // Windows Chrome refusing remote debugging: it exits, and its stderr is read after.
      setTimeout(() => {
        child.emit('exit', 0);
        setTimeout(() => {
          child.stderr.end('DevTools remote debugging requires a non-default data directory. Specify this using --user-data-dir.\r\n');
        }, 20);
      }, 0);
      return child;
    });

    const message = await launcher.ensureRunning().then(() => null, (err: Error) => err.message);
    const [, , opts] = spawnMock.mock.calls[0] as [string, string[], { stdio: unknown }];
    expect(opts.stdio).toEqual(['ignore', 'ignore', 'pipe']);
    expect(message).toContain('ChromeLauncher: Chrome exited during startup');
    expect(message).toContain('Chrome said: DevTools remote debugging requires a non-default data directory');
    // An exit is not explained by a probe that failed before it.
    expect(message).not.toContain('last error');
  });

  it('reports nothing when the launched Chrome exits while its first probe is in flight', async () => {
    const launcher = new ChromeLauncher('/tmp/exit-profile');
    const child = spawnWithPort('/tmp/exit-profile', 9555);
    let first = true;
    fetchMock.mockImplementation(async (url: string) => {
      if (first && url.endsWith(':9555/json/version')) {
        first = false;
        // The child goes away while the probe is still waiting for its answer.
        child.emit('exit', 1);
        expectConsistent(launcher);
      }
      return ok(STARTUP_LIST);
    });

    await launcher.ensureRunning().catch(() => undefined);
    expect(seen(launcher)).toEqual({ running: false, port: null });
  });

  it('reports nothing when dispose lands while the first probe is in flight', async () => {
    const launcher = new ChromeLauncher('/tmp/dispose-profile');
    spawnWithPort('/tmp/dispose-profile', 9666);
    let first = true;
    fetchMock.mockImplementation(async (url: string) => {
      if (first && url.endsWith(':9666/json/version')) {
        first = false;
        await launcher.dispose({ immediate: true });
        expectConsistent(launcher);
      }
      return ok(STARTUP_LIST);
    });

    await expect(launcher.ensureRunning()).rejects.toThrow('disposed');
    expect(seen(launcher)).toEqual({ running: false, port: null });
  });

  it('reports nothing when dispose lands while an adopted candidate is probed', async () => {
    state.portFiles['/tmp/adopt-dispose'] = '9777\n/devtools/browser/old\n';
    const launcher = new ChromeLauncher('/tmp/adopt-dispose');
    let duringProbe: Seen | null = null;
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith(':9777/json/version') && duringProbe === null) {
        await launcher.dispose({ immediate: true });
        duringProbe = seen(launcher);
      }
      return ok(STARTUP_LIST);
    });

    await expect(launcher.ensureRunning()).rejects.toThrow('disposed');
    expect(duringProbe).toEqual({ running: false, port: null });
    expect(seen(launcher)).toEqual({ running: false, port: null });
  });
});
