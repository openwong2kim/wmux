// A real-Chrome suite's temp profile goes away whole, and only once its Chrome has.
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { ChromeLauncher } from '../../main/browser-session/ChromeLauncher';
import { stopChrome, tempChromeProfile } from '../chromeProfile';

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

  it('leaves the count of its prefix in the temp dir unchanged, and sweeps a stale one a killed run left', async () => {
    const prefix = 'wmux-profile-count-';
    const ofPrefix = () => fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith(prefix)).sort();
    const before = ofPrefix();
    // As a run killed before its afterAll leaves it: a day and more old, no Chrome on it.
    const stale = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    fs.writeFileSync(path.join(stale, 'Local State'), '{}');
    const old = new Date(Date.now() - 25 * 60 * 60 * 1000);
    fs.utimesSync(path.join(stale, 'Local State'), old, old);
    fs.utimesSync(stale, old, old);

    const profile = tempChromeProfile(prefix);
    expect(fs.existsSync(stale)).toBe(false);
    await profile.remove();
    // Nothing of this run's is left; a concurrent run may have swept one of before.
    expect(ofPrefix().filter((n) => !before.includes(n))).toEqual([]);
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
