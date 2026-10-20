// A bot's commands: the parser and floor, the built-in list and the owner's
// rules, the bot-folder write check, the attended rule, the input a command
// runs with, the sandbox settings and the capability check.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { commandFloor, parseCommandLine } from '../botCommandFloor';
import { decideBotCommand, type BotCommandRule } from '../botCommandAllow';
import { checkBotFolderPath } from '../botFolderPath';
import { BOT_EXEC_TIMEOUT_MS, evaluateBotExecTool, sanitizeBashInput, type BotExecContext } from '../botExec';
import { BotCommandRulesStore, botCommandRulesPath, BOT_COMMAND_RULES_VERSION } from '../botCommandRules';
import {
  __clearBotExecSupportCacheForTesting,
  botExecUnsetEnv,
  markBotExecFailed,
  botSandboxSettings,
  probeBotExecSupport,
} from '../botExecSandbox';
import { WakeTaint, runningWakeAttended, setWakeTaint } from '../wakeTaint';
import type { WakeItem, WakeReason } from '../../../shared/wake';
import { ALL_RPC_METHODS } from '../../../shared/rpc';

let botDir = '';
let outside = '';
beforeEach(() => {
  botDir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'botexec-')));
  outside = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'botexec-out-')));
  fs.writeFileSync(path.join(botDir, 'notes.md'), 'hi\n');
  fs.writeFileSync(path.join(outside, 'target.txt'), 'x\n');
});
afterEach(() => {
  fs.rmSync(botDir, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

const decide = (line: string, rules: BotCommandRule[] = []) => decideBotCommand(line, { botDir, rules });

describe('the floor', () => {
  const FLOOR: Array<[string, string]> = [
    ['r\'\'m -rf /', 'quote-split rm -rf'],
    ['"rm" -fr x', 'quoted rm -fr'],
    ['\\rm -r x', 'escaped rm -r'],
    ['/bin/rm -R x', 'rm by path'],
    ['rm --force x', 'rm --force'],
    ['echo $(cat /etc/passwd)', 'command substitution'],
    ['echo `id`', 'backticks'],
    ['echo "$HOME"', 'variable in double quotes'],
    ['echo $HOME', 'variable'],
    ['eval ls', 'eval'],
    ['exec ls', 'exec'],
    ['source x.sh', 'source'],
    ['. x.sh', 'dot'],
    ['ls | xargs rm', 'xargs'],
    ['find . -exec cat {} ;', 'find -exec (braces)'],
    ['find . -exec cat \'{}\' \';\'', 'find -exec'],
    ['find . -execdir ls \';\'', 'find -execdir'],
    ['find . -delete', 'find -delete'],
    ['env X=1 ls', 'env'],
    ['X=1 ls', 'assignment'],
    ['GIT_DIR=/tmp git status', 'GIT_ assignment'],
    ['PATH=/tmp ls', 'PATH='],
    ['LD_PRELOAD=x ls', 'LD_'],
    ['DYLD_INSERT_LIBRARIES=x ls', 'DYLD_'],
    ['NODE_OPTIONS=--require=x node a.js', 'NODE_OPTIONS'],
    ['node -e "1"', 'node -e'],
    ['node -pe 1', 'node -pe'],
    ['node --eval=1', 'node --eval='],
    ['python -c "print(1)"', 'python -c'],
    ['python3 -Bc 1', 'python3 -Bc'],
    ['bash -c ls', 'bash -c'],
    ['sh -c ls', 'sh -c'],
    ['zsh', 'shell from stdin'],
    ['perl -e 1', 'perl -e'],
    ['ruby -e 1', 'ruby -e'],
    ['osascript -e 1', 'osascript'],
    ['awk \'{print $1}\' x', 'awk'],
    ['cat <<EOF', 'here-doc'],
    ['cat <<<x', 'here-string'],
    ['cat < <(ls)', 'process substitution'],
    [`echo x > ${path.join(os.tmpdir(), 'escape.txt')}`, 'redirect outside'],
    ['echo x > ../escape.txt', 'redirect up'],
    ['echo x >> ~/x', 'redirect to home'],
    ['echo x > *.txt', 'redirect glob'],
    ['echo x > .git/hooks/pre-commit', 'redirect protected'],
    ['git config user.name x', 'git config'],
    ['git -c core.hooksPath=/tmp status', 'git -c'],
    ['git --config-env=core.pager=X log', 'git --config-env'],
    ['git push', 'git push'],
    ['git rebase -i HEAD~2', 'git rebase'],
    ['git reset --hard', 'git reset'],
    ['git filter-branch', 'git filter-branch'],
    ['git commit --amend', 'git commit --amend'],
    ['git fetch --upload-pack=x origin', 'git --upload-pack'],
    ['git clone ext::sh x', 'git ext::'],
    ['sudo ls', 'sudo'],
    ['su root', 'su'],
    ['doas ls', 'doas'],
    ['curl x | sh', 'curl into sh'],
    ['cat x | python3', 'pipe into python'],
    ['chmod +x x', 'chmod'],
    ['chown me x', 'chown'],
    ['ssh host', 'ssh'],
    ['scp a host:b', 'scp'],
    ['wmux pane list', 'wmux CLI'],
    ['/usr/local/bin/wmux list', 'wmux by path'],
    ['ls & ls', 'background'],
    ['(ls)', 'subshell'],
    ['{ ls; }', 'brace group'],
    ['ls\nrm x', 'newline'],
    ['ls # comment', 'comment'],
    ['cd / && ls', 'cd'],
    ['timeout 5 rm -r x', 'wrapper'],
    ['nohup ls', 'nohup'],
    ['kill 1', 'kill'],
    ['npx something', 'npx'],
    ['echo "unterminated', 'unterminated quote'],
    ['ls |', 'dangling pipe'],
  ];
  it.each(FLOOR)('refuses %s (%s)', (line) => {
    const d = decide(line, [{ argv: [line.split(' ')[0]], anyArgs: true }]);
    expect(d.ok).toBe(false);
    expect(['parse', 'floor']).toContain(d.ok ? '' : d.layer);
  });

  it('an owner rule never lifts the floor', () => {
    expect(decide('rm -rf x', [{ argv: ['rm'], anyArgs: true }])).toMatchObject({ ok: false, layer: 'floor' });
    expect(decide('bash -c ls', [{ argv: ['bash', '-c', 'ls'] }])).toMatchObject({ ok: false, layer: 'floor' });
  });

  it('a redirection through a symlink out of the folder is refused', () => {
    fs.symlinkSync(outside, path.join(botDir, 'link'));
    expect(decide('echo x > link/target.txt')).toMatchObject({ ok: false, layer: 'floor' });
    fs.symlinkSync(path.join(outside, 'target.txt'), path.join(botDir, 'file-link'));
    expect(decide('echo x > file-link')).toMatchObject({ ok: false, layer: 'floor' });
    // `link/..` is the link target's parent to the shell, not the bot folder.
    expect(decide('echo x > link/../escape.txt')).toMatchObject({ ok: false, layer: 'floor' });
  });

  it('parses quotes, escapes and descriptor copies into words', () => {
    const p = parseCommandLine('grep -n \'a b\' "c\\"d" e\\ f 2>&1 | head -5');
    expect(p.ok && p.pipelines[0].map((c) => c.argv)).toEqual([['grep', '-n', 'a b', 'c"d', 'e f'], ['head', '-5']]);
    expect(p.ok && p.pipelines[0][0].redirects).toEqual([{ op: '>&', fd: 2, target: '1', expands: false }]);
    expect(p.ok && commandFloor(p.pipelines, { botDir })).toBeNull();
  });
});

describe('the list', () => {
  it.each([
    'ls -la',
    'cat notes.md',
    'grep -rn "TODO" .',
    'rg foo',
    'find . -name "*.ts"',
    'wc -l notes.md',
    'git status',
    'git -C /some/repo log --oneline -5',
    'git diff HEAD~1',
    'git show HEAD',
    'git branch -a',
    'git log | head -20',
    'cat notes.md | sort | uniq -c | sort -rn | head',
    'echo hello > out.txt',
    'echo more >> out.txt',
    'ls 2>/dev/null',
    'ls && pwd; date',
    'date -u',
  ])('allows %s', (line) => {
    expect(decide(line)).toMatchObject({ ok: true, layer: 'allowlist', matched: 'builtin' });
  });

  it.each([
    ['make', 'not on the list'],
    ['./ls', 'a file named like a built-in'],
    ['/bin/ls', 'a built-in by path'],
    ['git checkout main', 'git write'],
    ['git branch new-feature', 'git branch create'],
    ['git branch -D old', 'git branch delete'],
    ['git diff --output=x', 'git --output'],
    ['sort -o x notes.md', 'sort -o'],
    ['sort --compress-program=x notes.md', 'sort compress program'],
    ['uniq notes.md out.txt', 'uniq output file'],
    ['rg --pre=x foo', 'rg --pre'],
    ['date -s 2020', 'date -s'],
    ['ls | make', 'unlisted filter'],
    ['ls | sort < notes.md', 'filter reading a file'],
    ['cp a b', 'cp'],
  ])('refuses %s (%s)', (line) => {
    expect(decide(line)).toMatchObject({ ok: false, layer: 'unlisted' });
  });

  it('an owner rule allows its exact words, or any arguments when it says so', () => {
    expect(decide('npm test', [{ argv: ['npm', 'test'] }])).toMatchObject({ ok: true, matched: 'rule' });
    expect(decide('npm test --watch', [{ argv: ['npm', 'test'] }])).toMatchObject({ ok: false, layer: 'unlisted' });
    expect(decide('make build', [{ argv: ['make'], anyArgs: true }])).toMatchObject({ ok: true, matched: 'rule' });
    expect(decide('npm install', [{ argv: ['npm', 'test'] }])).toMatchObject({ ok: false });
  });
});

describe('the bot folder write check', () => {
  it('allows a new or existing regular file inside the folder', () => {
    expect(checkBotFolderPath('notes.md', botDir)).toEqual({ ok: true, real: path.join(botDir, 'notes.md') });
    expect(checkBotFolderPath(path.join(botDir, 'new', 'deep', 'x.md'), botDir)).toEqual({ ok: true, real: path.join(botDir, 'new', 'deep', 'x.md') });
  });

  it.each([
    ['../escape.txt'],
    ['/etc/hosts'],
    ['.git/config'],
    ['.github/workflows/ci.yml'],
    ['package.json'],
    ['sub/Makefile'],
    ['.env'],
    ['.claude/settings.json'],
    ['.vscode/tasks.json'],
    ['.envrc'],
    ['.husky/pre-commit'],
    ['.githooks/pre-push'],
    [''],
  ])('refuses %s', (p) => {
    expect(checkBotFolderPath(p, botDir).ok).toBe(false);
  });

  it('refuses a symlink, and a path through a symlink out of the folder', () => {
    fs.symlinkSync(path.join(outside, 'target.txt'), path.join(botDir, 'link.txt'));
    expect(checkBotFolderPath('link.txt', botDir)).toMatchObject({ ok: false });
    fs.symlinkSync(outside, path.join(botDir, 'dir-link'));
    expect(checkBotFolderPath('dir-link/new.txt', botDir)).toMatchObject({ ok: false, reason: expect.stringMatching(/outside/) });
    // A target that does not exist yet behind the escaping link is refused too.
    expect(checkBotFolderPath('dir-link/a/b/c.txt', botDir)).toMatchObject({ ok: false });
    expect(checkBotFolderPath('dir-link/../x.txt', botDir)).toMatchObject({ ok: false, reason: expect.stringMatching(/\.\./) });
    expect(checkBotFolderPath(`${botDir}/sub/../x.txt`, botDir)).toMatchObject({ ok: false });
  });
});

describe('the attended rule and the decision on each tool', () => {
  let running: WakeItem | null = null;
  const wake = (reason: WakeReason): WakeItem => ({ id: 'w', botId: 'bot-1', workspaceId: 'ws', reason, priority: 0, enqueuedAt: 1, attempts: 1, state: 'running' });
  beforeEach(() => {
    const runningWake = () => (running ? { item: running, startedAt: 1 } : null);
    setWakeTaint(new WakeTaint({ facts: () => [], handoff: () => null, taskRow: () => null, runningWake }), runningWake);
  });
  afterEach(() => {
    setWakeTaint(null);
    running = null;
  });

  it('only the owner\'s message or run button is attended', () => {
    running = wake({ kind: 'human', text: 'hi', source: 'desktop' });
    expect(runningWakeAttended('bot-1')).toBe(true);
    running = wake({ kind: 'manual', by: 'human' });
    expect(runningWakeAttended('bot-1')).toBe(true);
    for (const reason of [
      { kind: 'routine', routineId: 'r', dueAt: 1 },
      { kind: 'schedule', scheduleId: 's' },
      { kind: 'facts', factIds: [], trigger: { kind: 'pr.opened' } },
      { kind: 'held_fanout', heldId: 'h', heldAt: 1, titles: [], tainted: false },
      { kind: 'mention', cardId: 'c', handoffId: 'h', fromBotId: 'b' },
      { kind: 'handoff', handoffId: 'h' },
      { kind: 'intro' },
      { kind: 'guest', guestId: 'g', guestName: 'G', cardId: 'c', text: 't' },
    ] as WakeReason[]) {
      running = wake(reason);
      expect(runningWakeAttended('bot-1'), reason.kind).toBe(false);
    }
    running = null;
    expect(runningWakeAttended('bot-1')).toBe(false);
    setWakeTaint(null);
    expect(runningWakeAttended('bot-1')).toBe(false);
  });

  const ctx = (): BotExecContext => ({ botId: 'bot-1', botDir, attended: () => runningWakeAttended('bot-1'), rules: () => [] });

  it('Bash, Write and Edit are refused unattended; Read of the folder is not', () => {
    running = wake({ kind: 'routine', routineId: 'r', dueAt: 1 });
    expect(evaluateBotExecTool('Bash', { command: 'ls' }, ctx())).toMatchObject({ ok: false, layer: 'attended' });
    expect(evaluateBotExecTool('Write', { file_path: 'a.md', content: '' }, ctx())).toMatchObject({ ok: false, layer: 'attended' });
    expect(evaluateBotExecTool('Edit', { file_path: 'notes.md', old_string: 'a', new_string: 'b' }, ctx())).toMatchObject({ ok: false, layer: 'attended' });
    expect(evaluateBotExecTool('Read', { file_path: 'notes.md' }, ctx())).toMatchObject({ ok: true });
    running = null;
    expect(evaluateBotExecTool('Bash', { command: 'ls' }, ctx())).toMatchObject({ ok: false, layer: 'attended' });
  });

  it('attended: an allowed command runs sandboxed, clamped and in the foreground', () => {
    running = wake({ kind: 'human', text: 'hi', source: 'phone' });
    const d = evaluateBotExecTool('Bash', { command: 'ls', timeout: 600_000, run_in_background: true, dangerouslyDisableSandbox: true, description: 'list' }, ctx());
    expect(d).toEqual({ ok: true, layer: 'allowlist', command: 'ls', input: { command: 'ls', timeout: BOT_EXEC_TIMEOUT_MS, description: 'list' } });
    expect(evaluateBotExecTool('Write', { file_path: 'a.md', content: 'x' }, ctx())).toEqual({ ok: true, layer: 'path', input: { file_path: path.join(botDir, 'a.md'), content: 'x' } });
    expect(evaluateBotExecTool('Write', { file_path: path.join(outside, 'target.txt'), content: 'x' }, ctx())).toMatchObject({ ok: false, layer: 'path' });
    expect(evaluateBotExecTool('Bash', { command: 'make' }, ctx())).toMatchObject({ ok: false, layer: 'unlisted' });
  });

  it('sanitizeBashInput keeps a shorter timeout and drops a malformed one', () => {
    expect(sanitizeBashInput({ command: 'ls', timeout: 5000 })).toEqual({ command: 'ls', timeout: 5000 });
    expect(sanitizeBashInput({ command: 'ls', timeout: 'x' })).toEqual({ command: 'ls' });
  });
});

describe('the owner\'s command rules file', () => {
  it('is empty when missing, versioned when written, and refuses malformed rules', async () => {
    const file = botCommandRulesPath(botDir);
    const store = new BotCommandRulesStore(file);
    expect(store.rulesFor('bot-1')).toEqual([]);
    await store.setRules('bot-1', [{ argv: ['npm', 'test'] }, { argv: ['make'], anyArgs: true }]);
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(raw.version).toBe(BOT_COMMAND_RULES_VERSION);
    expect(new BotCommandRulesStore(file).rulesFor('bot-1')).toEqual([{ argv: ['npm', 'test'] }, { argv: ['make'], anyArgs: true }]);
    await expect(store.setRules('bot-1', [{ argv: [] }])).rejects.toThrow(/malformed/);
    await expect(store.setRules('bot-1', [{ argv: ['a\nb'] }])).rejects.toThrow(/malformed/);
  });

  it('a file of another version gives no rules and is never overwritten', async () => {
    const file = botCommandRulesPath(botDir);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ version: 99, bots: { 'bot-1': [{ argv: ['rm'] }] } }));
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const store = new BotCommandRulesStore(file);
    expect(store.rulesFor('bot-1')).toEqual([]);
    await expect(store.setRules('bot-1', [{ argv: ['ls'] }])).rejects.toThrow(/another version/);
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).version).toBe(99);
    vi.restoreAllMocks();
  });

  it('no RPC method can write it (the owner path is main-side only)', () => {
    expect(ALL_RPC_METHODS.filter((m) => /command.?rule|bot.?command/i.test(m))).toEqual([]);
  });
});

describe('the sandbox settings', () => {
  it('writes only in the bot folder, reads nothing secret, no network, and unsets the session env', () => {
    const home = '/Users/someone';
    const wmuxDir = path.join(home, '.wmux');
    const bot = path.join(wmuxDir, 'factory', 'bots', 'bot-1');
    const s = botSandboxSettings({
      botDir: bot,
      wmuxDir,
      home,
      platform: 'darwin',
      env: { PATH: '/usr/bin', HOME: home, LANG: 'en_US.UTF-8', LC_ALL: 'C', ANTHROPIC_API_KEY: 'sk-ant-x', WMUX_AUTH_TOKEN: 't', GH_TOKEN: 'g', CLAUDE_CONFIG_DIR: path.join(wmuxDir, 'factory', 'claude-api-config'), FOO: 'bar' },
      accountConfigDirs: ['/Users/someone/claude-work'],
    }) as Record<string, unknown> & {
      filesystem: { allowWrite: string[]; denyRead: string[]; allowRead: string[] };
      network: Record<string, unknown>;
      credentials: { envVars: Array<{ name: string; mode: string }> };
    };
    expect(s).toMatchObject({ enabled: true, failIfUnavailable: true, autoAllowBashIfSandboxed: false, allowUnsandboxedCommands: false });
    expect(s.filesystem.allowWrite).toEqual([bot]);
    expect(s.filesystem.denyRead).toEqual(expect.arrayContaining([
      wmuxDir, path.join(home, '.claude'), path.join(home, '.ssh'), path.join(home, '.aws'), path.join(home, '.config', 'gh'),
      path.join(home, 'Library', 'Keychains'), '/Users/someone/claude-work', path.join(wmuxDir, 'factory', 'claude-api-config'),
    ]));
    expect(s.filesystem.allowRead).toContain(bot);
    expect(s.network).toMatchObject({ allowedDomains: [], allowAllUnixSockets: false, allowLocalBinding: false });
    const unset = s.credentials.envVars;
    expect(unset.every((e) => e.mode === 'deny')).toBe(true);
    const names = unset.map((e) => e.name);
    expect(names).toEqual(expect.arrayContaining(['ANTHROPIC_API_KEY', 'WMUX_AUTH_TOKEN', 'GH_TOKEN', 'CLAUDE_CONFIG_DIR', 'FOO', 'CLAUDE_CODE_OAUTH_TOKEN']));
    expect(names).toEqual(expect.not.arrayContaining(['PATH', 'HOME', 'LANG', 'LC_ALL']));
  });

  it('always unsets the credential names even when the session lacks them', () => {
    expect(botExecUnsetEnv({ PATH: '/bin' })).toEqual(expect.arrayContaining(['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'WMUX_AUTH_TOKEN']));
  });
});

describe('the capability check', () => {
  beforeEach(() => __clearBotExecSupportCacheForTesting());
  const version = (v: string) => async () => ({ ok: true as const, version: v });

  it('runs on macOS with sandbox-exec and a new enough claude', async () => {
    expect(await probeBotExecSupport('/c', { platform: 'darwin', isFile: () => true, version: version('2.1.305 (Claude Code)') })).toEqual({ ok: true, version: '2.1.305 (Claude Code)' });
    expect(await probeBotExecSupport('/c', { platform: 'darwin', isFile: () => true, version: version('2.1.206 (Claude Code)') })).toMatchObject({ ok: true });
  });

  it('is off on Windows, without the sandbox tools, on an older claude, or with no claude', async () => {
    expect(await probeBotExecSupport('/c', { platform: 'win32', version: version('9.9.9') })).toMatchObject({ ok: false });
    expect(await probeBotExecSupport('/c', { platform: 'darwin', isFile: () => false, version: version('2.1.305') })).toMatchObject({ ok: false });
    expect(await probeBotExecSupport('/c', { platform: 'linux', onPath: (c) => c === 'bwrap', version: version('2.1.305') })).toMatchObject({ ok: false, reason: expect.stringMatching(/socat/) });
    expect(await probeBotExecSupport('/old', { platform: 'darwin', isFile: () => true, version: version('2.1.205 (Claude Code)') })).toMatchObject({ ok: false, reason: expect.stringMatching(/older/) });
    expect(await probeBotExecSupport('/c', { platform: 'darwin', isFile: () => true, version: async () => ({ ok: false as const, detail: 'boom' }) })).toMatchObject({ ok: false });
    expect(await probeBotExecSupport(null, { platform: 'darwin', isFile: () => true })).toMatchObject({ ok: false });
  });

  it('a claude that did not start with the sandbox is off until its version changes', async () => {
    const deps = { platform: 'darwin' as const, isFile: () => true, version: version('2.1.305 (Claude Code)') };
    expect(await probeBotExecSupport('/c', deps)).toMatchObject({ ok: true });
    markBotExecFailed('/c', '2.1.305 (Claude Code)');
    expect(await probeBotExecSupport('/c', deps)).toMatchObject({ ok: false, reason: expect.stringMatching(/did not start/) });
    expect(await probeBotExecSupport('/c', { ...deps, version: version('2.1.306 (Claude Code)') })).toMatchObject({ ok: true });
  });
});
