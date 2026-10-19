/**
 * settingsFile — the write path for a config file wmux does not own.
 *
 * `setup-hooks` and `setup-statusline` both edit ~/.claude/settings.json, and
 * each had its own copy of this helper with the same four defects. The file
 * holds permission grants and can hold credentials in `env`, so every property
 * below is about not damaging something that was already there.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeJsonAtomic, copyFileAtomic, resolveWriteTarget, renameWithRetry } from '../settingsFile';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-settings-file-'));
});
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const modeOf = (p: string): number => fs.statSync(p).mode & 0o777;

// Windows has no POSIX mode: chmod there toggles the read-only bit and nothing
// else, so every file reports 0o666. The permission work is real on the
// platforms that have permissions; asserting it elsewhere only tests Node.
const posixModes = process.platform !== 'win32';

describe('writeJsonAtomic', () => {
  it('writes readable JSON with a trailing newline', () => {
    const file = path.join(tmpDir, 'settings.json');
    writeJsonAtomic(file, { statusLine: { command: 'x' } });
    const raw = fs.readFileSync(file, 'utf8');
    expect(raw.endsWith('\n')).toBe(true);
    expect(JSON.parse(raw)).toEqual({ statusLine: { command: 'x' } });
  });

  // The old fixed `<file>.tmp` let two processes interleave into one buffer.
  it('uses a temp name unique to the process and leaves none behind', () => {
    const file = path.join(tmpDir, 'settings.json');
    writeJsonAtomic(file, { a: 1 });
    expect(fs.readdirSync(tmpDir)).toEqual(['settings.json']);
  });

  it.skipIf(!posixModes)('preserves the mode of an existing config', () => {
    const file = path.join(tmpDir, 'settings.json');
    fs.writeFileSync(file, '{}', 'utf8');
    fs.chmodSync(file, 0o600);
    writeJsonAtomic(file, { env: { ANTHROPIC_API_KEY: 'secret' } });
    expect(modeOf(file)).toBe(0o600);
  });

  it.skipIf(!posixModes)('creates a new config owner-only', () => {
    const file = path.join(tmpDir, 'fresh', 'settings.json');
    writeJsonAtomic(file, {});
    expect(modeOf(file)).toBe(0o600);
  });

  // A settings.json symlinked into a dotfiles repo must survive the write.
  it('writes through a symlink instead of replacing it', () => {
    const real = path.join(tmpDir, 'dotfiles', 'settings.json');
    fs.mkdirSync(path.dirname(real), { recursive: true });
    fs.writeFileSync(real, '{}', 'utf8');
    const link = path.join(tmpDir, 'settings.json');
    fs.symlinkSync(real, link);

    writeJsonAtomic(link, { model: 'opus' });

    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(JSON.parse(fs.readFileSync(real, 'utf8'))).toEqual({ model: 'opus' });
  });

  it('leaves the original intact and no temp behind when the write fails', () => {
    const file = path.join(tmpDir, 'settings.json');
    fs.writeFileSync(file, '{"keep":true}', 'utf8');
    // A value JSON.stringify refuses to serialize.
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => writeJsonAtomic(file, cyclic)).toThrow();
    expect(fs.readFileSync(file, 'utf8')).toBe('{"keep":true}');
    expect(fs.readdirSync(tmpDir)).toEqual(['settings.json']);
  });

  it('round-trips keys a defensive parser used to delete', () => {
    const file = path.join(tmpDir, 'settings.json');
    const parsed = JSON.parse('{"__proto__":{"a":1},"constructor":2,"model":"opus"}') as Record<string, unknown>;
    writeJsonAtomic(file, parsed);
    const back = fs.readFileSync(file, 'utf8');
    expect(back).toContain('__proto__');
    expect(back).toContain('constructor');
    // And parsing such a file never reaches Object.prototype.
    JSON.parse(back);
    expect(({} as Record<string, unknown>).a).toBeUndefined();
  });
});

describe('copyFileAtomic', () => {
  it('publishes the whole file in one rename', () => {
    const src = path.join(tmpDir, 'src.mjs');
    const dest = path.join(tmpDir, 'out', 'dest.mjs');
    fs.writeFileSync(src, 'console.log(1)\n', 'utf8');
    copyFileAtomic(src, dest);
    expect(fs.readFileSync(dest, 'utf8')).toBe('console.log(1)\n');
    expect(fs.readdirSync(path.dirname(dest))).toEqual(['dest.mjs']);
  });

  it('does not damage the destination when the source is missing', () => {
    const dest = path.join(tmpDir, 'dest.mjs');
    fs.writeFileSync(dest, 'old\n', 'utf8');
    expect(() => copyFileAtomic(path.join(tmpDir, 'nope.mjs'), dest)).toThrow();
    expect(fs.readFileSync(dest, 'utf8')).toBe('old\n');
    expect(fs.readdirSync(tmpDir)).toEqual(['dest.mjs']);
  });
});

describe('resolveWriteTarget', () => {
  it('returns the path unchanged when nothing is there yet', () => {
    const missing = path.join(tmpDir, 'not-yet.json');
    expect(resolveWriteTarget(missing)).toBe(missing);
  });
});

// Windows refuses to rename over a file another process holds open, and both
// destinations here are held open by design: Claude Code reads settings.json,
// and the statusline script runs at input-box frequency. POSIX allows it, so
// no amount of macOS testing reaches this — the injected rename is the only
// way to exercise it off-platform.
describe('renameWithRetry', () => {
  const err = (code: string): NodeJS.ErrnoException =>
    Object.assign(new Error(code), { code });

  it('rides out a transient sharing violation', () => {
    let calls = 0;
    const slept: number[] = [];
    renameWithRetry('a', 'b', {
      rename: () => { calls += 1; if (calls < 3) throw err('EPERM'); },
      sleep: (ms) => slept.push(ms),
    });
    expect(calls).toBe(3);
    expect(slept).toEqual([10, 20]);
  });

  it('gives up rather than spinning, and surfaces the last error', () => {
    let calls = 0;
    expect(() =>
      renameWithRetry('a', 'b', {
        rename: () => { calls += 1; throw err('EBUSY'); },
        sleep: () => { /* no real waiting in tests */ },
        attempts: 4,
      }),
    ).toThrow('EBUSY');
    expect(calls).toBe(4);
  });

  it('does not retry an error that will not clear on its own', () => {
    let calls = 0;
    expect(() =>
      renameWithRetry('a', 'b', {
        rename: () => { calls += 1; throw err('ENOENT'); },
        sleep: () => { throw new Error('should not sleep'); },
      }),
    ).toThrow('ENOENT');
    expect(calls).toBe(1);
  });

  it('is transparent when the rename just works', () => {
    let calls = 0;
    renameWithRetry('a', 'b', { rename: () => { calls += 1; }, sleep: () => { throw new Error('no'); } });
    expect(calls).toBe(1);
  });
});
