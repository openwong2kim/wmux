// A bot's Claude worker loads only wmux and its task's connections: the
// per-launch MCP config and rules, the guard's paths (create, re-fire,
// resume, the daemon's phone launch) and the grant that carries the keys.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

vi.mock('electron', () => ({ safeStorage: {} }));

import {
  beginBotWorkerSpawn,
  botWorkerForCreate,
  guardRefireLine,
  guardedClaudeCwdRefusal,
  guardSessionLaunch,
  guardedLaunchOf,
  noteBotWorkerSession,
  pruneWorkerLaunchFiles,
  reloadBotWorkerSessionsForTests,
  withBotWorkerMergeGuard,
} from '../botWorkerMergeGuard';
import { BOT_WORKER_DENY, botWorkerSessionsPath, readBotWorkerSessions, spliceSettingsFlag, workerProjectSettingsRefusal } from '../../../shared/botWorkerGuard';
import { buildWorkerMcpConfig, buildWorkerSettings, spliceWorkerLaunch, workerWmuxLevel } from '../../../shared/botWorkerMcp';
import { guardBotWorkerLaunch } from '../../../daemon/chat/botWorkerLaunchGuard';
import type { Connector } from '../../../shared/botConnector';
import { MODEL_ENV_MARKER } from '../../../shared/workerLaunch';
import { SecretStore, setSecretStore } from '../../factory/secretStore';
import { ConnectorStore, setConnectorStore } from '../../factory/connectorStore';
import { __resetSecretGrantsForTesting, mintSecretGrant, resolveSecretGrant, setSecretGrantSource } from '../../factory/secretGrants';
import { toWslPath } from '../../../shared/imagePaste';

const ENTRY = '/opt/wmux/mcp/index.js';
const LINE = `claude --dangerously-skip-permissions "$(cat '/w/.wtask/prompt.md')"`;
const VALUE = 'ghp_ConnectorSecretValue0123456789';

function con(over: Partial<Connector> = {}): Connector {
  return {
    id: 'con-0000000a', name: 'gh', transport: 'http',
    remote: { url: 'https://api.example.com/mcp/readonly', headers: { 'X-MCP-Readonly': 'true' } },
    secrets: [{ secret: 'GH_MCP_TOKEN', as: 'header', header: 'Authorization', scheme: 'bearer' }],
    tools: { mode: 'all', blocked: ['merge_pull_request'] },
    scope: { kind: 'all' }, offFor: [], enabled: true, createdAt: 1, updatedAt: 1, ...over,
  };
}
const files = con({
  id: 'con-0000000b', name: 'files', transport: 'stdio', remote: undefined,
  stdio: { command: '/usr/local/bin/npx', args: ['-y', 'pkg@1.0.0', '/data'], env: { LOG_LEVEL: 'info' } },
  secrets: [{ secret: 'FILES_API_TOKEN', as: 'env' }],
  tools: { mode: 'listed', allowed: ['read_file', 'list_directory'] },
});

let dir: string;
const deps = () => ({ dir, mcpEntry: () => ENTRY, registeredLevel: () => null, isolatedBridge: () => null, wslRuntime: () => 'C:\\Program Files\\wmux\\wmux.exe' });
function wordsOf(line: string): { settings: string; mcp: string } {
  const m = /--settings="([^"]+)" --mcp-config="([^"]+)" --strict-mcp-config/.exec(line);
  if (!m) throw new Error(`not strict: ${line}`);
  return { settings: m[1], mcp: m[2] };
}
const readJson = (p: string) => JSON.parse(fs.readFileSync(p, 'utf8'));

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-conn-guard-'));
  reloadBotWorkerSessionsForTests();
});
afterEach(() => {
  reloadBotWorkerSessionsForTests();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('the per-launch documents (pure)', () => {
  it('wmux at core or full, a stdio connection run from its own folder with npm pinned, a remote one naming its key', () => {
    const doc = buildWorkerMcpConfig({ entry: ENTRY, level: 'core', connectors: [con(), files], runDir: (c) => `/d/run/${c.id}`, npmrc: (c) => `/d/run/${c.id}/npmrc` });
    expect(doc.mcpServers.wmux).toEqual({ type: 'stdio', command: 'node', args: [ENTRY, '--core'] });
    expect(doc.mcpServers.gh).toEqual({ type: 'http', url: 'https://api.example.com/mcp/readonly', headers: { 'X-MCP-Readonly': 'true', Authorization: 'Bearer ${GH_MCP_TOKEN}' } });
    expect(doc.mcpServers.files).toEqual({
      type: 'stdio',
      command: '/usr/bin/env',
      // The other connection's key is taken out of its environment.
      args: ['-C', '/d/run/con-0000000b', '-u', 'GH_MCP_TOKEN', '/usr/local/bin/npx', '-y', 'pkg@1.0.0', '/data'],
      env: { LOG_LEVEL: 'info', npm_config_userconfig: '/d/run/con-0000000b/npmrc', npm_config_registry: 'https://registry.npmjs.org/' },
    });
    expect(Object.keys(doc.mcpServers)).toEqual(['wmux', 'gh', 'files']);
  });

  it('rules: the worker deny list always; all-but-blocked as a server allow and tool denies; listed as tool allows and a hook, with hooks forced on', () => {
    expect(buildWorkerSettings([])).toEqual({ permissions: { deny: [...BOT_WORKER_DENY] } });
    const s = buildWorkerSettings([con(), files]) as { permissions: { allow: string[]; deny: string[] }; disableAllHooks: boolean; hooks: { PreToolUse: Array<{ matcher: string }> } };
    expect(s.permissions.allow).toEqual(['mcp__gh', 'mcp__files__read_file', 'mcp__files__list_directory']);
    expect(s.permissions.deny).toEqual([...BOT_WORKER_DENY, 'mcp__gh__merge_pull_request']);
    expect(s.disableAllHooks).toBe(false);
    const matcher = new RegExp(s.hooks.PreToolUse[0].matcher);
    expect(matcher.test('mcp__files__write_file')).toBe(true);
    expect(matcher.test('mcp__files__read_file')).toBe(false);
    expect(matcher.test('mcp__files__read_file_x')).toBe(true);
    expect(matcher.test('mcp__gh__get_me')).toBe(false);
    // Hooks are only forced on when a listed connection needs one.
    expect(buildWorkerSettings([con()])).not.toHaveProperty('disableAllHooks');
    // A listed connection with no tools blocks every one.
    const none = buildWorkerSettings([con({ tools: { mode: 'listed', allowed: [] } })]) as { hooks: { PreToolUse: Array<{ matcher: string }> } };
    expect(new RegExp(none.hooks.PreToolUse[0].matcher).test('mcp__gh__get_me')).toBe(true);
  });

  it('splices the three words once after the launcher, keeps the marker, and refuses any other config on the line', () => {
    const S = '/d/factory/worker-settings/aaaaaaaaaaaa.json';
    const M = '/d/factory/worker-mcp/bbbbbbbbbbbb.json';
    const once = spliceWorkerLaunch(MODEL_ENV_MARKER + LINE, S, M)!;
    expect(once).toBe(`${MODEL_ENV_MARKER}claude --settings="${S}" --mcp-config="${M}" --strict-mcp-config --dangerously-skip-permissions "$(cat '/w/.wtask/prompt.md')"`);
    expect(spliceWorkerLaunch(once, S, M)).toBe(once);
    expect(spliceWorkerLaunch(once, S, '/d/factory/worker-mcp/cccccccccccc.json')).toBeNull();
    for (const foreign of ['claude --mcp-config=/x.json', 'claude --mcp-config /x.json', 'claude --strict-mcp-config', 'claude --settings=/x.json', 'codex', 'claude -- x']) {
      expect(spliceWorkerLaunch(foreign, S, M), foreign).toBeNull();
    }
    expect(spliceWorkerLaunch(LINE, '/a$b/s.json', M)).toBeNull();
    // The shell could spell a flag the line does not show.
    for (const hidden of ['claude --set\\tings=/tmp/x', 'claude "--mcp-con\\fig=/x"', "claude $'--set\\x74ings=/x'", 'claude --set${X}tings=/x',
      'claude --{settings,x}=/x', 'claude --setting?=/x', 'claude --settings[=]/x', 'claude ~/x']) {
      expect(spliceWorkerLaunch(hidden, S, M), hidden).toBeNull();
      expect(spliceSettingsFlag(hidden, S), hidden).toBeNull();
    }
    // Our own words, already spliced, may hold a Windows path.
    const win = 'C:\\Users\\o\\.wmux\\factory\\worker-settings\\aaaaaaaaaaaa.json';
    const winOnce = spliceWorkerLaunch(LINE, win, M)!;
    expect(spliceWorkerLaunch(winOnce, win, M)).toBe(winOnce);
    expect(spliceSettingsFlag(spliceSettingsFlag(LINE, win)!, win)).toBe(spliceSettingsFlag(LINE, win));
  });

  it('wmux level: a role surface is raised to core, commander is never a worker\'s, default full', () => {
    expect(workerWmuxLevel('role')).toBe('core');
    expect(workerWmuxLevel(undefined, 'commander')).toBe('core');
    expect(workerWmuxLevel(undefined, 'full')).toBe('full');
    expect(workerWmuxLevel(undefined, null)).toBe('full');
    expect(workerWmuxLevel('full', 'core')).toBe('full');
  });
});

describe('the guard with connections', () => {
  it('the fan-out create loads wmux and the spawn\'s connections; the files hold no key value and are owner-only', () => {
    const release = beginBotWorkerSpawn('ws-owner', '/w/task', { botId: 'bot-0000000a', taskId: 't-1', connectors: [con(), files] });
    try {
      const opts = { initialCommand: LINE, fanoutTaskOf: 'ws-owner', cwd: '/w/task', workspaceId: 'ws-task' };
      const guarded = withBotWorkerMergeGuard(opts, botWorkerForCreate(opts, { dir, isBotTaskWorkspace: () => false }), deps())!;
      const w = wordsOf(guarded.initialCommand!);
      expect(Object.keys(readJson(w.mcp).mcpServers)).toEqual(['wmux', 'gh', 'files']);
      expect(readJson(w.settings).permissions.allow).toContain('mcp__gh');
      for (const f of [w.mcp, w.settings]) {
        expect(fs.readFileSync(f, 'utf8')).not.toContain(VALUE);
        if (process.platform !== 'win32') expect(fs.statSync(f).mode & 0o777).toBe(0o600);
      }
      expect(fs.existsSync(path.join(dir, 'factory', 'connector-run', 'con-0000000b', 'npmrc'))).toBe(true);
      expect(guardedLaunchOf(guarded)).toEqual({ launch: { settingsFile: w.settings, mcpConfigFile: w.mcp, level: 'full', connectionKeys: ['GH_MCP_TOKEN', 'FILES_API_TOKEN'] }, cwd: path.resolve('/w/task') });
    } finally {
      release();
    }
  });

  it('refuses a create whose in-flight spawns disagree on connections, a task with connections in a WSL shell, and a codex line the codex guard did not build', () => {
    const a = beginBotWorkerSpawn('ws-owner', '/w/task', { botId: 'bot-0000000a', taskId: 't-1', connectors: [con()] });
    const b = beginBotWorkerSpawn('ws-owner', '/w/task', { botId: 'bot-0000000a', taskId: 't-2' });
    try {
      const opts = { initialCommand: LINE, fanoutTaskOf: 'ws-owner', cwd: '/w/task', workspaceId: 'ws-task' };
      const worker = botWorkerForCreate(opts, { dir, isBotTaskWorkspace: () => false });
      expect(() => withBotWorkerMergeGuard(opts, worker, deps())).toThrow(/different connections/);
    } finally {
      a();
      b();
    }
    const c = beginBotWorkerSpawn('ws-owner', '/w/task', { botId: 'bot-0000000a', taskId: 't-1', connectors: [con()] });
    try {
      const opts = { initialCommand: LINE, fanoutTaskOf: 'ws-owner', cwd: '/w/task', workspaceId: 'ws-task' };
      expect(() => withBotWorkerMergeGuard(opts, botWorkerForCreate(opts, { dir, isBotTaskWorkspace: () => false }), deps(), { wsl: true })).toThrow(/WSL/);
      // A codex line takes connections only as the codex guard built it with them.
      const codex = { ...opts, initialCommand: `codex --dangerously-bypass-approvals-and-sandbox "$(cat '/w/.wtask/prompt.md')"` };
      expect(() => withBotWorkerMergeGuard(codex, botWorkerForCreate(codex, { dir, isBotTaskWorkspace: () => false }), deps())).toThrow(/did not build/);
    } finally {
      c();
    }
  });

  it('a role binding\'s level reaches the wmux entry (raised to core); without one, the owner\'s registered level', () => {
    const strict = { workspaceId: 'ws-task', strict: false };
    const role = withBotWorkerMergeGuard({ initialCommand: LINE, cwd: dir }, strict, deps(), { level: 'role' })!;
    expect(readJson(wordsOf(role.initialCommand!).mcp).mcpServers.wmux.args).toEqual([ENTRY, '--core']);
    const registered = withBotWorkerMergeGuard({ initialCommand: LINE, cwd: dir }, strict, { ...deps(), registeredLevel: () => 'core' })!;
    expect(readJson(wordsOf(registered.initialCommand!).mcp).mcpServers.wmux.args).toEqual([ENTRY, '--core']);
  });
});

describe('the session record carries the launch', () => {
  it('re-fire and resume reuse the recorded files; a WSL session gets its settings and this build\'s wmux server again', () => {
    const guarded = withBotWorkerMergeGuard({ initialCommand: LINE, cwd: dir }, { workspaceId: 'ws-task', strict: false }, deps())!;
    noteBotWorkerSession('pty-1', 'ws-task', dir, guardedLaunchOf(guarded));
    const wsl = withBotWorkerMergeGuard({ initialCommand: LINE, cwd: dir }, { workspaceId: 'ws-task', strict: false }, deps(), { wsl: true })!;
    noteBotWorkerSession('pty-wsl', 'ws-task', dir, guardedLaunchOf(wsl));
    reloadBotWorkerSessionsForTests();
    const w = wordsOf(guarded.initialCommand!);
    expect(wordsOf(guardRefireLine('pty-1', LINE, deps()))).toEqual(w);
    expect(wordsOf(guardSessionLaunch('pty-1', 'claude --resume 11111111-2222-3333-4444-555555555555', deps()))).toEqual(w);
    // Linux claude reads them by their /mnt paths (a Windows temp dir is a drive path).
    expect(guardRefireLine('pty-wsl', LINE, deps())).toBe(wsl.initialCommand);
    expect(guardSessionLaunch('pty-wsl', LINE, deps())).toBe(wsl.initialCommand);
    const recorded = readBotWorkerSessions(dir);
    expect('sessions' in recorded && recorded.sessions.get('pty-wsl')?.launch?.level).toBe('full');
    // A session with no folder on record is not re-fired.
    noteBotWorkerSession('pty-nofolder', 'ws-task', dir);
    expect(() => guardRefireLine('pty-nofolder', LINE, deps())).toThrow(/no folder on record/);
  });

  it('an isolated instance\'s worker runs its own hook bridge and loads no user settings; the installed app\'s is unchanged (#2231)', () => {
    const BRIDGE = '/opt/wmux-under-test/resources/cli-bundle/wmux-bridge.mjs';
    const isolated = { ...deps(), isolatedBridge: () => BRIDGE };
    const guarded = withBotWorkerMergeGuard({ initialCommand: LINE, cwd: dir }, { workspaceId: 'ws-task', strict: false }, isolated)!;
    const w = wordsOf(guarded.initialCommand!);
    expect(guarded.initialCommand).toBe(`claude --settings="${w.settings}" --mcp-config="${w.mcp}" --strict-mcp-config --setting-sources=project --dangerously-skip-permissions "$(cat '/w/.wtask/prompt.md')"`);
    const hooks = readJson(w.settings).hooks as Record<string, Array<{ matcher: string; hooks: Array<{ command: string }> }>>;
    expect(readJson(w.settings).disableAllHooks).toBe(false);
    expect(Object.keys(hooks).sort()).toEqual(['Notification', 'PermissionRequest', 'PostToolUse', 'PreToolUse', 'SessionStart', 'Stop', 'StopFailure', 'SubagentStop', 'UserPromptSubmit']);
    expect(hooks.Stop[0].hooks[0].command).toBe(`node "${BRIDGE}" Stop`);
    // Signals only: no per-tool-call gate.
    expect(hooks.PreToolUse.map((g) => g.matcher)).toEqual(['AskUserQuestion']);
    expect(guardedLaunchOf(guarded).launch?.settingSources).toBe('project');
    // Re-fire, resume and the daemon's phone launch carry the same words.
    noteBotWorkerSession('pty-iso', 'ws-task', dir, guardedLaunchOf(guarded));
    reloadBotWorkerSessionsForTests();
    expect(guardRefireLine('pty-iso', LINE, isolated)).toBe(guarded.initialCommand);
    expect(readBotWorkerSessions(dir)).toMatchObject({ sessions: expect.any(Map) });
    const head = 'claude --resume 11111111-2222-3333-4444-555555555555';
    expect(guardBotWorkerLaunch('pty-iso', head, head, dir)).toBe(`claude --settings="${w.settings}" --mcp-config="${w.mcp}" --strict-mcp-config --setting-sources=project --resume 11111111-2222-3333-4444-555555555555`);
    // The installed app (no bridge of its own to prefer): today's line, word for word.
    const installed = withBotWorkerMergeGuard({ initialCommand: LINE, cwd: dir }, { workspaceId: 'ws-task', strict: false }, deps())!;
    expect(installed.initialCommand).not.toContain('--setting-sources');
    expect(readJson(wordsOf(installed.initialCommand!).settings)).not.toHaveProperty('hooks');
  });

  it('spliceWorkerLaunch: the setting-sources word is ours too, and a foreign one is refused', () => {
    const S = '/d/factory/worker-settings/aaaaaaaaaaaa.json';
    const M = '/d/factory/worker-mcp/bbbbbbbbbbbb.json';
    const once = spliceWorkerLaunch(LINE, S, M, 'project')!;
    expect(spliceWorkerLaunch(once, S, M, 'project')).toBe(once);
    // Recorded without it, or with it, the other way round: not the same launch.
    expect(spliceWorkerLaunch(once, S, M)).toBeNull();
    expect(spliceWorkerLaunch(spliceWorkerLaunch(LINE, S, M)!, S, M, 'project')).toBeNull();
    expect(spliceWorkerLaunch('claude --setting-sources=user', S, M)).toBeNull();
    expect(spliceWorkerLaunch('claude --setting-sources user', S, M, 'project')).toBeNull();
  });

  it('a re-fire or resume carries the task\'s connections that are still the bot\'s, and leaves out the rest', () => {
    const release = beginBotWorkerSpawn('ws-owner', dir, { botId: 'bot-0000000a', taskId: 't-1', connectors: [con(), files] });
    let guarded;
    try {
      const opts = { initialCommand: LINE, fanoutTaskOf: 'ws-owner', cwd: dir, workspaceId: 'ws-task' };
      guarded = withBotWorkerMergeGuard(opts, botWorkerForCreate(opts, { dir, isBotTaskWorkspace: () => false }), deps())!;
    } finally {
      release();
    }
    noteBotWorkerSession('pty-c', 'ws-task', dir, guardedLaunchOf(guarded));
    const servers = (line: string) => Object.keys(readJson(wordsOf(line).mcp).mcpServers);
    expect(servers(guardRefireLine('pty-c', LINE, { ...deps(), sessionConnectors: () => [con(), files] }))).toEqual(['wmux', 'gh', 'files']);
    expect(servers(guardRefireLine('pty-c', LINE, { ...deps(), sessionConnectors: () => [con()] }))).toEqual(['wmux', 'gh']);
    expect(servers(guardSessionLaunch('pty-c', 'claude --resume 11111111-2222-3333-4444-555555555555', { ...deps(), sessionConnectors: () => [] }))).toEqual(['wmux']);
    // The first launch's keys are still in the pane: a dropped connection's
    // key stays out of the remaining stdio server.
    const left = readJson(wordsOf(guardRefireLine('pty-c', LINE, { ...deps(), sessionConnectors: () => [files] })).mcp).mcpServers.files;
    expect(left.args.slice(0, 4)).toEqual(['-C', path.join(dir, 'factory', 'connector-run', files.id), '-u', 'GH_MCP_TOKEN']);
    // A folder the pane is in now is checked too.
    const moved = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-conn-moved-'));
    fs.mkdirSync(path.join(moved, '.claude'));
    fs.writeFileSync(path.join(moved, '.claude', 'settings.json'), JSON.stringify({ hooks: {} }));
    expect(() => guardRefireLine('pty-c', LINE, { ...deps(), sessionConnectors: () => [], folders: [moved] })).toThrow(/Claude settings/);
    fs.rmSync(moved, { recursive: true, force: true });
  });

  it('a guarded claude create starts only in the folder it was checked in', () => {
    const guarded = withBotWorkerMergeGuard({ initialCommand: LINE, cwd: dir }, { workspaceId: 'ws-task', strict: false }, deps())!;
    const launch = guardedLaunchOf(guarded);
    expect(guardedClaudeCwdRefusal(launch, { source: 'requested', safeCwd: dir })).toBeNull();
    expect(guardedClaudeCwdRefusal(launch, { source: 'recovery-cwd', safeCwd: dir })).toMatch(/only in the folder/);
    expect(guardedClaudeCwdRefusal(launch, { source: 'requested', safeCwd: os.tmpdir() })).toMatch(/only in the folder/);
    expect(guardedClaudeCwdRefusal({}, { source: 'fallback' })).toBeNull();
  });

  it('refuses a worker folder whose Claude project settings run a program or set the environment', () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-conn-proj-'));
    try {
      fs.mkdirSync(path.join(repo, '.claude'));
      fs.writeFileSync(path.join(repo, '.claude', 'settings.json'), JSON.stringify({ permissions: { allow: ['Bash(npm test)'] } }));
      const ok = withBotWorkerMergeGuard({ initialCommand: LINE, cwd: repo }, { workspaceId: 'ws-task', strict: false }, deps())!;
      noteBotWorkerSession('pty-p', 'ws-task', dir, guardedLaunchOf(ok));
      for (const [name, body] of [['settings.json', { hooks: { SessionStart: [] } }], ['settings.local.json', { env: { X: '1' } }], ['settings.json', '{not json']] as const) {
        fs.writeFileSync(path.join(repo, '.claude', name), typeof body === 'string' ? body : JSON.stringify(body));
        expect(workerProjectSettingsRefusal(repo), name).not.toBeNull();
        expect(() => withBotWorkerMergeGuard({ initialCommand: LINE, cwd: repo }, { workspaceId: 'ws-task', strict: false }, deps()), name).toThrow(/Claude settings/);
        expect(() => guardRefireLine('pty-p', LINE, deps()), name).toThrow(/Claude settings/);
        expect(guardBotWorkerLaunch('pty-p', 'claude', 'claude', dir), name).toBeNull();
        fs.unlinkSync(path.join(repo, '.claude', name));
      }
      expect(() => withBotWorkerMergeGuard({ initialCommand: LINE }, { workspaceId: 'ws-task', strict: false }, deps())).toThrow(/no folder/);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('round-trips through the file; launch files outside main\'s folders are not used; an old record is read as before', () => {
    noteBotWorkerSession('pty-old', 'ws-task', dir);
    const file = botWorkerSessionsPath(dir);
    const raw = readJson(file);
    raw.sessions['pty-forged'] = { workspaceId: 'ws-task', at: 1, launch: { settingsFile: '/tmp/x.json', mcpConfigFile: '/tmp/y.json', level: 'full' } };
    fs.writeFileSync(file, JSON.stringify(raw));
    const read = readBotWorkerSessions(dir);
    expect('sessions' in read && read.sessions.get('pty-forged')).toEqual({ workspaceId: 'ws-task', at: 1 });
    expect('sessions' in read && read.sessions.get('pty-old')).toEqual({ workspaceId: 'ws-task', at: expect.any(Number) });
  });
});

describe('the daemon\'s phone launch', () => {
  it('splices a session\'s recorded files with strict, a WSL record\'s by their /mnt paths; any other record nothing', () => {
    const guarded = withBotWorkerMergeGuard({ initialCommand: LINE, cwd: dir }, { workspaceId: 'ws-task', strict: false }, deps())!;
    noteBotWorkerSession('pty-1', 'ws-task', dir, guardedLaunchOf(guarded));
    noteBotWorkerSession('pty-old', 'ws-task', dir);
    const wslCreate = withBotWorkerMergeGuard({ initialCommand: LINE, cwd: dir }, { workspaceId: 'ws-task', strict: false }, deps(), { wsl: true })!;
    noteBotWorkerSession('pty-wsl', 'ws-task', dir, guardedLaunchOf(wslCreate));
    noteBotWorkerSession('pty-wsl-old', 'ws-task', dir, { wsl: true });
    const w = wordsOf(guarded.initialCommand!);
    expect(guardBotWorkerLaunch('pty-1', "claude -- 'hi'", 'claude', dir)).toBe(`claude --settings="${w.settings}" --mcp-config="${w.mcp}" --strict-mcp-config -- 'hi'`);
    expect(guardBotWorkerLaunch('pty-old', 'claude', 'claude', dir)).toBeNull();
    // Linux claude opens them through its /mnt mount (a Windows runner's path).
    const ww = wordsOf(wslCreate.initialCommand!);
    expect(guardBotWorkerLaunch('pty-wsl', 'claude', 'claude', dir)).toBe(`claude --settings="${ww.settings}" --mcp-config="${ww.mcp}" --strict-mcp-config`);
    expect(ww.mcp).toBe(toWslPath(guardedLaunchOf(wslCreate).launch!.mcpConfigFile) ?? guardedLaunchOf(wslCreate).launch!.mcpConfigFile);
    // A WSL record from before (no files): nothing, never the distro's own wmux server.
    expect(guardBotWorkerLaunch('pty-wsl-old', 'claude', 'claude', dir)).toBeNull();
    // A folder the line may start in is checked too.
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-conn-phone-'));
    fs.mkdirSync(path.join(other, '.claude'));
    fs.writeFileSync(path.join(other, '.claude', 'settings.local.json'), JSON.stringify({ hooks: {} }));
    expect(guardBotWorkerLaunch('pty-1', 'claude', 'claude', dir, [other])).toBeNull();
    fs.rmSync(other, { recursive: true, force: true });
    fs.unlinkSync(w.mcp);
    expect(guardBotWorkerLaunch('pty-1', 'claude', 'claude', dir)).toBeNull();
  });

  it('a recorded launch with connections starts only from main', () => {
    const release = beginBotWorkerSpawn('ws-owner', dir, { botId: 'bot-0000000a', taskId: 't-1', connectors: [con()] });
    try {
      const opts = { initialCommand: LINE, fanoutTaskOf: 'ws-owner', cwd: dir, workspaceId: 'ws-task' };
      const guarded = withBotWorkerMergeGuard(opts, botWorkerForCreate(opts, { dir, isBotTaskWorkspace: () => false }), deps())!;
      noteBotWorkerSession('pty-c', 'ws-task', dir, guardedLaunchOf(guarded));
    } finally {
      release();
    }
    expect(guardBotWorkerLaunch('pty-c', 'claude', 'claude', dir)).toBeNull();
  });
});

describe('the grant carries a connection\'s keys to its own launch only', () => {
  it('connection keys resolve only for a spawn whose connections hold them; plain names never name a connection key', async () => {
    const secrets = new SecretStore({ file: path.join(dir, 'secrets.json'), crypto: { state: () => 'ok', encrypt: (p) => Buffer.from(p), decrypt: (c) => c.toString() } });
    secrets.load();
    const lib = new ConnectorStore(path.join(dir, 'factory', 'connectors.json'), { botIds: () => new Set(['bot-0000000a']) });
    lib.load();
    lib.save({ ...con(), id: undefined } as never);
    secrets.set('GH_MCP_TOKEN', VALUE, { connectorId: 'con-0000000a' });
    setSecretStore(secrets);
    setConnectorStore(lib);
    setSecretGrantSource(() => secrets);
    __resetSecretGrantsForTesting();
    try {
      const cwd = path.join(dir, 'wt');
      const g = mintSecretGrant({ botId: 'bot-0000000a', taskId: 't-1', ownerWorkspaceId: 'ws', cwd, names: [], connectionNames: ['GH_MCP_TOKEN'] })!;
      expect(g).toBeTruthy();
      // A spawn without that connection does not get its key.
      expect(resolveSecretGrant(g, { strictBotWorker: true, fanoutTaskOf: 'ws', cwd, spawns: [{ botId: 'bot-0000000a', taskId: 't-1' }] }).ok).toBe(false);
      const g2 = mintSecretGrant({ botId: 'bot-0000000a', taskId: 't-1', ownerWorkspaceId: 'ws', cwd, names: [], connectionNames: ['GH_MCP_TOKEN'] })!;
      const ok = resolveSecretGrant(g2, { strictBotWorker: true, fanoutTaskOf: 'ws', cwd, spawns: [{ botId: 'bot-0000000a', taskId: 't-1', connectors: [con()] }] });
      expect(ok).toMatchObject({ ok: true, env: { GH_MCP_TOKEN: VALUE } });
      // A plain secret is never a connection's key, and a connection list only holds them.
      expect(mintSecretGrant({ botId: 'bot-0000000a', taskId: 't-1', ownerWorkspaceId: 'ws', cwd, names: ['GH_MCP_TOKEN'] })).toBeNull();
      secrets.set('NPM_TOKEN', 'npm_plain_value_123456');
      expect(mintSecretGrant({ botId: 'bot-0000000a', taskId: 't-1', ownerWorkspaceId: 'ws', cwd, names: [], connectionNames: ['NPM_TOKEN'] })).toBeNull();
      await lib.flush();
    } finally {
      setSecretGrantSource(null);
      setConnectorStore(null);
      setSecretStore(null);
    }
  });
});

describe('startup prune', () => {
  it('removes old files no session names, keeps named and fresh ones', () => {
    const guarded = withBotWorkerMergeGuard({ initialCommand: LINE, cwd: dir }, { workspaceId: 'ws-task', strict: false }, deps())!;
    noteBotWorkerSession('pty-1', 'ws-task', dir, guardedLaunchOf(guarded));
    const stale = path.join(dir, 'factory', 'worker-mcp', 'cccccccccccc.json');
    const fresh = path.join(dir, 'factory', 'worker-mcp', 'dddddddddddd.json');
    fs.writeFileSync(stale, '{}');
    fs.writeFileSync(fresh, '{}');
    const old = new Date(Date.now() - 2 * 24 * 3600_000);
    fs.utimesSync(stale, old, old);
    const w = wordsOf(guarded.initialCommand!);
    fs.utimesSync(w.mcp, old, old);
    expect(pruneWorkerLaunchFiles(dir)).toBe(1);
    expect(fs.existsSync(stale)).toBe(false);
    expect(fs.existsSync(fresh)).toBe(true);
    expect(fs.existsSync(w.mcp)).toBe(true);
  });
});
