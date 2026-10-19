// pty:create's codex bot-worker stage: real git worktree, a stand-in codex
// (its version and its rules check are scripted).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('electron', () => ({ app: { getPath: () => os.tmpdir(), isPackaged: false, getAppPath: () => process.cwd() } }));

import { guardBotWorkerSessionText, guardCodexBotWorker, guardCodexSessionLine, type CodexGuardRun } from '../codexWorkerGuard';
import { beginBotWorkerSpawn, claimInflightCodexLaunch, forgetBotWorkerSession, guardedCodexCwdRefusal, guardedCodexLaunch, isGuardedCodexCreate, noteBotWorkerSession, reloadBotWorkerSessionsForTests, setWorkerMcpResolvers, withBotWorkerMergeGuard } from '../botWorkerMergeGuard';
import { CODEX_WORKER_EXCLUDE_LINE, CODEX_WORKER_RULES_PATH } from '../../../shared/codexWorkerGuard';
import { FANOUT_EXTRA_AGENT_STEMS, applyFanoutAgentFlags, codexTrustOverride, fanoutChoiceBinding } from '../../../shared/fanoutPreset';
import { parseCodexWorkerLine } from '../../../shared/codexWorkerGuard';
import { applyWorkerPermissionFlags, reattachModelEnvMarker, splitModelEnvMarker } from '../../../shared/workerLaunch';
import { applyRoleAgent } from '../../../shared/orchestratorRole';
import { withRoleBinding } from '../../../renderer/utils/ptyCreateOptions';
import { workerLaunchCommand } from '../../worktask/FanOutService';
import { withBotWorkerAgent } from '../../../shared/botWorkerAgent';

const sh = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], { cwd, encoding: 'utf8' }).trim();

let root: string;
let repo: string;
let wt: string;
let canary: { decision: string; ours: boolean; code: number };
let version: string;
let calls: string[][];

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-codex-guard-')));
  repo = path.join(root, 'repo');
  wt = path.join(root, 'wt');
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
  sh(repo, 'add', '.');
  sh(repo, 'commit', '-qm', 'init');
  sh(repo, 'worktree', 'add', '-q', '-b', 'wtask/x', wt);
  canary = { decision: 'forbidden', ours: true, code: 0 };
  version = 'codex-cli 0.162.1';
  calls = [];
});
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

const run = async (cmd: string, args: string[], opts: { cwd: string }): Promise<CodexGuardRun> => {
  calls.push([cmd, ...args]);
  if (cmd === '/fake/codex') {
    if (args[0] === '--version') return { code: 0, stdout: `${version}\n`, stderr: '' };
    const matched = canary.ours ? [{ prefixRuleMatch: { justification: 'wmux bot worker: x' } }] : [];
    return { code: canary.code, stdout: JSON.stringify({ decision: canary.decision, matchedRules: matched }), stderr: canary.code ? 'Error loading rules' : '' };
  }
  try {
    return { code: 0, stdout: execFileSync(cmd, args, { cwd: opts.cwd, encoding: 'utf8' }), stderr: '' };
  } catch (err) {
    return { code: 1, stdout: '', stderr: String(err) };
  }
};
const deps = { run, resolveCodex: async () => '/fake/codex', paneEnv: async () => process.env, repoKey: () => 'acme/app', platform: 'darwin' as const, claimLaunch: () => true, get home() { return root; } };
const PROMPT = `"$(cat '/data/.meta/x/prompt.md')"`;
const line = () => `codex ${codexTrustOverride(wt, 'darwin')} -a never -s workspace-write ${PROMPT}`;
const strict = { strict: true, spawns: [{ botId: 'bot-00000001' }] };

// The guard runs on macOS and Linux only (it refuses on Windows, tested below
// in 'refuses a later launch, Windows, …'); these cases drive it end to end
// with POSIX worktree paths, symlinks and an executable stand-in.
const posixOnly = it.skipIf(process.platform === 'win32');

describe('guardCodexBotWorker', () => {
  posixOnly('writes the rules, excludes them, proves they load and rebuilds the line', async () => {
    const out = await guardCodexBotWorker({ initialCommand: line(), cwd: wt, env: { CODEX_HOME: path.join(root, 'none') } }, strict, deps);
    const rules = fs.readFileSync(path.join(wt, CODEX_WORKER_RULES_PATH), 'utf8');
    expect(rules).toContain('["git", "push"]');
    expect(rules).toContain('"--repo=acme/app"');
    const common = sh(wt, 'rev-parse', '--path-format=absolute', '--git-common-dir');
    expect(fs.readFileSync(path.join(common, 'info', 'exclude'), 'utf8').split('\n')).toContain(CODEX_WORKER_EXCLUDE_LINE);
    expect(sh(wt, 'status', '--porcelain')).toBe('');
    expect(out!.initialCommand).toContain('-s workspace-write -c \'sandbox_workspace_write.writable_roots=[');
    expect(out!.initialCommand).toContain(common);
    expect(out!.initialCommand.endsWith(`-C '${wt}' -- ${PROMPT}`)).toBe(true);
    const check = calls.find((c) => c[1] === 'execpolicy')!;
    expect(check).toContain(path.join(wt, CODEX_WORKER_RULES_PATH));
    // The merge guard lets exactly that create through; a copy of its line is not it.
    expect(withBotWorkerMergeGuard(out, { workspaceId: 'ws', strict: true })).toBe(out);
    expect(isGuardedCodexCreate({ initialCommand: out!.initialCommand })).toBe(false);
    expect(() => withBotWorkerMergeGuard({ ...out! }, { workspaceId: 'ws', strict: true })).toThrow(/did not build/);
    // It starts in the folder it was checked in, nowhere else.
    expect(guardedCodexCwdRefusal(out, { source: 'requested', safeCwd: wt })).toBeNull();
    expect(guardedCodexCwdRefusal(out, { source: 'recovery-cwd', safeCwd: wt })).toMatch(/only in the folder/);
    expect(guardedCodexCwdRefusal(out, { source: 'requested', safeCwd: root })).toMatch(/only in the folder/);
    expect(guardedCodexCwdRefusal({ initialCommand: 'claude' }, { source: 'fallback' })).toBeNull();
    // A second launch keeps one exclude line.
    await guardCodexBotWorker({ initialCommand: line(), cwd: wt }, strict, deps);
    expect(fs.readFileSync(path.join(common, 'info', 'exclude'), 'utf8').split('\n').filter((l) => l === CODEX_WORKER_EXCLUDE_LINE)).toHaveLength(1);
  });

  it('leaves a claude line, a non-bot create and no line alone', async () => {
    const claude = { initialCommand: 'claude "$(cat \'/p\')"', cwd: wt };
    expect(await guardCodexBotWorker(claude, strict, deps)).toBe(claude);
    const human = { initialCommand: line(), cwd: wt };
    expect(await guardCodexBotWorker(human, null, deps)).toBe(human);
  });

  it('refuses a later launch, Windows, and a line outside the allowlist', async () => {
    await expect(guardCodexBotWorker({ initialCommand: line(), cwd: wt }, { strict: false }, deps)).rejects.toThrow(/first launch/);
    // Strict from the renderer's lineage alone (no in-flight spawn main marked) is not the first launch.
    await expect(guardCodexBotWorker({ initialCommand: line(), cwd: wt }, { strict: true }, deps)).rejects.toThrow(/first launch/);
    await expect(guardCodexBotWorker({ initialCommand: line(), cwd: wt }, strict, { ...deps, claimLaunch: () => false })).rejects.toThrow(/first launch/);
    await expect(guardCodexBotWorker({ initialCommand: line(), cwd: wt }, strict, { ...deps, platform: 'win32' })).rejects.toThrow(/Windows/);
    // A re-fire or a resume is refused on Windows too, before the line is read.
    await expect(guardCodexSessionLine({ agent: 'codex', cwd: wt }, line(), { ...deps, platform: 'win32' })).rejects.toThrow(/Windows/);
    await expect(guardCodexBotWorker({ initialCommand: line().replace('-a never', '--yolo'), cwd: wt }, strict, deps)).rejects.toThrow(/allows/);
  });

  posixOnly('refuses a .codex folder too large to check', async () => {
    fs.mkdirSync(path.join(wt, '.codex', 'many'), { recursive: true });
    for (let i = 0; i < 501; i++) fs.writeFileSync(path.join(wt, '.codex', 'many', `f${i}`), '');
    sh(wt, 'add', '.codex');
    sh(wt, 'commit', '-qm', 'many');
    await expect(guardCodexBotWorker({ initialCommand: line(), cwd: wt }, strict, deps)).rejects.toThrow(/more than 500/);
  });

  posixOnly('refuses untracked .codex content, a symlink, and a tracked file at the rules path', async () => {
    fs.mkdirSync(path.join(wt, '.codex'), { recursive: true });
    fs.writeFileSync(path.join(wt, '.codex', 'notes.md'), 'x\n');
    await expect(guardCodexBotWorker({ initialCommand: line(), cwd: wt }, strict, deps)).rejects.toThrow(/does not track.*notes\.md/);
    // Tracked content is the owner's: allowed (a codex config is not, below).
    sh(wt, 'add', '.codex/notes.md');
    sh(wt, 'commit', '-qm', 'notes');
    await expect(guardCodexBotWorker({ initialCommand: line(), cwd: wt }, strict, deps)).resolves.toBeTruthy();
    fs.rmSync(path.join(wt, '.codex', 'rules'), { recursive: true, force: true });
    fs.symlinkSync(root, path.join(wt, '.codex', 'rules'));
    await expect(guardCodexBotWorker({ initialCommand: line(), cwd: wt }, strict, deps)).rejects.toThrow(/symlink/);
    fs.unlinkSync(path.join(wt, '.codex', 'rules'));
    fs.mkdirSync(path.join(wt, '.codex', 'rules'));
    fs.writeFileSync(path.join(wt, CODEX_WORKER_RULES_PATH), '# repo copy\n');
    sh(wt, 'add', '-f', CODEX_WORKER_RULES_PATH);
    await expect(guardCodexBotWorker({ initialCommand: line(), cwd: wt }, strict, deps)).rejects.toThrow(/tracks/);
  });

  posixOnly('fails closed when the rules do not load, the decision is not ours, or codex is too old or missing', async () => {
    canary = { decision: 'forbidden', ours: true, code: 1 };
    await expect(guardCodexBotWorker({ initialCommand: line(), cwd: wt }, strict, deps)).rejects.toThrow(/do not load/);
    canary = { decision: 'forbidden', ours: false, code: 0 };
    await expect(guardCodexBotWorker({ initialCommand: line(), cwd: wt }, strict, deps)).rejects.toThrow(/do not load/);
    canary = { decision: 'allow', ours: true, code: 0 };
    await expect(guardCodexBotWorker({ initialCommand: line(), cwd: wt }, strict, deps)).rejects.toThrow(/do not load/);
    canary = { decision: 'forbidden', ours: true, code: 0 };
    version = 'codex-cli 0.150.0';
    await expect(guardCodexBotWorker({ initialCommand: line(), cwd: wt }, strict, deps)).rejects.toThrow(/older than/);
    await expect(guardCodexBotWorker({ initialCommand: line(), cwd: wt }, strict, { ...deps, resolveCodex: async () => null })).rejects.toThrow(/not on the pane/);
  });

  posixOnly('runs no git with a config key that names a program, and pins the codex home it checked into the pane', async () => {
    const marker = path.join(root, 'fsmonitor-ran');
    const prog = path.join(root, 'fsm.sh');
    fs.writeFileSync(prog, `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
    sh(wt, 'config', 'core.fsmonitor', prog);
    await expect(guardCodexBotWorker({ initialCommand: line(), cwd: wt, env: { CODEX_HOME: path.join(root, 'none') } }, strict, deps)).rejects.toThrow(/core\.fsmonitor/);
    expect(fs.existsSync(marker)).toBe(false);
    sh(wt, 'config', '--unset', 'core.fsmonitor');
    const out = await guardCodexBotWorker({ initialCommand: line(), cwd: wt, env: { CODEX_HOME: path.join(root, 'none') } }, strict, deps);
    expect(out!.env).toMatchObject({ CODEX_HOME: path.join(root, 'none') });
    expect(calls.filter((c) => c[0] === 'git').every((c) => c.slice(1, 3).join('=') === '-c=core.fsmonitor=false')).toBe(true);
  });

  posixOnly('refuses a worktree with a project codex config, and runs main\'s git on the worktree whatever the env names', async () => {
    const seen: NodeJS.ProcessEnv[] = [];
    const spy = { ...deps, run: async (cmd: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv }) => { if (cmd === 'git') seen.push(opts.env); return run(cmd, args, opts); } };
    await guardCodexBotWorker({ initialCommand: line(), cwd: wt, env: { CODEX_HOME: path.join(root, 'none'), GIT_DIR: path.join(root, 'elsewhere'), GIT_INDEX_FILE: '/x' } }, strict, spy);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((e) => e.GIT_DIR === undefined && e.GIT_INDEX_FILE === undefined)).toBe(true);
    fs.mkdirSync(path.join(wt, '.codex'), { recursive: true });
    fs.writeFileSync(path.join(wt, '.codex', 'config.toml'), '[mcp_servers.wmux]\ndefault_tools_approval_mode = "approve"\n');
    sh(wt, 'add', '.codex/config.toml');
    sh(wt, 'commit', '-qm', 'project codex config');
    await expect(guardCodexBotWorker({ initialCommand: line(), cwd: wt, env: { CODEX_HOME: path.join(root, 'none') } }, strict, deps)).rejects.toThrow(/\.codex\/config\.toml/);
  });

  posixOnly('checks every rules file the session reads, the user\'s included', async () => {
    fs.mkdirSync(path.join(root, '.codex', 'rules'), { recursive: true });
    fs.writeFileSync(path.join(root, '.codex', 'rules', 'default.rules'), '');
    await guardCodexBotWorker({ initialCommand: line(), cwd: wt, env: { CODEX_HOME: path.join(root, '.codex') } }, strict, deps);
    expect(calls.find((c) => c[1] === 'execpolicy')).toContain(path.join(root, '.codex', 'rules', 'default.rules'));
  });

  posixOnly('sets the worker\'s wmux tool approvals only when the codex config defines the wmux server, and the owner\'s approvals never widen them', async () => {
    const without = await guardCodexBotWorker({ initialCommand: line(), cwd: wt, env: { CODEX_HOME: path.join(root, 'none') } }, strict, deps);
    expect(without!.initialCommand).not.toContain('approval_mode');
    fs.mkdirSync(path.join(root, '.codex'), { recursive: true });
    fs.writeFileSync(path.join(root, '.codex', 'config.toml'), [
      '[mcp_servers.wmux]', 'command = "node"', 'args = ["/x/index.js"]', 'default_tools_approval_mode = "approve"',
      '[mcp_servers.wmux.tools.browser_open]', 'approval_mode = "approve"',
      '[mcp_servers.wmux.tools.computer]', 'approval_mode = "approve"', '',
    ].join('\n'));
    const out = (await guardCodexBotWorker({ initialCommand: line(), cwd: wt, env: { CODEX_HOME: path.join(root, '.codex') } }, strict, deps))!.initialCommand;
    expect(out).toContain(' -c mcp_servers.wmux.default_tools_approval_mode=prompt ');
    for (const t of ['ledger_update', 'task_push', 'channel_post']) expect(out).toContain(`${t}={approval_mode="approve"}`);
    for (const t of ['browser_open', 'terminal_send', 'fanout_start', 'computer']) expect(out).toContain(`${t}={approval_mode="prompt"}`);
  });

  posixOnly('sets the approvals for a wmux server of any transport, and refuses a config approval it cannot set back', async () => {
    const home = path.join(root, '.codex');
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(home, 'config.toml'), '[mcp_servers.wmux]\nurl = "http://127.0.0.1:9/mcp"\n[mcp_servers.wmux.tools.browser-extra]\napproval_mode = "approve"\n');
    const out = (await guardCodexBotWorker({ initialCommand: line(), cwd: wt, env: { CODEX_HOME: home } }, strict, deps))!.initialCommand;
    expect(out).toContain('browser-extra={approval_mode="prompt"}');
    fs.writeFileSync(path.join(home, 'config.toml'), '[mcp_servers.wmux]\ncommand = "node"\n[mcp_servers.wmux.tools."browser.odd"]\napproval_mode = "approve"\n');
    await expect(guardCodexBotWorker({ initialCommand: line(), cwd: wt, env: { CODEX_HOME: home } }, strict, deps)).rejects.toThrow(/cannot set back to ask \(browser\.odd\)/);
  });
});

describe('a re-fire or a resume of a guarded codex pane', () => {
  const ID = '11111111-2222-3333-4444-555555555555';
  posixOnly('rebuilds from main\'s record, never from the caller', async () => {
    const out = await guardCodexBotWorker({ initialCommand: line(), cwd: wt }, strict, deps);
    const launch = guardedCodexLaunch(out)!;
    expect(launch).toEqual({ agent: 'codex', cwd: wt, repoKey: 'acme/app', codexHome: process.env.CODEX_HOME || path.join(root, '.codex') });
    // A re-fire of the line main built comes back the same.
    expect(await guardCodexSessionLine(launch, out!.initialCommand!, deps)).toBe(out!.initialCommand);
    // A resume keeps main's flags and pins the same folder.
    const resume = await guardCodexSessionLine(launch, `codex resume ${ID} ${codexTrustOverride(wt, 'darwin')}`, deps);
    expect(resume.startsWith(`codex resume ${ID} `)).toBe(true);
    expect(resume).toContain('-s workspace-write');
    expect(resume.endsWith(`-C '${wt}'`)).toBe(true);
    await expect(guardCodexSessionLine(launch, `codex resume ${ID} ${codexTrustOverride(wt, 'darwin')} --yolo`, deps)).rejects.toThrow(/allows/);
    // The resume chip's own line: no trust override of its own, a model flag first.
    const chip = await guardCodexSessionLine(launch, `codex --model gpt-6.1-sol resume ${ID}`, deps);
    expect(chip.startsWith(`codex resume ${ID} ${codexTrustOverride(wt, 'darwin')} -a never -s workspace-write`)).toBe(true);
    expect(chip).toContain('--model gpt-6.1-sol');
    // A failure that is not the guard's own still names where it happened.
    await expect(guardCodexSessionLine(launch, `codex resume ${ID}`, { ...deps, resolveCodex: async () => { throw new Error('EACCES'); } }, 'worktask:refire'))
      .rejects.toThrow(/^worktask:refire: a bot's codex worker was not launched: EACCES/);
    await expect(guardCodexSessionLine(null, out!.initialCommand!, deps)).rejects.toThrow(/no guarded codex launch on record/);
    await expect(guardCodexSessionLine({ workspaceId: 'w', at: 1 } as never, out!.initialCommand!, deps)).rejects.toThrow(/no guarded codex launch on record/);
  });

  posixOnly('routes a typed line by pane: codex through the record, claude through the merge guard, others as given', async () => {
    const dir = path.join(root, 'data');
    reloadBotWorkerSessionsForTests();
    noteBotWorkerSession('pty-codex', 'ws-task', dir, { agent: 'codex', cwd: wt, repoKey: 'acme/app' });
    noteBotWorkerSession('pty-plain', 'ws-task', dir, { cwd: wt });
    setWorkerMcpResolvers({ entry: () => '/opt/wmux/mcp/index.js', registeredLevel: () => null });
    try {
      const typed = `codex resume ${ID} ${codexTrustOverride(wt, 'darwin')}`;
      expect(await guardBotWorkerSessionText('pty-codex', typed, 'write-launch', { ...deps, dir })).toContain('-s workspace-write');
      await expect(guardBotWorkerSessionText('pty-plain', typed, 'refire', { ...deps, dir })).rejects.toThrow(/^worktask:refire: .*no guarded codex launch on record/);
      expect(await guardBotWorkerSessionText('pty-plain', 'claude --resume x', 'write-launch', { ...deps, dir })).toContain('--strict-mcp-config');
      expect(await guardBotWorkerSessionText('pty-human', typed, 'write-launch', { ...deps, dir })).toBe(typed);
    } finally {
      forgetBotWorkerSession('pty-codex', dir);
      forgetBotWorkerSession('pty-plain', dir);
      reloadBotWorkerSessionsForTests();
    }
  });
});

describe('a codex worker\'s MCP servers', () => {
  const gh = {
    id: 'con-0000000a', name: 'gh', transport: 'http' as const,
    remote: { url: 'https://api.example.com/mcp/readonly', headers: {} },
    secrets: [{ secret: 'GH_MCP_TOKEN', as: 'header' as const, header: 'Authorization', scheme: 'bearer' as const }],
    tools: { mode: 'listed' as const, allowed: ['get_me'] },
    scope: { kind: 'all' as const }, offFor: [], enabled: true, createdAt: 1, updatedAt: 1,
  };
  const files = {
    ...gh, id: 'con-0000000b', name: 'files', transport: 'stdio' as const, remote: undefined,
    stdio: { command: '/usr/local/bin/npx', args: ['-y', 'pkg@1.0.0'], env: {} }, secrets: [],
  };
  const home = () => {
    const h = path.join(root, 'codex-home');
    fs.mkdirSync(h, { recursive: true });
    fs.writeFileSync(path.join(h, 'config.toml'), '[mcp_servers.wmux]\ncommand = "node"\n\n[mcp_servers.node_repl]\ncommand = "node"\n');
    return h;
  };

  posixOnly('every launch turns the owner\'s other servers, apps and plugins off; a task\'s connections are added and recorded', async () => {
    const env = { CODEX_HOME: home() };
    const dir = path.join(root, 'data');
    const plain = await guardCodexBotWorker({ initialCommand: line(), cwd: wt, env }, strict, { ...deps, dir });
    expect(plain!.initialCommand).toContain('-c features.apps=false -c features.plugins=false -c mcp_servers.node_repl.enabled=false -C ');
    expect(plain!.initialCommand).not.toContain('mcp_servers.wmux.enabled=false');
    const withConn = { strict: true, spawns: [{ botId: 'bot-00000001', taskId: 'wtask-1', connectors: [gh, files] }] };
    const out = await guardCodexBotWorker({ initialCommand: line(), cwd: wt, env }, withConn, { ...deps, dir });
    expect(out!.initialCommand).toContain(`-c 'mcp_servers.gh={"url"="https://api.example.com/mcp/readonly"`);
    expect(out!.initialCommand).toContain(`"args"=["-C","${path.join(dir, 'factory', 'connector-run', files.id)}","/usr/local/bin/npx"`);
    expect(fs.statSync(path.join(dir, 'factory', 'connector-run', files.id, 'npmrc')).mode & 0o777).toBe(0o600);
    // The merge guard lets it through only with the connections it was built with.
    expect(withBotWorkerMergeGuard(out, { workspaceId: 'ws', ...withConn })).toBe(out);
    expect(() => withBotWorkerMergeGuard(plain, { workspaceId: 'ws', ...withConn })).toThrow(/did not build/);
    // A re-fire rebuilds the connections the task still has.
    const launch = guardedCodexLaunch(out)!;
    expect(await guardCodexSessionLine({ ...launch, workspaceId: 'ws' }, out!.initialCommand!, { ...deps, dir, sessionConnectors: () => [gh, files] })).toBe(out!.initialCommand);
    const without = await guardCodexSessionLine({ ...launch, workspaceId: 'ws' }, out!.initialCommand!, { ...deps, dir, sessionConnectors: () => [] });
    expect(without).toBe(plain!.initialCommand);
  });

  posixOnly('refuses a connection named like an owner or system server, an SSE one, and a config it cannot read; turns system servers off', async () => {
    const h = home();
    const env = { CODEX_HOME: h };
    const clash = { strict: true, spawns: [{ botId: 'bot-00000001', connectors: [{ ...gh, name: 'node_repl' }] }] };
    await expect(guardCodexBotWorker({ initialCommand: line(), cwd: wt, env }, clash, deps)).rejects.toThrow(/its own server named node_repl/);
    const sse = { strict: true, spawns: [{ botId: 'bot-00000001', connectors: [{ ...gh, transport: 'sse' as const }] }] };
    await expect(guardCodexBotWorker({ initialCommand: line(), cwd: wt, env }, sse, deps)).rejects.toThrow(/SSE/);
    // The system config's servers count too.
    const system = path.join(root, 'etc-codex');
    fs.mkdirSync(system, { recursive: true });
    fs.writeFileSync(path.join(system, 'config.toml'), '[mcp_servers.corp]\ncommand = "x"\n');
    const corp = await guardCodexBotWorker({ initialCommand: line(), cwd: wt, env }, strict, { ...deps, systemCodexDir: system });
    expect(corp!.initialCommand).toContain('-c mcp_servers.corp.enabled=false');
    const corpClash = { strict: true, spawns: [{ botId: 'bot-00000001', taskId: 'wtask-1', connectors: [{ ...gh, name: 'corp' }] }] };
    await expect(guardCodexBotWorker({ initialCommand: line(), cwd: wt, env }, corpClash, { ...deps, systemCodexDir: system })).rejects.toThrow(/its own server named corp/);
    fs.writeFileSync(path.join(h, 'config.toml'), '[mcp_servers.x\n');
    await expect(guardCodexBotWorker({ initialCommand: line(), cwd: wt, env }, strict, deps)).rejects.toThrow(/could not be read/);
    fs.writeFileSync(path.join(h, 'config.toml'), '[mcp_servers."my server"]\ncommand = "x"\n');
    await expect(guardCodexBotWorker({ initialCommand: line(), cwd: wt, env }, strict, deps)).rejects.toThrow(/cannot turn off by name/);
  });
});

describe('the line the renderer really sends for a bot\'s codex worker', () => {
  it('passes the allowlist, with and without a model and effort', () => {
    for (const pick of [{ agent: 'codex' }, { agent: 'codex', model: 'gpt-6.1-sol', effort: 'low' }]) {
      // Main's rows for a bot preset with the owner's pick applied.
      const [choice] = withBotWorkerAgent([{ agent: 'claude' }], pick);
      // The renderer's chain (useRpcBridge, as in botWorkerMergeGuard.os.test.ts).
      const main = workerLaunchCommand('claude', '/w/.wtask/prompt.md', { platform: 'darwin' }).command;
      const binding = fanoutChoiceBinding(choice);
      const { marker, command: bare } = splitModelEnvMarker(main);
      const swap = applyRoleAgent(bare, binding, { extraAgents: FANOUT_EXTRA_AGENT_STEMS });
      const bound = withRoleBinding({ initialCommand: swap.command }, binding, undefined, FANOUT_EXTRA_AGENT_STEMS);
      const flagged = applyFanoutAgentFlags(bound.initialCommand as string, choice, '/w', 'darwin');
      const line = reattachModelEnvMarker(marker, applyWorkerPermissionFlags(flagged, 'bypassPermissions'), '/bin/zsh').command;
      const parsed = parseCodexWorkerLine(line, '/w');
      expect(parsed, line).not.toBeNull();
      expect(parsed!.model).toBe(pick.model);
      expect(parsed!.effort).toBe(pick.effort);
    }
  });
});

describe('the in-flight spawn launches codex once', () => {
  it('claims once per spawn, and not without one', () => {
    expect(claimInflightCodexLaunch('ws-owner', '/w/one')).toBe(false);
    const release = beginBotWorkerSpawn('ws-owner', '/w/one', { botId: 'bot-00000001', taskId: 'wtask-1' });
    expect(claimInflightCodexLaunch('ws-owner', '/w/one')).toBe(true);
    expect(claimInflightCodexLaunch('ws-owner', '/w/one')).toBe(false);
    expect(claimInflightCodexLaunch('', '/w/one')).toBe(false);
    release();
    expect(claimInflightCodexLaunch('ws-owner', '/w/one')).toBe(false);
  });
});

describe('the merge guard refuses codex lines it did not see built', () => {
  it('a strict create with a raw codex line', () => {
    expect(() => withBotWorkerMergeGuard({ initialCommand: line() }, { workspaceId: 'ws', strict: true })).toThrow(/did not build/);
  });
});
