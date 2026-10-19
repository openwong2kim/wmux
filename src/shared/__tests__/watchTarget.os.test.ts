// watchTarget — the directory spelling handed to fs.watch (#984). libuv 1.52
// on Windows aborts (asserts on) or garbles the event filename (asserts off)
// when a watched directory is spelled with an 8.3 short component, so the
// helper must hand back the long form.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import { watchTarget } from '../watchTarget';
import { shortPathOf } from '../../test-utils/shortPath';

let dir: string;

beforeEach(() => {
  // Longer than 8 characters, so NTFS gives it a short alias where 8.3
  // generation is on (the windows-latest system drive, where %TEMP% lives).
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-watch-target-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('watchTarget', () => {
  it.runIf(process.platform === 'win32')('expands an 8.3 short directory to its long form', (ctx) => {
    const short = shortPathOf(dir);
    if (!short) return ctx.skip(); // 8.3 names are off for this volume
    const target = watchTarget(short);
    expect(target).not.toContain('~');
    expect(target.toLowerCase()).toBe(fs.realpathSync.native(dir).toLowerCase());
  });

  it('returns a directory that cannot be resolved unchanged, so fs.watch still throws', () => {
    const missing = path.join(dir, 'not-yet');
    expect(watchTarget(missing)).toBe(missing);
  });

  it.runIf(process.platform !== 'win32')('is a no-op off Windows', () => {
    expect(watchTarget(dir)).toBe(dir);
  });
});
