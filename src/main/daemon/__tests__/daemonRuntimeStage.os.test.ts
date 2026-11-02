import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import { isSquirrelInstall, removeDaemonRuntimeStages, stageDaemonRuntime, stagedDaemonScripts, stageKey, treeFsFor, type TreeFs } from '../daemonRuntimeStage';
import { deliberateSleep } from '../../../test-utils/waitFor';

describe('daemon runtime staging', () => {
  let root: string;
  let appDir: string;
  let stageRoot: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-stage-'));
    appDir = path.join(root, 'app-4.13.0');
    stageRoot = path.join(root, 'wmux-daemon-runtime');
    fs.mkdirSync(path.join(appDir, 'resources', 'daemon-bundle'), { recursive: true });
    fs.writeFileSync(path.join(appDir, 'wmux.exe'), 'exe');
    fs.writeFileSync(path.join(appDir, 'resources', 'daemon-bundle', 'index.js'), 'daemon');
  });

  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  const stage = () => stageDaemonRuntime({ appDir, exeName: 'wmux.exe', stageRoot, version: '4.13.0' });

  it('recognises a Squirrel install only when Update.exe is in the parent folder', () => {
    expect(isSquirrelInstall(appDir)).toBe(false);
    fs.writeFileSync(path.join(root, 'Update.exe'), 'updater');
    expect(isSquirrelInstall(appDir)).toBe(true);
  });

  it('copies the install out of the install root, keeping its layout', async () => {
    const staged = await stage();
    expect(staged).not.toBeNull();
    expect(staged!.dir.startsWith(stageRoot)).toBe(true);
    expect(fs.readFileSync(staged!.nodePath, 'utf8')).toBe('exe');
    expect(fs.readFileSync(staged!.script, 'utf8')).toBe('daemon');
    expect(staged!.script).toBe(path.join(staged!.dir, 'resources', 'daemon-bundle', 'index.js'));
    expect(stagedDaemonScripts(stageRoot)).toEqual([staged!.script]);
  });

  it('reuses the copy of the same build', async () => {
    const first = (await stage())!;
    fs.writeFileSync(path.join(first.dir, 'marker'), 'x');
    expect((await stage())!.dir).toBe(first.dir);
    expect(fs.existsSync(path.join(first.dir, 'marker'))).toBe(true);
  });

  it('makes a new copy for a new build and removes the old one', async () => {
    const first = (await stage())!;
    const script = path.join(appDir, 'resources', 'daemon-bundle', 'index.js');
    const later = new Date(Date.now() + 60_000);
    fs.utimesSync(script, later, later);
    const second = (await stage())!;
    expect(second.dir).toBe(path.join(stageRoot, stageKey('4.13.0', fs.statSync(script).mtimeMs)));
    expect(second.dir).not.toBe(first.dir);
    expect(fs.existsSync(first.dir)).toBe(false);
    expect(fs.readdirSync(stageRoot)).toEqual([path.basename(second.dir)]);
  });

  it.skipIf(process.platform !== 'win32')('leaves a copy whose daemon still runs whole', async () => {
    const first = (await stage())!;
    fs.copyFileSync(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'PING.EXE'), first.nodePath);
    const running = spawn(first.nodePath, ['-n', '30', '127.0.0.1'], { stdio: 'ignore', windowsHide: true });
    try {
      await new Promise<void>((resolve, reject) => { running.once('spawn', resolve); running.once('error', reject); });
      const later = new Date(Date.now() + 60_000);
      fs.utimesSync(path.join(appDir, 'resources', 'daemon-bundle', 'index.js'), later, later);
      expect((await stage())!.dir).not.toBe(first.dir);
      expect(fs.existsSync(first.script)).toBe(true);
      expect(fs.existsSync(first.nodePath)).toBe(true);
    } finally {
      running.kill();
      await new Promise((r) => running.once('exit', r));
    }
  });

  it('rebuilds a copy whose wmux.exe a prune removed', async () => {
    const first = (await stage())!;
    fs.rmSync(first.nodePath);
    const again = (await stage())!;
    expect(again.dir).toBe(first.dir);
    expect(fs.readFileSync(again.nodePath, 'utf8')).toBe('exe');
  });

  it('returns null when the install has no daemon script', async () => {
    fs.rmSync(path.join(appDir, 'resources'), { recursive: true });
    expect(await stage()).toBeNull();
    expect(stagedDaemonScripts(stageRoot)).toEqual([]);
  });
  it('uninstall removes every staged copy', async () => {
    expect(await stage()).not.toBeNull();
    expect(removeDaemonRuntimeStages(stageRoot)).toBe(true);
    expect(fs.existsSync(stageRoot)).toBe(false);
    // Nothing staged is fine too.
    expect(removeDaemonRuntimeStages(stageRoot)).toBe(true);
  });

  describe('the copy runs off the main thread', () => {
    /**
     * A copy part way through: the exe and the script are written, the rest
     * not. It holds there until the test lets it finish or fail.
     */
    function heldCopy() {
      let release!: (fail?: Error) => void;
      const held = new Promise<Error | undefined>((resolve) => { release = resolve; });
      const copy = vi.fn(async (from: string, to: string) => {
        fs.mkdirSync(path.join(to, 'resources', 'daemon-bundle'), { recursive: true });
        fs.writeFileSync(path.join(to, 'wmux.exe'), 'exe');
        fs.writeFileSync(path.join(to, 'resources', 'daemon-bundle', 'index.js'), 'daemon');
        const fail = await held;
        if (fail) throw fail;
        await fs.promises.cp(from, to, { recursive: true });
      });
      return { copy, release };
    }
    const stageWith = (copy: (from: string, to: string) => Promise<void>) =>
      stageDaemonRuntime({ appDir, exeName: 'wmux.exe', stageRoot, version: '4.13.0', copy });

    it('a spawn while the copy runs waits for that same copy, and the next spawn uses it', async () => {
      const { copy, release } = heldCopy();
      let settled = 0;
      const first = stageWith(copy).finally(() => { settled++; });
      const second = stageWith(copy).finally(() => { settled++; });
      await vi.waitFor(() => expect(copy).toHaveBeenCalledTimes(1), { timeout: 10_000 });
      await deliberateSleep(50, 'negative: neither spawn settles while the copy is held');
      expect(settled).toBe(0);
      // Nothing of a copy in progress can be run, by this process or the next.
      expect(stagedDaemonScripts(stageRoot)).toEqual([]);
      release();
      const [a, b] = await Promise.all([first, second]);
      expect(a).not.toBeNull();
      expect(b).toEqual(a);
      expect(fs.readFileSync(a!.nodePath, 'utf8')).toBe('exe');
      expect(copy).toHaveBeenCalledTimes(1);
      // The next spawn finds the copy made.
      const next = vi.fn(async () => { throw new Error('copied again'); });
      expect(await stageWith(next)).toEqual(a);
      expect(next).not.toHaveBeenCalled();
    });

    it('never uses a copy that failed part way, and the next spawn copies again', async () => {
      const { copy, release } = heldCopy();
      const warn = vi.fn();
      const pending = stageDaemonRuntime({ appDir, exeName: 'wmux.exe', stageRoot, version: '4.13.0', copy, warn });
      await vi.waitFor(() => expect(copy).toHaveBeenCalledTimes(1), { timeout: 10_000 });
      release(new Error('disk full'));
      expect(await pending).toBeNull();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('disk full'));
      expect(fs.readdirSync(stageRoot)).toEqual([]);
      expect(stagedDaemonScripts(stageRoot)).toEqual([]);
      const again = await stage();
      expect(again).not.toBeNull();
      expect(fs.readFileSync(again!.script, 'utf8')).toBe('daemon');
    });

    it('runs the daemon from the install when the copy takes too long, and the next spawn gets the copy', async () => {
      const { copy, release } = heldCopy();
      const warn = vi.fn();
      const late = await stageDaemonRuntime({ appDir, exeName: 'wmux.exe', stageRoot, version: '4.13.0', copy, warn, maxWaitMs: 50 });
      expect(late).toBeNull();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('still copying after 50 ms'));
      // The copy goes on: the next spawn shares it and runs from it.
      const next = stageWith(copy);
      release();
      const staged = await next;
      expect(staged).not.toBeNull();
      expect(fs.readFileSync(staged!.script, 'utf8')).toBe('daemon');
      expect(copy).toHaveBeenCalledTimes(1);
    });

    it('never uses a copy that returned without the daemon script', async () => {
      const partial = vi.fn(async (_from: string, to: string) => {
        fs.mkdirSync(to, { recursive: true });
        fs.writeFileSync(path.join(to, 'wmux.exe'), 'exe');
      });
      expect(await stageWith(partial)).toBeNull();
      expect(fs.readdirSync(stageRoot)).toEqual([]);
    });
  });

  // In the packaged app, Electron's fs reads resources/app.asar as an archive:
  // fs.promises.cp of the tree threw "Invalid package" and fs.promises.rm of it
  // failed with EBUSY. The async operations on the tree have to use original-fs.
  describe('the tree fs (original-fs under Electron)', () => {
    it('under Electron the tree fs is original-fs; in plain node it is fs, and original-fs is never loaded', () => {
      const originalFs = { promises: {} };
      const load = vi.fn(() => originalFs);
      expect(treeFsFor('42.11.18', load)).toBe(originalFs);
      expect(load).toHaveBeenCalledTimes(1);
      const unused = vi.fn();
      expect(treeFsFor(undefined, unused)).toBe(fs);
      expect(unused).not.toHaveBeenCalled();
    });

    it('the copy, its checks, the rename and the prune all go through the tree fs, never fs.promises', async () => {
      const calls: string[] = [];
      const real = fs.promises;
      const record = <A extends unknown[], R>(name: string, fn: (...args: A) => Promise<R>) =>
        async (...args: A): Promise<R> => { calls.push(name); return fn(...args); };
      const treeFs = {
        promises: {
          cp: record('cp', real.cp.bind(real)),
          rm: record('rm', real.rm.bind(real)),
          rename: record('rename', real.rename.bind(real)),
          readdir: record('readdir', real.readdir.bind(real)),
          access: record('access', real.access.bind(real)),
        },
      } as unknown as TreeFs;
      const viaFs = (['cp', 'rm', 'rename', 'readdir', 'access'] as const).map((name) => vi.spyOn(fs.promises, name));
      try {
        const staged = await stageDaemonRuntime({ appDir, exeName: 'wmux.exe', stageRoot, version: '4.13.0', treeFs });
        expect(staged).not.toBeNull();
        expect(fs.readFileSync(staged!.script, 'utf8')).toBe('daemon');
        expect(new Set(calls)).toEqual(new Set(['cp', 'rm', 'rename', 'readdir', 'access']));
        for (const spy of viaFs) expect(spy).not.toHaveBeenCalled();
      } finally {
        for (const spy of viaFs) spy.mockRestore();
      }
    });

    // Windows antivirus briefly holds files just written, so the rename of a
    // finished copy can fail with EPERM/EBUSY/EACCES for a moment.
    const failingRename = (code: string, failures: number) => {
      const real = fs.promises;
      let left = failures;
      const rename = vi.fn(async (from: string, to: string) => {
        if (left-- > 0) throw Object.assign(new Error(`${code}: rename held`), { code });
        return real.rename(from, to);
      });
      const treeFs = {
        promises: {
          cp: real.cp.bind(real),
          rm: real.rm.bind(real),
          rename,
          readdir: real.readdir.bind(real),
          access: real.access.bind(real),
        },
      } as unknown as TreeFs;
      return { rename, treeFs };
    };

    it('a rename a scanner holds for a moment is retried, and the copy is used and kept', async () => {
      const { rename, treeFs } = failingRename('EBUSY', 2);
      const staged = await stageDaemonRuntime({ appDir, exeName: 'wmux.exe', stageRoot, version: '4.13.0', treeFs, renameRetryDelayMs: 1 });
      expect(staged).not.toBeNull();
      expect(rename).toHaveBeenCalledTimes(3);
      expect(fs.readFileSync(staged!.script, 'utf8')).toBe('daemon');
      expect(fs.readdirSync(stageRoot)).toEqual([path.basename(staged!.dir)]);
      const recopy = vi.fn(async () => { throw new Error('copied again'); });
      expect(await stageDaemonRuntime({ appDir, exeName: 'wmux.exe', stageRoot, version: '4.13.0', copy: recopy })).toEqual(staged);
      expect(recopy).not.toHaveBeenCalled();
    });

    it('a rename that stays held gives up after a bounded number of tries and removes the partial copy', async () => {
      const { rename, treeFs } = failingRename('EPERM', Infinity);
      const warn = vi.fn();
      const staged = await stageDaemonRuntime({ appDir, exeName: 'wmux.exe', stageRoot, version: '4.13.0', treeFs, warn, renameRetryDelayMs: 1 });
      expect(staged).toBeNull();
      expect(rename).toHaveBeenCalledTimes(5);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('EPERM'));
      expect(fs.readdirSync(stageRoot)).toEqual([]);
    });

    it('a rename failing for another reason is not retried', async () => {
      const { rename, treeFs } = failingRename('ENOSPC', Infinity);
      expect(await stageDaemonRuntime({ appDir, exeName: 'wmux.exe', stageRoot, version: '4.13.0', treeFs, renameRetryDelayMs: 1 })).toBeNull();
      expect(rename).toHaveBeenCalledTimes(1);
      expect(fs.readdirSync(stageRoot)).toEqual([]);
    });
  });

  describe('a partial copy left by an earlier process', () => {
    // Only one app process per data dir copies into the stage root (the
    // single-instance lock), so another pid's partial was left by a process
    // that exited part way.
    const partialOf = (pid: number) => {
      const dir = path.join(stageRoot, `4.13.0-1.partial-${pid}`);
      fs.mkdirSync(path.join(dir, 'resources'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'resources', 'app.asar'), 'half');
      return dir;
    };

    it('is removed on the next stage run, also one named after this pid for another build (a reused pid)', async () => {
      const earlier = partialOf(process.pid + 1);
      const longerPid = partialOf(Number(`${process.pid}1`));
      const reusedPid = partialOf(process.pid);
      const staged = await stage();
      expect(staged).not.toBeNull();
      expect(fs.existsSync(earlier)).toBe(false);
      expect(fs.existsSync(longerPid)).toBe(false);
      expect(fs.existsSync(reusedPid)).toBe(false);
      expect(stagedDaemonScripts(stageRoot)).toEqual([staged!.script]);
    });

    it("leaves this process's partial of the build it is copying alone while the copy runs", async () => {
      const own = `${path.join(stageRoot, stageKey('4.13.0', fs.statSync(path.join(appDir, 'resources', 'daemon-bundle', 'index.js')).mtimeMs))}.partial-${process.pid}`;
      let seenDuringCopy = false;
      const copy = vi.fn(async (from: string, to: string) => {
        expect(to).toBe(own);
        await fs.promises.cp(from, to, { recursive: true });
        await deliberateSleep(50, 'latency inside the copy stub: the prune, which runs beside the copy, gets its turn before the rename');
        seenDuringCopy = fs.existsSync(path.join(to, 'wmux.exe'));
      });
      const staged = await stageDaemonRuntime({ appDir, exeName: 'wmux.exe', stageRoot, version: '4.13.0', copy });
      expect(staged).not.toBeNull();
      expect(seenDuringCopy).toBe(true);
      expect(fs.existsSync(own)).toBe(false);
      expect(fs.readFileSync(staged!.script, 'utf8')).toBe('daemon');
    });
  });
});
