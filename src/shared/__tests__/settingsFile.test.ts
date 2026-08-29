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
import { writeJsonAtomic, copyFileAtomic, resolveWriteTarget } from '../settingsFile';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-settings-file-'));
});
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const modeOf = (p: string): number => fs.statSync(p).mode & 0o777;

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

  it('preserves the mode of an existing config', () => {
    const file = path.join(tmpDir, 'settings.json');
    fs.writeFileSync(file, '{}', 'utf8');
    fs.chmodSync(file, 0o600);
    writeJsonAtomic(file, { env: { ANTHROPIC_API_KEY: 'secret' } });
    expect(modeOf(file)).toBe(0o600);
  });

  it('creates a new config owner-only', () => {
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
