// A real-Chrome suite's temp profile goes away whole, and only once its Chrome has.
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { ChromeLauncher } from '../../main/browser-session/ChromeLauncher';
import { stopChrome, tempChromeProfile } from '../chromeProfile';
import { removeTempDirs } from '../removeTempDir';
import { SWEEP_MARKER, makeSweepableTempDir } from '../staleTempDirs';

describe('tempChromeProfile', () => {
  it('removes the profile, its pinned download folder and every scratch dir, keeping extra preferences next to the pin', async () => {
    const profile = tempChromeProfile('wmux-profile-test-', { preferences: { partition: { x: 1 } } });
    const scratch = profile.scratch('wmux-profile-test-scratch-');
    fs.writeFileSync(path.join(scratch, 'f'), 'x');
    const prefs = JSON.parse(fs.readFileSync(path.join(profile.dir, 'Default', 'Preferences'), 'utf8')) as Record<string, unknown>;
    expect(prefs).toEqual({ partition: { x: 1 }, download: { default_directory: profile.downloads, prompt_for_download: false } });

    await profile.remove();
    expect([profile.dir, profile.downloads, scratch].filter((d) => fs.existsSync(d))).toEqual([]);
  });

  it('leaves nothing in the temp dir, and sweeps the marked stale profile a killed run left', async () => {
    // A temp dir of this test's own, so the count is exact while other runs share the machine's.
    const ownTmp = makeSweepableTempDir('wmux-profile-count-root-');
    for (const k of ['TMPDIR', 'TEMP', 'TMP']) vi.stubEnv(k, ownTmp);
    try {
      // As a run killed before its afterAll leaves them: a day and more old, no Chrome on them.
      // Only the one the helper marked is its to sweep.
      const old = new Date(Date.now() - 25 * 60 * 60 * 1000);
      const [marked, unmarked] = [true, false].map((mark) => {
        const dir = fs.mkdtempSync(path.join(ownTmp, 'wmux-profile-count-'));
        for (const name of ['Local State', ...(mark ? [SWEEP_MARKER] : [])]) {
          fs.writeFileSync(path.join(dir, name), '');
          fs.utimesSync(path.join(dir, name), old, old);
        }
        fs.utimesSync(dir, old, old);
        return dir;
      });

      const profile = tempChromeProfile('wmux-profile-count-');
      expect(fs.lstatSync(path.join(profile.dir, SWEEP_MARKER)).isFile()).toBe(true);
      profile.scratch('wmux-profile-scratch-');
      expect([fs.existsSync(marked), fs.existsSync(unmarked)]).toEqual([false, true]);
      await profile.remove();
      expect(fs.readdirSync(ownTmp).filter((n) => n !== SWEEP_MARKER)).toEqual([path.basename(unmarked)]);
    } finally {
      vi.unstubAllEnvs();
      await removeTempDirs([ownTmp]);
    }
  });

  it('leaves no dir behind when setting up the profile fails', () => {
    const made: string[] = [];
    const real = fs.mkdtempSync.bind(fs);
    const spy = vi.spyOn(fs, 'mkdtempSync').mockImplementation(((prefix: string) => {
      const dir = real(prefix);
      made.push(dir);
      return dir;
    }) as typeof fs.mkdtempSync);
    try {
      // A BigInt can't be written as JSON: the Preferences write fails once both dirs exist.
      expect(() => tempChromeProfile('wmux-profile-test-', { preferences: { bad: BigInt(1) } })).toThrow(/BigInt/);
    } finally {
      spy.mockRestore();
    }
    expect(made).toHaveLength(2);
    expect(made.filter((d) => fs.existsSync(d))).toEqual([]);
  });
});

describe('stopChrome', () => {
  it('returns only once a child that dispose() merely signalled has exited', async () => {
    // Takes a moment to go after SIGTERM, as Chrome does.
    const child = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => setTimeout(() => process.exit(0), 300)); setInterval(() => {}, 1000); console.log('ready')"], { stdio: ['ignore', 'pipe', 'ignore'] });
    await once(child.stdout!, 'data');
    const launcher = { child, exiting: null, dispose: async () => { child.kill(); } } as unknown as ChromeLauncher;

    await stopChrome(launcher);
    expect(child.exitCode ?? child.signalCode).not.toBeNull();
  });
});
