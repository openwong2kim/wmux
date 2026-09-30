// shortPathOf — the test-only helper that spells a directory the way a
// windows-latest runner's %TEMP% does (#984). Every Windows-only #984 test
// skips when it returns null, so a wrong non-null answer turns a skip into a
// failure on the machines where 8.3 names cannot be produced.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import { shortPathOf } from '../shortPath';

/** "Hangul" written in Hangul, like a Korean user name inside %TEMP%. */
const HANGUL = String.fromCharCode(0xd55c, 0xae00);

let parent: string;

beforeEach(() => {
  parent = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-short-path-'));
});

afterEach(() => {
  fs.rmSync(parent, { recursive: true, force: true });
});

describe('shortPathOf', () => {
  it.runIf(process.platform === 'win32')('names the same directory through a non-ASCII component', (ctx) => {
    // Two characters is already a valid 8.3 name under a code page that has
    // them (949), so `%~s` keeps it verbatim and cmd has to print it.
    const dir = path.join(parent, HANGUL, 'wmux-short-path-long-name');
    fs.mkdirSync(dir, { recursive: true });
    const short = shortPathOf(dir);
    if (!short) return ctx.skip(); // 8.3 names are off for this volume
    expect(fs.realpathSync.native(short).toLowerCase()).toBe(fs.realpathSync.native(dir).toLowerCase());
  });

  it('returns null for a path that does not exist, so callers skip', () => {
    expect(shortPathOf(path.join(parent, 'not-created-long-name'))).toBeNull();
  });
});
