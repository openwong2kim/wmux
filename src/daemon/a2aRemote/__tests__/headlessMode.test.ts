// Headless mode: on only with the owner's flag and no sign of the app; the
// flag is read on every question; any sign of the app turns it off for good.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HeadlessMode, headlessFlagPath, headlessStartable } from '../headlessMode';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'headless-mode-'));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const optIn = (): void => fs.writeFileSync(headlessFlagPath(dir), 'on\n');

describe('headless mode', () => {
  it('is on only while the flag is there', () => {
    const mode = new HeadlessMode({ a2aDir: dir, appHostAtBoot: false });
    expect(mode.active()).toBe(false);
    optIn();
    expect(mode.active()).toBe(true);
    fs.unlinkSync(headlessFlagPath(dir));
    expect(mode.active()).toBe(false);
  });

  it('is never on where the app was known at boot', () => {
    optIn();
    expect(new HeadlessMode({ a2aDir: dir, appHostAtBoot: true }).active()).toBe(false);
  });

  it('the app showing up in this run turns it off for good, and says so once', () => {
    optIn();
    let seen = false;
    let told = 0;
    const mode = new HeadlessMode({ a2aDir: dir, appHostAtBoot: false, appSeen: () => seen });
    mode.onAppAttached(() => { told += 1; });
    expect(mode.active()).toBe(true);
    seen = true;
    expect(mode.active()).toBe(false);
    seen = false;
    expect(mode.active()).toBe(false);
    mode.markAppAttached();
    expect(told).toBe(1);
  });

  it('starts only an agent whose launch pins its conversation and takes the worker permission flags', () => {
    expect(headlessStartable('claude')).toBe(true);
    expect(headlessStartable('codex')).toBe(false);
    expect(headlessStartable('qwen')).toBe(false);
    expect(headlessStartable('nope')).toBe(false);
  });
});
