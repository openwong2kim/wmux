import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { claudeLaunchedInBypass, commandLineBinding, paneRunsBypassClaude, RESUME_BINDING_TS_SKEW_MS, sessionFromCommandLine, settleStoppedBinding, withCaptureTsNotAhead } from '../agentCommandLineBinding';
import { MAX_PROJECT_DIRS } from '../TranscriptDiscovery';
import { toResumeCommand } from '../../../shared/agentResume';

const ID = '0199a1b2-3c4d-7e5f-8a9b-0c1d2e3f4a5b';
const UP = ID.toUpperCase();
const OTHER = '11111111-2222-4333-8444-555555555555';

describe('sessionFromCommandLine — codex (subcommand form)', () => {
  it.each([
    ['codex resume <id>', `codex resume ${ID}`],
    ['native binary path', `/opt/homebrew/lib/node_modules/@openai/codex/vendor/aarch64-apple-darwin/codex/codex resume ${ID}`],
    ['node + codex.js (POSIX)', `node /usr/local/lib/node_modules/@openai/codex/bin/codex.js resume ${ID}`],
    ['node.exe + codex.js (Windows, quoted)', `"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\John Doe\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\bin\\codex.js" resume ${ID}`],
    ['codex.exe', `C:\\tools\\codex.exe resume ${ID}`],
    ['global options before the subcommand', `codex -c model=o3 --model gpt-5 resume ${ID}`],
    ['relay flags before the id', `codex resume --remote unix:///tmp/r.sock --cd /work/repo ${ID}`],
    ['a --cd value that looks like an id is skipped', `codex resume --cd ${OTHER} ${ID}`],
    ['a quoted Windows --cd with a space', `"C:\\Program Files\\nodejs\\node.exe" "C:\\npm\\node_modules\\@openai\\codex\\bin\\codex.js" --cd "C:\\Users\\John Doe\\repo" resume --cd "C:\\Users\\John Doe" ${ID}`],
    ['global -c value before the subcommand', `codex -c model="o3" resume ${ID}`],
    ['a variadic -i before the next option', `codex resume -i a.png b.png --model gpt-5 ${ID}`],
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
    ['a runtime script that is not codex', `node other.js resume ${ID}`],
    ['a quoted subcommand (a prompt)', `codex "resume ${ID}"`],
    ['a quoted id', `codex resume "${ID}"`],
    ['an id after --', `codex resume -- ${ID}`],
    ['a prompt before the subcommand', `codex fix resume ${ID}`],
    // cmd.exe is the wrapper, never the pid the tracker attributes to the agent; its line names nothing.
    ['the cmd /c wrapper', `C:\\WINDOWS\\system32\\cmd.exe /d /s /c ""C:\\Users\\me\\AppData\\Roaming\\npm\\codex.cmd" resume ${ID}"`],
    ['an id-looking --cd and no id', `codex resume --cd ${ID}`],
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
    ['after other leading options', `claude --dangerously-skip-permissions --model opus --add-dir /a /b --resume ${ID}`],
  ])('resume: %s', (_name, line) => {
    expect(sessionFromCommandLine('claude', line)).toEqual({ sessionId: ID, kind: 'resume' });
  });

  it('a wmux pin is a pin', () => {
    expect(sessionFromCommandLine('claude', `claude --session-id ${ID} --model opus`)).toEqual({ sessionId: ID, kind: 'pin' });
    expect(sessionFromCommandLine('claude', `claude --session-id=${ID}`)).toEqual({ sessionId: ID, kind: 'pin' });
  });

  it('a pin wins over a resume, also with --fork-session', () => {
    expect(sessionFromCommandLine('claude', `claude --resume ${OTHER} --session-id ${ID}`)).toEqual({ sessionId: ID, kind: 'pin' });
    expect(sessionFromCommandLine('claude', `claude --resume ${OTHER} --fork-session --session-id ${ID}`)).toEqual({ sessionId: ID, kind: 'pin' });
  });

  // A first prompt must never name the conversation. On macOS/Linux ps drops the
  // quotes, so these read as the unquoted forms; Windows keeps double quotes.
  it.each([
    ['ps form of a quoted prompt after --', `claude --session-id ${ID} -- --resume ${OTHER}`],
    ['Windows form of a quoted prompt after --', `claude --session-id ${ID} -- "--resume ${OTHER}"`],
    ['a --fork-session inside the prompt', `claude --session-id ${ID} -- --fork-session`],
  ])('the pin survives %s', (_name, line) => {
    expect(sessionFromCommandLine('claude', line)).toEqual({ sessionId: ID, kind: 'pin' });
  });

  it.each([
    ['--continue', 'claude --continue'],
    ['the bare picker', 'claude --resume'],
    ['a picker search term', 'claude --resume my-feature'],
    ['a fork names a new id', `claude --resume ${ID} --fork-session`],
    ['a fresh launch', 'claude'],
    ['a resume inside the prompt after --', `claude -- --resume ${ID}`],
    ['a resume inside a quoted prompt', `claude "--resume ${ID}"`],
    ['a resume after the first positional', `claude fix it --resume ${ID}`],
    ['a quoted id', `claude --resume "${ID}"`],
    ['a picker term, then a prompt', `claude --resume term --model opus ${ID}`],
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
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('binds a resumed Codex thread whose rollout exists (#1891)', () => {
    // A UUIDv7 thread lives in the local-date folder of its creation time.
    const at = new Date(parseInt(ID.replace(/-/g, '').slice(0, 12), 16));
    const pad = (n: number) => String(n).padStart(2, '0');
    const dir = path.join(home, 'sessions', String(at.getFullYear()), pad(at.getMonth() + 1), pad(at.getDate()));
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `rollout-2025-10-01T10-00-00-${ID}.jsonl`);
    fs.writeFileSync(file, '{}\n');
    const b = commandLineBinding('codex', `codex resume ${ID}`, '/work', { CODEX_HOME: home }, { now: 42 });
    expect(b).toEqual({ agent: 'codex', sessionId: ID, cwd: '/work', transcriptPath: expect.stringContaining(`-${ID}.jsonl`), ts: 42 });
  });

  it('refuses a resumed id with no transcript', () => {
    expect(commandLineBinding('codex', `codex resume ${ID}`, '/work', { CODEX_HOME: home })).toBeUndefined();
    expect(commandLineBinding('claude', `claude --resume ${ID}`, '/work', { CLAUDE_CONFIG_DIR: home })).toBeUndefined();
  });

  it('binds the copy in the account the pane runs on, not the original in the default root (#2510)', () => {
    // After Continue on another account the pane runs `claude --resume <id>`
    // with CLAUDE_CONFIG_DIR set to the new account, and the id's transcript is
    // under both the default root (where it was) and the account (the copy).
    vi.stubEnv('CLAUDE_CONFIG_DIR', '');
    const user = path.join(home, 'user');
    vi.spyOn(os, 'homedir').mockReturnValue(user);
    const account = path.join(home, 'account-b');
    for (const dir of [path.join(user, '.claude', 'projects', '-work'), path.join(account, 'projects', '-work')]) {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `${ID}.jsonl`), '{}\n');
    }
    const b = commandLineBinding('claude', `claude --resume ${ID}`, '/work', { CLAUDE_CONFIG_DIR: account }, { now: 7 });
    expect(b?.transcriptPath).toBe(path.join(account, 'projects', '-work', `${ID}.jsonl`));
  });

  it('binds a resumed Claude conversation by its transcript name', () => {
    const dir = path.join(home, 'projects', '-work');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${ID}.jsonl`), '{}\n');
    const b = commandLineBinding('claude', `claude --resume ${ID}`, '/work', { CLAUDE_CONFIG_DIR: home }, { now: 7 });
    expect(b?.sessionId).toBe(ID);
    expect(b?.transcriptPath).toContain(`${ID}.jsonl`);
  });

  it('binds a pinned fresh Claude without a transcript yet', () => {
    expect(commandLineBinding('claude', `claude --session-id ${ID}`, '/work', { CLAUDE_CONFIG_DIR: home }, { now: 7 }))
      .toEqual({ agent: 'claude', sessionId: ID, cwd: '/work', ts: 7 });
  });

  it('never binds without a folder', () => {
    expect(commandLineBinding('claude', `claude --session-id ${ID}`, '', { CLAUDE_CONFIG_DIR: home })).toBeUndefined();
  });

  // Hooks, the Codex relay and notify are authoritative: the command line never
  // replaces what one of them bound during this run, and loses to a later one.
  describe('precedence against hook / relay / notify bindings', () => {
    const LAUNCH = 1_000_000;
    const pinned = `claude --session-id ${ID}`;
    const env = () => ({ CLAUDE_CONFIG_DIR: home });
    const hook = (ts: number) => ({ agent: 'claude', sessionId: OTHER, cwd: '/work', transcriptPath: '/t.jsonl', ts });

    it('is stamped with the launch time, so any capture made during the run is newer', () => {
      const b = commandLineBinding('claude', pinned, '/work', env(), { launchAt: LAUNCH, now: LAUNCH + 5_000 });
      expect(b?.ts).toBe(LAUNCH);
      // The daemon writer drops a capture older than the stored one (ts < prev.ts):
      // a hook landing after this binding (ts > LAUNCH) replaces it, never the reverse.
      expect(b!.ts).toBeLessThan(hook(LAUNCH + 1).ts);
    });

    it('never replaces a binding captured during this run', () => {
      expect(commandLineBinding('claude', pinned, '/work', env(), { launchAt: LAUNCH, prev: hook(LAUNCH + 200) })).toBeUndefined();
      expect(commandLineBinding('claude', pinned, '/work', env(), { launchAt: LAUNCH, prev: hook(LAUNCH) })).toBeUndefined();
    });

    it('replaces a binding left by an earlier run', () => {
      expect(commandLineBinding('claude', pinned, '/work', env(), { launchAt: LAUNCH, prev: hook(LAUNCH - 60_000) }))
        .toEqual({ agent: 'claude', sessionId: ID, cwd: '/work', ts: LAUNCH });
    });

    it('with no launch time, binds only a pane that holds nothing', () => {
      expect(commandLineBinding('claude', pinned, '/work', env(), { prev: hook(1) })).toBeUndefined();
      expect(commandLineBinding('claude', pinned, '/work', env(), { now: 9 })?.ts).toBe(9);
    });
  });
});

// A pinned Claude that stopped before its first turn wrote no conversation:
// recovery must not offer `claude --resume <pin>` ("No conversation found").
describe('settleStoppedBinding — a stopped agent writes nothing more', () => {
  let home: string;
  beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-settle-')); });
  afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); });
  const pinned = { agent: 'claude', sessionId: ID, cwd: '/work', ts: 7 };

  it('drops a path-less binding whose conversation was never written', () => {
    expect(settleStoppedBinding(pinned, { CLAUDE_CONFIG_DIR: home })).toBeNull();
    expect(settleStoppedBinding({ ...pinned, agent: 'codex' }, { CODEX_HOME: home })).toBeNull();
  });

  it('adopts the transcript a path-less binding names', () => {
    const dir = path.join(home, 'projects', '-work');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${ID}.jsonl`), '{}\n');
    const settled = settleStoppedBinding(pinned, { CLAUDE_CONFIG_DIR: home });
    expect(settled).toEqual({ ...pinned, transcriptPath: expect.stringContaining(`${ID}.jsonl`) });
  });

  it('leaves a binding with a path, or of an agent without file transcripts, as it is', () => {
    const withPath = { ...pinned, transcriptPath: path.join(home, 'gone.jsonl') };
    expect(settleStoppedBinding(withPath, { CLAUDE_CONFIG_DIR: home })).toBe(withPath);
    const other = { ...pinned, agent: 'gemini' };
    expect(settleStoppedBinding(other, { CLAUDE_CONFIG_DIR: home })).toBe(other);
  });

  it('drops an empty transcript: a 0-byte file holds no conversation to resume', () => {
    const dir = path.join(home, 'projects', '-work');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${ID}.jsonl`), '');
    expect(settleStoppedBinding(pinned, { CLAUDE_CONFIG_DIR: home })).toBeNull();
    // A resume named on the command line does not bind to it either.
    expect(commandLineBinding('claude', `claude --resume ${ID}`, '/work', { CLAUDE_CONFIG_DIR: home })).toBeUndefined();
  });

  it('keeps the binding when the scan could not finish, dropping only on certain absence', () => {
    const projects = path.join(home, 'projects');
    // More project folders than one scan examines: the id could sit past the bound.
    for (let i = 0; i < MAX_PROJECT_DIRS + 1; i++) fs.mkdirSync(path.join(projects, `p${String(i).padStart(4, '0')}`), { recursive: true });
    expect(settleStoppedBinding(pinned, { CLAUDE_CONFIG_DIR: home })).toBe(pinned);
  });

  // The exec relaunch reads the settled binding: a pin that never got a turn
  // relaunches fresh, never as `--resume <dead id>`.
  it('an exec relaunch of a never-written pin starts fresh', () => {
    const line = `claude --session-id ${ID} --model opus`;
    const settled = settleStoppedBinding(pinned, { CLAUDE_CONFIG_DIR: home }) ?? undefined;
    expect(toResumeCommand(line, settled, '/work')).toBe('claude --model opus');
    const dir = path.join(home, 'projects', '-work');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${ID}.jsonl`), '{}\n');
    const written = settleStoppedBinding(pinned, { CLAUDE_CONFIG_DIR: home }) ?? undefined;
    expect(toResumeCommand(line, written, '/work')).toBe(`claude --resume ${ID} --model opus`);
  });
});

// Qwen Code keeps `<QWEN_HOME>/projects/<project>/chats/<id>.jsonl`; Kimi Code
// is resumed only through its own picker, so no id is ever taken from its line.
describe('qwen and kimi', () => {
  let home: string;
  beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-qwen-')); });
  afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); });
  const chat = (project: string, id = ID, body = '{}\n') => {
    const dir = path.join(home, 'projects', project, 'chats');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${id}.jsonl`), body);
    return path.join(dir, `${id}.jsonl`);
  };

  it('reads a qwen pin or resume, skipping one-shot and option values', () => {
    expect(sessionFromCommandLine('qwen', `qwen --session-id ${ID}`)).toEqual({ sessionId: ID, kind: 'pin' });
    expect(sessionFromCommandLine('qwen', `qwen -m qwen3-coder -p "go" --resume ${ID}`)).toEqual({ sessionId: ID, kind: 'resume' });
    expect(sessionFromCommandLine('qwen', 'qwen --resume')).toBeUndefined();
    expect(sessionFromCommandLine('kimi', 'kimi --session 01HZX3K8Q2VJ7N5R9T4W6Y0ABC')).toBeUndefined();
    expect(sessionFromCommandLine('kimi', `kimi --session ${ID}`)).toBeUndefined();
  });

  it('binds a pinned qwen launch, and a resume only when its conversation is in this account', () => {
    const env = { QWEN_HOME: home };
    expect(commandLineBinding('qwen', `qwen --session-id ${ID}`, '/work', env, { now: 7 }))
      .toEqual({ agent: 'qwen', sessionId: ID, cwd: '/work', ts: 7 });
    expect(commandLineBinding('qwen', `qwen --resume ${ID}`, '/work', env)).toBeUndefined();
    const file = chat('-work');
    expect(commandLineBinding('qwen', `qwen --resume ${ID}`, '/work', env, { now: 7 })?.transcriptPath).toBe(file);
  });

  it('binds none of several copies of one conversation, and keeps a stopped pin while they are there', () => {
    chat('-work');
    chat('-work-copy');
    const env = { QWEN_HOME: home };
    expect(commandLineBinding('qwen', `qwen --resume ${ID}`, '/work', env)).toBeUndefined();
    const pinned = { agent: 'qwen', sessionId: ID, cwd: '/work', ts: 7 };
    expect(settleStoppedBinding(pinned, env)).toBe(pinned);
  });

  it('settles a stopped qwen pin: dropped while unwritten, adopted once written', () => {
    const pinned = { agent: 'qwen', sessionId: ID, cwd: '/work', ts: 7 };
    expect(settleStoppedBinding(pinned, { QWEN_HOME: home })).toBeNull();
    const file = chat('-work');
    expect(settleStoppedBinding(pinned, { QWEN_HOME: home })).toEqual({ ...pinned, transcriptPath: file });
  });
});

describe('claudeLaunchedInBypass — the live process argv', () => {
  it.each([
    ['the skip flag', 'claude --dangerously-skip-permissions'],
    ['--permission-mode bypassPermissions', 'claude --permission-mode bypassPermissions'],
    ['--permission-mode=bypassPermissions', 'claude --permission-mode=bypassPermissions'],
    ['under node, after value options', `node /usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js --model opus --dangerously-skip-permissions --resume ${ID}`],
    ['a later mode wins', 'claude --permission-mode auto --dangerously-skip-permissions'],
  ])('bypass: %s', (_why, line) => {
    expect(claudeLaunchedInBypass(line)).toBe(true);
  });

  it.each([
    ['no flag (a resume without it)', `claude --resume ${ID}`],
    ['another mode', 'claude --permission-mode auto'],
    ['a later mode wins', 'claude --dangerously-skip-permissions --permission-mode plan'],
    ['the flag after --', 'claude -- --dangerously-skip-permissions'],
    ['the flag after the prompt', 'claude fix --dangerously-skip-permissions'],
    ['the flag as a value', 'claude --append-system-prompt --dangerously-skip-permissions'],
    ['a quoted flag', 'claude "--dangerously-skip-permissions"'],
    ['another agent', 'codex --dangerously-bypass-approvals-and-sandbox'],
    ['an unreadable line', undefined],
  ])('not bypass: %s', (_why, line) => {
    expect(claudeLaunchedInBypass(line)).toBe(false);
  });
});

describe('paneRunsBypassClaude — inheritance reads process truth', () => {
  const START = 1_000_000;
  const fact = { pid: 42, startedAt: START, bypass: true };
  const alive = { alive: true, slug: 'claude' };
  const binding = (mode: string | undefined, ts = START + 10) =>
    ({ agent: 'claude', sessionId: ID, cwd: '/w', ts, ...(mode ? { permissionMode: mode } : {}) }) as never;

  it('a bypass launch still reporting bypass inherits', () => {
    expect(paneRunsBypassClaude(fact, alive, 42, binding('bypassPermissions'))).toBe(true);
  });

  it.each([
    ['resumed without the flag', { ...fact, bypass: false }, alive, 42, binding('bypassPermissions')],
    ['switched out of bypass since launch', fact, alive, 42, binding('auto')],
    ['a bypass binding from before this launch', fact, alive, 42, binding('bypassPermissions', START - 1)],
    ['another process than the one read', fact, alive, 43, binding('bypassPermissions')],
    ['an unknown start time', { pid: 42, bypass: true }, alive, 42, binding('bypassPermissions')],
    ['no line read (a WSL pane)', undefined, alive, 42, binding('bypassPermissions')],
    ['a dead process', fact, { alive: false, slug: 'claude' }, 42, binding('bypassPermissions')],
    ['another agent', fact, { alive: true, slug: 'codex' }, 42, binding('bypassPermissions')],
  ])('%s does not', (_why, f, tracked, pid, b) => {
    expect(paneRunsBypassClaude(f, tracked, pid, b)).toBe(false);
  });
});

describe('withCaptureTsNotAhead — a capture cannot be dated ahead', () => {
  const NOW = 2_000_000;
  const at = (ts: number) => ({ agent: 'claude', sessionId: ID, cwd: '/w', ts });

  it('clamps a far-future ts to now', () => {
    expect(withCaptureTsNotAhead(at(NOW + 365 * 86_400_000), NOW).ts).toBe(NOW);
  });

  it('keeps a ts within the skew, and one in the past', () => {
    const near = at(NOW + RESUME_BINDING_TS_SKEW_MS);
    expect(withCaptureTsNotAhead(near, NOW)).toBe(near);
    const past = at(NOW - 1);
    expect(withCaptureTsNotAhead(past, NOW)).toBe(past);
  });
});
