// A real-Chrome suite's temp profile goes away whole, and only once its Chrome has.
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { ChromeLauncher } from '../../main/browser-session/ChromeLauncher';
import { DOWNLOAD_DIR_PREFIX } from '../chromeDownloads';
import { stopChrome, tempChromeProfile } from '../chromeProfile';
import { sweepStaleTempDirs } from '../staleTempDirs';

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

  it('leaves nothing in the temp dir, and sweeps the stale dirs a killed run left', async () => {
    // A temp dir of this test's own, so the count is exact while other runs share the machine's.
    sweepStaleTempDirs('wmux-profile-count-root-');
    const ownTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-profile-count-root-'));
    for (const k of ['TMPDIR', 'TEMP', 'TMP']) vi.stubEnv(k, ownTmp);
    try {
      // As a run killed before its afterAll leaves them: a day and more old, no Chrome on them.
      const old = new Date(Date.now() - 25 * 60 * 60 * 1000);
      const stale = ['wmux-profile-count-', DOWNLOAD_DIR_PREFIX, 'wmux-profile-scratch-'].map((p) => {
        const dir = fs.mkdtempSync(path.join(ownTmp, p));
        fs.writeFileSync(path.join(dir, 'Local State'), '{}');
        fs.utimesSync(path.join(dir, 'Local State'), old, old);
        fs.utimesSync(dir, old, old);
        return dir;
      });

      const profile = tempChromeProfile('wmux-profile-count-');
      profile.scratch('wmux-profile-scratch-');
      expect(stale.filter((d) => fs.existsSync(d))).toEqual([]);
      await profile.remove();
      expect(fs.readdirSync(ownTmp)).toEqual([]);
    } finally {
      vi.unstubAllEnvs();
      fs.rmSync(ownTmp, { recursive: true, force: true });
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
