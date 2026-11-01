import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import { isSquirrelInstall, removeDaemonRuntimeStages, stageDaemonRuntime, stagedDaemonScripts, stageKey } from '../daemonRuntimeStage';

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

  it('copies the install out of the install root, keeping its layout', () => {
    const staged = stage();
    expect(staged).not.toBeNull();
    expect(staged!.dir.startsWith(stageRoot)).toBe(true);
    expect(fs.readFileSync(staged!.nodePath, 'utf8')).toBe('exe');
    expect(fs.readFileSync(staged!.script, 'utf8')).toBe('daemon');
    expect(staged!.script).toBe(path.join(staged!.dir, 'resources', 'daemon-bundle', 'index.js'));
    expect(stagedDaemonScripts(stageRoot)).toEqual([staged!.script]);
  });

  it('reuses the copy of the same build', () => {
    const first = stage()!;
    fs.writeFileSync(path.join(first.dir, 'marker'), 'x');
    expect(stage()!.dir).toBe(first.dir);
    expect(fs.existsSync(path.join(first.dir, 'marker'))).toBe(true);
  });

  it('makes a new copy for a new build and removes the old one', () => {
    const first = stage()!;
    const script = path.join(appDir, 'resources', 'daemon-bundle', 'index.js');
    const later = new Date(Date.now() + 60_000);
    fs.utimesSync(script, later, later);
    const second = stage()!;
    expect(second.dir).toBe(path.join(stageRoot, stageKey('4.13.0', fs.statSync(script).mtimeMs)));
    expect(second.dir).not.toBe(first.dir);
    expect(fs.existsSync(first.dir)).toBe(false);
    expect(fs.readdirSync(stageRoot)).toEqual([path.basename(second.dir)]);
  });

  it.skipIf(process.platform !== 'win32')('leaves a copy whose daemon still runs whole', async () => {
    const first = stage()!;
    fs.copyFileSync(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'PING.EXE'), first.nodePath);
    const running = spawn(first.nodePath, ['-n', '30', '127.0.0.1'], { stdio: 'ignore', windowsHide: true });
    try {
      await new Promise<void>((resolve, reject) => { running.once('spawn', resolve); running.once('error', reject); });
      const later = new Date(Date.now() + 60_000);
      fs.utimesSync(path.join(appDir, 'resources', 'daemon-bundle', 'index.js'), later, later);
      expect(stage()!.dir).not.toBe(first.dir);
      expect(fs.existsSync(first.script)).toBe(true);
      expect(fs.existsSync(first.nodePath)).toBe(true);
    } finally {
      running.kill();
      await new Promise((r) => running.once('exit', r));
    }
  });

  it('rebuilds a copy whose wmux.exe a prune removed', () => {
    const first = stage()!;
    fs.rmSync(first.nodePath);
    const again = stage()!;
    expect(again.dir).toBe(first.dir);
    expect(fs.readFileSync(again.nodePath, 'utf8')).toBe('exe');
  });

  it('returns null when the install has no daemon script', () => {
    fs.rmSync(path.join(appDir, 'resources'), { recursive: true });
    expect(stage()).toBeNull();
    expect(stagedDaemonScripts(stageRoot)).toEqual([]);
  });
  it('uninstall removes every staged copy', () => {
    expect(stage()).not.toBeNull();
    expect(removeDaemonRuntimeStages(stageRoot)).toBe(true);
    expect(fs.existsSync(stageRoot)).toBe(false);
    // Nothing staged is fine too.
    expect(removeDaemonRuntimeStages(stageRoot)).toBe(true);
  });
});
