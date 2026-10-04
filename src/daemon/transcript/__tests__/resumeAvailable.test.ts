import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearResumeCache, latestClaudeSessionForCwd, latestResumeSession, RESUME_CACHE_MS } from '../resumeAvailable';

let config: string;
let cwd: string;
const name = (dir: string) => dir.replace(/[^A-Za-z0-9]/g, '-');
const project = (dir: string) => path.join(config, 'projects', name(dir));
const transcript = (dir: string, id: string, body: string, at?: number) => {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${id}.jsonl`);
  fs.writeFileSync(file, body);
  if (at !== undefined) fs.utimesSync(file, at / 1000, at / 1000);
};

beforeEach(() => {
  config = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-claude-config-'));
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-claude-cwd-'));
  clearResumeCache();
});
afterEach(() => {
  fs.rmSync(config, { recursive: true, force: true });
  fs.rmSync(cwd, { recursive: true, force: true });
});

describe('latestClaudeSessionForCwd', () => {
  it('names the newest non-empty transcript in the project Claude keys on the cwd, under its own config root', async () => {
    const env = { CLAUDE_CONFIG_DIR: config };
    expect(await latestClaudeSessionForCwd(cwd, env)).toBeUndefined();
    transcript(project(cwd), 'empty', '');
    fs.writeFileSync(path.join(project(cwd), 'notes.txt'), 'x');
    expect(await latestClaudeSessionForCwd(cwd, env)).toBeUndefined();
    // Another directory's conversation does not count.
    transcript(project(path.join(cwd, 'sub')), 'sub', '{}\n');
    expect(await latestClaudeSessionForCwd(cwd, env)).toBeUndefined();
    transcript(project(cwd), 'old', '{}\n', 1_000_000);
    transcript(project(cwd), 'new', '{}\n', 2_000_000);
    expect(await latestClaudeSessionForCwd(cwd, env)).toBe('new');
  });

  it('matches the physical path when the shell reports a logical one', async () => {
    if (process.platform === 'win32') return;
    const link = path.join(config, 'link');
    fs.symlinkSync(cwd, link);
    transcript(project(fs.realpathSync(cwd)), 'a', '{}\n');
    expect(await latestClaudeSessionForCwd(link, { CLAUDE_CONFIG_DIR: config })).toBe('a');
  });

  it('a path past 200 characters counts only when its transcript records that cwd', async () => {
    const stem = path.join(cwd, 'x'.repeat(210));
    const a = `${stem}-a`;
    const b = `${stem}-b`;
    // Same first 200 characters; only B has a conversation (Claude's hash suffix differs).
    expect(name(a).slice(0, 200)).toBe(name(b).slice(0, 200));
    transcript(path.join(config, 'projects', `${name(b).slice(0, 200)}-1k2j3h`), 'b', `{"type":"summary"}\n{"cwd":${JSON.stringify(b)}}\n`);
    expect(await latestClaudeSessionForCwd(a, { CLAUDE_CONFIG_DIR: config })).toBeUndefined();
    expect(await latestClaudeSessionForCwd(b, { CLAUDE_CONFIG_DIR: config })).toBe('b');
  });
});

describe('latestResumeSession', () => {
  it('reuses a lookup for RESUME_CACHE_MS per agent, cwd and account', async () => {
    const env = { CLAUDE_CONFIG_DIR: config };
    expect(await latestResumeSession('claude', cwd, env, 0)).toBeUndefined();
    transcript(project(cwd), 'a', '{}\n');
    expect(await latestResumeSession('claude', cwd, env, RESUME_CACHE_MS - 1)).toBeUndefined();
    expect(await latestResumeSession('claude', cwd, env, RESUME_CACHE_MS)).toBe('a');
  });
});
