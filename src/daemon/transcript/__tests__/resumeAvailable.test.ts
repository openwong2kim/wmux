import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { claudeHasConversationForCwd } from '../resumeAvailable';

let config: string;
let cwd: string;
const project = (dir: string) => path.join(config, 'projects', dir.replace(/[^A-Za-z0-9]/g, '-'));

beforeEach(() => {
  config = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-claude-config-'));
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-claude-cwd-'));
});
afterEach(() => {
  fs.rmSync(config, { recursive: true, force: true });
  fs.rmSync(cwd, { recursive: true, force: true });
});

describe('claudeHasConversationForCwd', () => {
  it('needs a non-empty transcript in the project Claude keys on the cwd, under its own config root', () => {
    const env = { CLAUDE_CONFIG_DIR: config };
    expect(claudeHasConversationForCwd(cwd, env)).toBe(false);
    fs.mkdirSync(project(cwd), { recursive: true });
    fs.writeFileSync(path.join(project(cwd), 'empty.jsonl'), '');
    fs.writeFileSync(path.join(project(cwd), 'notes.txt'), 'x');
    expect(claudeHasConversationForCwd(cwd, env)).toBe(false);
    // Another directory's conversation does not count.
    fs.mkdirSync(project(path.join(cwd, 'sub')), { recursive: true });
    fs.writeFileSync(path.join(project(path.join(cwd, 'sub')), 'a.jsonl'), '{}\n');
    expect(claudeHasConversationForCwd(cwd, env)).toBe(false);
    fs.writeFileSync(path.join(project(cwd), 'b.jsonl'), '{}\n');
    expect(claudeHasConversationForCwd(cwd, env)).toBe(true);
  });

  it('matches the physical path when the shell reports a logical one', () => {
    if (process.platform === 'win32') return;
    const link = path.join(config, 'link');
    fs.symlinkSync(cwd, link);
    const real = fs.realpathSync(cwd);
    fs.mkdirSync(project(real), { recursive: true });
    fs.writeFileSync(path.join(project(real), 'a.jsonl'), '{}\n');
    expect(claudeHasConversationForCwd(link, { CLAUDE_CONFIG_DIR: config })).toBe(true);
  });
});
