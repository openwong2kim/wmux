import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ClaudeConfigLockedError, withClaudeConfigLock } from '../claudeConfigLock';

let dir = '';
let file = '';

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-claude-lock-'));
  file = path.join(dir, '.claude.json');
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** A clock the wait's sleep advances, so a held lock needs no real waiting. */
function fakeClock(): { now: () => number; sleep: (ms: number) => void; slept: () => number } {
  let at = Date.now();
  let slept = 0;
  return { now: () => at, sleep: (ms) => { at += ms; slept += ms; }, slept: () => slept };
}

describe('withClaudeConfigLock', () => {
  it('holds the lock directory while the edit runs and removes it after', () => {
    const seen = withClaudeConfigLock(file, () => fs.statSync(`${file}.lock`).isDirectory());
    expect(seen).toBe(true);
    expect(fs.existsSync(`${file}.lock`)).toBe(false);
  });

  it('lets the lock go when the edit throws', () => {
    expect(() => withClaudeConfigLock(file, () => { throw new Error('boom'); })).toThrow('boom');
    expect(fs.existsSync(`${file}.lock`)).toBe(false);
  });

  it('takes the lock beside the real file of a symlinked config', () => {
    const real = path.join(dir, 'dotfiles', 'claude.json');
    fs.mkdirSync(path.dirname(real));
    fs.writeFileSync(real, '{}');
    fs.symlinkSync(real, file);
    const seen = withClaudeConfigLock(file, () => fs.existsSync(`${fs.realpathSync(real)}.lock`));
    expect(seen).toBe(true);
    expect(fs.existsSync(`${file}.lock`)).toBe(false);
  });

  it('refuses without running the edit while a fresh lock stays held', () => {
    fs.mkdirSync(`${file}.lock`);
    const clock = fakeClock();
    let ran = false;
    expect(() => withClaudeConfigLock(file, () => { ran = true; }, clock)).toThrow(ClaudeConfigLockedError);
    expect(ran).toBe(false);
    expect(clock.slept()).toBeGreaterThan(0);
    expect(clock.slept()).toBeLessThan(10_000);
    expect(fs.existsSync(`${file}.lock`)).toBe(true); // still the holder's
  });

  it('takes the lock as soon as the holder lets it go', () => {
    fs.mkdirSync(`${file}.lock`);
    const clock = fakeClock();
    const sleep = (ms: number): void => {
      clock.sleep(ms);
      fs.rmdirSync(`${file}.lock`);
    };
    expect(withClaudeConfigLock(file, () => 'done', { now: clock.now, sleep })).toBe('done');
  });

  it('takes over a lock left stale by a holder that died', () => {
    fs.mkdirSync(`${file}.lock`);
    const old = new Date(Date.now() - 20_000);
    fs.utimesSync(`${file}.lock`, old, old);
    expect(withClaudeConfigLock(file, () => 'done', fakeClock())).toBe('done');
    expect(fs.existsSync(`${file}.lock`)).toBe(false);
  });

  it('does not delete something other than a lock directory at the lock path', () => {
    fs.writeFileSync(`${file}.lock`, 'not a lock');
    const old = new Date(Date.now() - 20_000);
    fs.utimesSync(`${file}.lock`, old, old);
    expect(() => withClaudeConfigLock(file, () => 'done', fakeClock())).toThrow(ClaudeConfigLockedError);
    expect(fs.readFileSync(`${file}.lock`, 'utf8')).toBe('not a lock');
  });

  it('has no lock to wait for when the folder does not exist yet', () => {
    const missing = path.join(dir, 'not-yet', '.claude.json');
    expect(withClaudeConfigLock(missing, () => 'done')).toBe('done');
    expect(fs.existsSync(path.dirname(missing))).toBe(false);
  });
});
