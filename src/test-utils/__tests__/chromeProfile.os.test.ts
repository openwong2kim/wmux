// A real-Chrome suite's temp profile goes away whole, and only once its Chrome has.
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
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
