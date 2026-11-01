import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import { isSquirrelInstall, removeDaemonRuntimeStages, stageDaemonRuntime, stagedDaemonScripts, stageKey } from '../daemonRuntimeStage';
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

    it('never uses a copy that returned without the daemon script', async () => {
      const partial = vi.fn(async (_from: string, to: string) => {
        fs.mkdirSync(to, { recursive: true });
        fs.writeFileSync(path.join(to, 'wmux.exe'), 'exe');
      });
      expect(await stageWith(partial)).toBeNull();
      expect(fs.readdirSync(stageRoot)).toEqual([]);
    });
  });
});
