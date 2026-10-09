import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { commandLineBinding, sessionFromCommandLine } from '../agentCommandLineBinding';

const ID = '0199a1b2-3c4d-7e5f-8a9b-0c1d2e3f4a5b';
const UP = ID.toUpperCase();

describe('sessionFromCommandLine — codex (subcommand form)', () => {
  it.each([
    ['codex resume <id>', `codex resume ${ID}`],
    ['native binary path', `/opt/homebrew/lib/node_modules/@openai/codex/vendor/aarch64-apple-darwin/codex/codex resume ${ID}`],
    ['node + codex.js (POSIX)', `node /usr/local/lib/node_modules/@openai/codex/bin/codex.js resume ${ID}`],
    ['node.exe + codex.js (Windows, quoted)', `"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\John Doe\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\bin\\codex.js" resume ${ID}`],
    ['cmd /c with nested quotes', `C:\\WINDOWS\\system32\\cmd.exe /d /s /c ""C:\\Users\\me\\AppData\\Roaming\\npm\\codex.cmd" resume ${ID}"`],
    ['codex.exe', `C:\\tools\\codex.exe resume ${ID}`],
    ['global options before the subcommand', `codex -c model=o3 --model gpt-5 resume ${ID}`],
    ['relay flags before the id', `codex resume --remote unix:///tmp/r.sock --cd /work/repo ${ID}`],
    ['a prompt after the id', `codex resume ${ID} keep going`],
    ['upper-case id is lowered', `codex resume ${UP}`],
  ])('%s', (_name, line) => {
    expect(sessionFromCommandLine('codex', line)).toEqual({ sessionId: ID, kind: 'resume' });
  });

  it.each([
    ['--last', `codex resume --last`],
    ['--last with an id-shaped prompt', `codex resume --last ${ID}`],
    ['the bare picker', 'codex resume'],
    ['a fresh launch', 'codex'],
    ['a prompt that says resume', `codex fix the resume of ${ID}`],
    ['another subcommand', `codex fork ${ID}`],
    ['not a uuid', 'codex resume abc'],
    ['no launcher', `node other.js resume ${ID}`],
  ])('names nothing: %s', (_name, line) => {
    expect(sessionFromCommandLine('codex', line)).toBeUndefined();
  });
});

describe('sessionFromCommandLine — claude (flag form)', () => {
  it.each([
    ['--resume <id>', `claude --resume ${ID}`],
    ['--resume=<id>', `claude --resume=${ID}`],
    ['npm cli.js', `node /usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js --model opus --resume ${ID}`],
    ['Windows native exe', `"C:\\Users\\me\\.local\\bin\\claude.exe" --resume ${UP}`],
    ['cmd /c', `cmd.exe /d /s /c "claude --resume ${ID}"`],
  ])('resume: %s', (_name, line) => {
    expect(sessionFromCommandLine('claude', line)).toEqual({ sessionId: ID, kind: 'resume' });
  });

  it('a wmux pin is a pin', () => {
    expect(sessionFromCommandLine('claude', `claude --session-id ${ID} --model opus`)).toEqual({ sessionId: ID, kind: 'pin' });
    expect(sessionFromCommandLine('claude', `claude --session-id=${ID}`)).toEqual({ sessionId: ID, kind: 'pin' });
  });

  it.each([
    ['--continue', 'claude --continue'],
    ['the bare picker', 'claude --resume'],
    ['a picker search term', 'claude --resume my-feature'],
    ['a fork names a new id', `claude --resume ${ID} --fork-session`],
    ['a fresh launch', 'claude'],
  ])('names nothing: %s', (_name, line) => {
    expect(sessionFromCommandLine('claude', line)).toBeUndefined();
  });

  it('an agent wmux cannot resume names nothing', () => {
    expect(sessionFromCommandLine('gemini', `gemini --resume ${ID}`)).toBeUndefined();
    expect(sessionFromCommandLine('codex', undefined)).toBeUndefined();
  });
});

describe('commandLineBinding — validates against the exact transcript', () => {
  let home: string;
  beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-cmdline-')); });
  afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); });

  it('binds a resumed Codex thread whose rollout exists (#1891)', () => {
    // A UUIDv7 thread lives in the local-date folder of its creation time.
    const at = new Date(parseInt(ID.replace(/-/g, '').slice(0, 12), 16));
    const pad = (n: number) => String(n).padStart(2, '0');
    const dir = path.join(home, 'sessions', String(at.getFullYear()), pad(at.getMonth() + 1), pad(at.getDate()));
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `rollout-2025-10-01T10-00-00-${ID}.jsonl`);
    fs.writeFileSync(file, '{}\n');
    const b = commandLineBinding('codex', `codex resume ${ID}`, '/work', { CODEX_HOME: home }, 42);
    expect(b).toEqual({ agent: 'codex', sessionId: ID, cwd: '/work', transcriptPath: expect.stringContaining(`-${ID}.jsonl`), ts: 42 });
  });

  it('refuses a resumed id with no transcript', () => {
    expect(commandLineBinding('codex', `codex resume ${ID}`, '/work', { CODEX_HOME: home })).toBeUndefined();
    expect(commandLineBinding('claude', `claude --resume ${ID}`, '/work', { CLAUDE_CONFIG_DIR: home })).toBeUndefined();
  });

  it('binds a resumed Claude conversation by its transcript name', () => {
    const dir = path.join(home, 'projects', '-work');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${ID}.jsonl`), '{}\n');
    const b = commandLineBinding('claude', `claude --resume ${ID}`, '/work', { CLAUDE_CONFIG_DIR: home }, 7);
    expect(b?.sessionId).toBe(ID);
    expect(b?.transcriptPath).toContain(`${ID}.jsonl`);
  });

  it('binds a pinned fresh Claude without a transcript yet', () => {
    expect(commandLineBinding('claude', `claude --session-id ${ID}`, '/work', { CLAUDE_CONFIG_DIR: home }, 7))
      .toEqual({ agent: 'claude', sessionId: ID, cwd: '/work', ts: 7 });
  });

  it('never binds without a folder', () => {
    expect(commandLineBinding('claude', `claude --session-id ${ID}`, '', { CLAUDE_CONFIG_DIR: home })).toBeUndefined();
  });
});
