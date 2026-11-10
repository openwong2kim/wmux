import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { markClaudeOnboardingDone } from '../claudeOnboardingFlag';

let home = '';
let accountsRoot = '';
let configDir = '';
let file = '';

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-onboarding-'));
  accountsRoot = path.join(home, '.wmux', 'accounts');
  configDir = path.join(accountsRoot, 'claude-abc12345');
  fs.mkdirSync(configDir, { recursive: true });
  file = path.join(configDir, '.claude.json');
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

/** A clock the lock's wait advances, so a held lock needs no real waiting. */
function fakeClock(): { now: () => number; sleep: (ms: number) => void } {
  let at = Date.now();
  return { now: () => at, sleep: (ms) => { at += ms; } };
}

describe('markClaudeOnboardingDone', () => {
  it('sets only the onboarding key and keeps the other keys, the indent and a byte order mark', () => {
    fs.writeFileSync(file, '﻿{\n    "userID": "u1",\n    "projects": {\n        "/a": {\n            "allowedTools": []\n        }\n    }\n}\n');
    expect(markClaudeOnboardingDone(configDir, accountsRoot)).toEqual({ ok: true, changed: true });
    const text = fs.readFileSync(file, 'utf8');
    expect(text.charCodeAt(0)).toBe(0xfeff);
    expect(text).toContain('\n    "userID": "u1"');
    expect(JSON.parse(text.slice(1))).toEqual({ userID: 'u1', projects: { '/a': { allowedTools: [] } }, hasCompletedOnboarding: true });
    expect(fs.existsSync(`${file}.lock`)).toBe(false);
    expect(fs.readdirSync(configDir)).toEqual(['.claude.json']);
  });

  it('creates the file when the folder has none, and leaves a set flag alone', () => {
    expect(markClaudeOnboardingDone(configDir, accountsRoot)).toEqual({ ok: true, changed: true });
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ hasCompletedOnboarding: true });
    const before = fs.statSync(file).mtimeMs;
    expect(markClaudeOnboardingDone(configDir, accountsRoot)).toEqual({ ok: true, changed: false });
    expect(fs.statSync(file).mtimeMs).toBe(before);
  });

  it('refuses while Claude Code holds the lock, and writes nothing', () => {
    const original = '{"userID":"u1"}';
    fs.writeFileSync(file, original);
    fs.mkdirSync(`${file}.lock`);
    const res = markClaudeOnboardingDone(configDir, accountsRoot, fakeClock());
    expect(res).toMatchObject({ ok: false, reason: 'locked' });
    expect(fs.readFileSync(file, 'utf8')).toBe(original);
    expect(fs.existsSync(`${file}.lock`)).toBe(true);
  });

  it('refuses a malformed file or one that is not an object, and leaves it untouched', () => {
    for (const original of ['{not json', '[1, 2]', '']) {
      fs.writeFileSync(file, original);
      expect(markClaudeOnboardingDone(configDir, accountsRoot)).toMatchObject({ ok: false, reason: 'malformed' });
      expect(fs.readFileSync(file, 'utf8')).toBe(original);
    }
  });

  it('never edits a folder outside the accounts root, such as the home directory', () => {
    const homeClaudeJson = path.join(home, '.claude.json');
    fs.writeFileSync(homeClaudeJson, '{"userID":"me"}');
    for (const dir of [home, accountsRoot, path.join(home, 'elsewhere'), path.join(accountsRoot, 'missing')]) {
      expect(markClaudeOnboardingDone(dir, accountsRoot)).toMatchObject({ ok: false, reason: 'not_provisioned' });
    }
    expect(fs.readFileSync(homeClaudeJson, 'utf8')).toBe('{"userID":"me"}');
    expect(fs.existsSync(path.join(accountsRoot, '.claude.json'))).toBe(false);
    expect(fs.existsSync(path.join(home, 'elsewhere'))).toBe(false);
  });

  it('refuses a .claude.json that links to another file', () => {
    const homeClaudeJson = path.join(home, '.claude.json');
    fs.writeFileSync(homeClaudeJson, '{"userID":"me"}');
    try {
      fs.symlinkSync(homeClaudeJson, file);
    } catch {
      return; // a file symlink needs a privilege some systems do not grant
    }
    expect(markClaudeOnboardingDone(configDir, accountsRoot)).toMatchObject({ ok: false, reason: 'symlink' });
    expect(fs.readFileSync(homeClaudeJson, 'utf8')).toBe('{"userID":"me"}');
  });
});
