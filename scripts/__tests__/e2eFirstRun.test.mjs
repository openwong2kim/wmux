// The rules that keep the first-run e2e scenario (scripts/e2e-first-run.mjs)
// isolated and its teardown exact: the sandbox env, the fake-agent shims, and
// the pid + creation-time bookkeeping that decides what it may kill.
// @wmux-lane unit
// Every helper takes the platform as an argument ('win32' is a string here,
// never process.platform), so the host OS cannot change a result.
import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  getDaemonSocketPath,
  getLegacySessionSocketPath,
  getMcpBrokerPipeName,
  getPipeName,
  getSessionSocketPath,
} from '../../src/shared/constants';
import { suffixRefusal } from '../lib/control-wmux-lib.mjs';
import {
  adoptDaemon,
  agentRanInPane,
  appEnvExtras,
  fakeAgentShims,
  FIRST_TASK_REPO_ORIGIN,
  firstTaskRepoFixture,
  INTERRUPT_EXIT_CODES,
  killSurvivors,
  mergeTrees,
  normalizeProcessRows,
  oneBotProfile,
  onceAsync,
  paneCdCommand,
  paneProbeCommand,
  paneProbeRefusal,
  parseRunArgs,
  removableLeftovers,
  runProcessTree,
  SANDBOX_PREFIX,
  sandboxBase,
  sandboxEnv,
  sandboxShellProfiles,
  sdkPromptWith,
  seededClaudeJson,
  squirrelInstallRefusal,
  survivors,
  verdictLine,
  writesOutsideSandbox,
} from '../lib/e2e-first-run-lib.mjs';

describe('parseRunArgs', () => {
  it('reads the app, keep, artifacts and suffix options', () => {
    expect(parseRunArgs(['--app', 'C:/out/wmux.exe', '--keep', '--artifacts', 'a', '--suffix', '-e2e-x'])).toEqual({
      app: 'C:/out/wmux.exe', keep: true, artifacts: 'a', suffix: '-e2e-x',
    });
  });

  it('rejects an unknown argument or a missing value', () => {
    expect(() => parseRunArgs(['--nope'])).toThrow(/unknown argument/);
    expect(() => parseRunArgs(['--app'])).toThrow(/needs a value/);
    expect(() => parseRunArgs(['--app', '--keep'])).toThrow(/needs a value/);
  });

  it('refuses a suffix control-wmux would refuse, before any path is built from it', () => {
    expect(() => parseRunArgs(['--suffix', '/../../x'])).toThrow(/--suffix: .*must look like/);
    expect(() => parseRunArgs(['--suffix', '-dev'])).toThrow(/reserved/);
    expect(parseRunArgs(['--suffix', '-verify-fr1']).suffix).toBe('-verify-fr1');
  });
});

describe('sandboxEnv', () => {
  it('Windows: every profile root points into the sandbox and the fakes lead PATH', () => {
    const env = sandboxEnv(
      { Path: 'C:\\Windows;C:\\Users\\me\\.local\\bin', USERPROFILE: 'C:\\Users\\me', HOMEDRIVE: 'C:', HOMEPATH: '\\Users\\me', APPDATA: 'C:\\Users\\me\\AppData\\Roaming', PATHEXT: '.COM;.EXE;.BAT;.CMD', codex_home: 'C:\\Users\\me\\.codex' },
      { home: 'C:\\T\\fr', fakeBin: 'C:\\T\\fr\\fake-bin', platform: 'win32' },
    );
    expect(env.USERPROFILE).toBe('C:\\T\\fr');
    // The owner's Codex home never leaks through (one spelling, in the sandbox).
    expect(env.CODEX_HOME).toBe('C:\\T\\fr\\.codex');
    expect(env.codex_home).toBeUndefined();
    expect(env.HOME).toBe('C:\\T\\fr');
    expect(env.APPDATA).toBe('C:\\T\\fr\\AppData\\Roaming');
    expect(env.LOCALAPPDATA).toBe('C:\\T\\fr\\AppData\\Local');
    expect(env.HOMEDRIVE).toBeUndefined();
    expect(env.HOMEPATH).toBeUndefined();
    // Same key spelling kept, fakes first.
    expect(env.Path).toBe('C:\\T\\fr\\fake-bin;C:\\Windows;C:\\Users\\me\\.local\\bin');
    expect(env.PATH).toBeUndefined();
    // The resolver only sees claude.js when .JS is a PATHEXT entry.
    expect(env.PATHEXT).toBe('.COM;.EXE;.BAT;.CMD;.JS');
  });

  it('POSIX: HOME is the sandbox and the XDG dirs derive from it', () => {
    const env = sandboxEnv(
      { PATH: '/usr/bin', HOME: '/home/me', XDG_CONFIG_HOME: '/home/me/.config', CODEX_HOME: '/home/me/.codex' },
      { home: '/tmp/fr', fakeBin: '/tmp/fr/fake-bin', platform: 'linux' },
    );
    expect(env).toEqual({ PATH: '/tmp/fr/fake-bin:/usr/bin', HOME: '/tmp/fr', CODEX_HOME: '/tmp/fr/.codex' });
  });
});

describe('appEnvExtras', () => {
  it('turns off the registry PATH refresh and never opts into external MCP registration', () => {
    const env = appEnvExtras({ fakeAgentLog: '/a/log.jsonl', claudeHooksFile: '/s/.claude/settings.json' });
    expect(env.WMUX_NO_PATH_REFRESH).toBe('1');
    // External registration writes under Electron's real home, not the sandbox.
    expect(env).not.toHaveProperty('WMUX_MCP_REGISTER_EXTERNAL');
    expect(env.FAKE_AGENT_LOG).toBe('/a/log.jsonl');
    expect(env.FAKE_CLAUDE_HOOKS).toBe('/s/.claude/settings.json');
    expect(env).not.toHaveProperty('WMUX_DATA_SUFFIX');
  });
});

describe('MCP registration stays in the sandbox', () => {
  it('seeds the wmux MCP entry the wizard reads', () => {
    expect(seededClaudeJson('/tmp/fr', 'linux')).toEqual({ mcpServers: { wmux: { command: 'node', args: ['/tmp/fr/.wmux/mcp/index.js'] } } });
  });

  it('flags a registrar write outside the sandbox home, case- and slash-insensitively', () => {
    const log = [
      '[McpRegistrar] Claude Code: wrote wmux → C:\\Users\\me\\.claude.json',
      '[McpRegistrar] MCP bundle synced to stable path → C:\\Users\\me\\.wmux\\mcp\\index.js',
      '[McpRegistrar] Registered wmux MCP → c:/temp/wmux-fr-x/.wmux/mcp/index.js',
      '[McpRegistrar] WMUX_DATA_SUFFIX=-e2e-x — skipping external agent config registration',
    ].join('\r\n');
    const out = writesOutsideSandbox(log, 'C:\\Temp\\wmux-fr-x');
    expect(out).toHaveLength(2);
    expect(out[0]).toContain('.claude.json');
    expect(writesOutsideSandbox('', 'C:\\Temp')).toEqual([]);
  });

  it('treats a sibling dir that shares the sandbox prefix as outside', () => {
    const log = [
      '[McpRegistrar] Registered wmux MCP → C:\\Temp\\wmux-fr-abc123-other\\.wmux\\mcp\\index.js',
      '[McpRegistrar] Registered wmux MCP → C:\\Temp\\wmux-fr-abc123\\.wmux\\mcp\\index.js',
      '[McpRegistrar] Registered wmux MCP → /tmp/wmux-fr-abc123other/.wmux/mcp/index.js',
    ].join('\n');
    const out = writesOutsideSandbox(log, 'C:\\Temp\\wmux-fr-abc123\\');
    expect(out).toHaveLength(2);
    expect(out[0]).toContain('wmux-fr-abc123-other');
    expect(writesOutsideSandbox(log.split('\n')[2], '/tmp/wmux-fr-abc123')).toHaveLength(1);
  });
});

describe('fakeAgentShims', () => {
  it('Windows: a .cmd for shells and a .js for wmux’s resolver, both running the fixture by full path', () => {
    const files = fakeAgentShims({ node: 'C:\\node\\node.exe', fixturesDir: 'D:\\repo dir\\fake-agents', platform: 'win32' });
    expect(files.map((f) => f.name)).toEqual(['claude.cmd', 'claude.js', 'codex.cmd', 'codex.js']);
    expect(files[0].content).toBe('@echo off\r\n"C:\\node\\node.exe" "D:\\repo dir\\fake-agents\\claude.mjs" %*\r\n');
    expect(files[1].content).toContain('import("file:///D:/repo%20dir/fake-agents/claude.mjs")');
  });

  it('POSIX: one executable script per agent', () => {
    const files = fakeAgentShims({ node: '/usr/bin/node', fixturesDir: '/repo/fake-agents', platform: 'linux' });
    expect(files).toEqual([
      { name: 'claude', content: '#!/bin/sh\nexec "/usr/bin/node" "/repo/fake-agents/claude.mjs" "$@"\n', mode: 0o755 },
      { name: 'codex', content: '#!/bin/sh\nexec "/usr/bin/node" "/repo/fake-agents/codex.mjs" "$@"\n', mode: 0o755 },
    ]);
  });

  it('refuses a path a shim could not quote safely', () => {
    expect(() => fakeAgentShims({ node: 'C:\\a"b\\node.exe', fixturesDir: 'D:\\f', platform: 'win32' })).toThrow(/not usable/);
    expect(() => fakeAgentShims({ node: 'C:\\%TEMP%\\node.exe', fixturesDir: 'D:\\f', platform: 'win32' })).toThrow(/not usable/);
  });
});

describe('process bookkeeping', () => {
  const win = normalizeProcessRows([
    { ProcessId: 10, ParentProcessId: 1, Name: 'wmux.exe', CreationDate: '/Date(1000)/', CommandLine: 'wmux.exe' },
    { ProcessId: 11, ParentProcessId: 10, Name: 'wmux.exe', CreationDate: '/Date(1100)/', CommandLine: 'wmux.exe --type=gpu-process' },
    { ProcessId: 20, ParentProcessId: 10, Name: 'wmux.exe', CreationDate: '/Date(2000)/', CommandLine: null },
    { ProcessId: 21, ParentProcessId: 20, Name: 'powershell.exe', CreationDate: '/Date(2100)/', CommandLine: 'powershell' },
    // A stale parent pid: created BEFORE pid 20 existed, so not its child.
    { ProcessId: 30, ParentProcessId: 20, Name: 'notepad.exe', CreationDate: '/Date(500)/', CommandLine: 'notepad' },
    { ProcessId: 40, ParentProcessId: 1, Name: 'explorer.exe', CreationDate: '/Date(100)/', CommandLine: 'explorer' },
  ], 'win32');

  it('normalises CIM rows (ConvertTo-Json dates, single-object output)', () => {
    expect(win[0]).toEqual({ ProcessId: 10, ParentProcessId: 1, Name: 'wmux.exe', CreationDate: 1000, CommandLine: 'wmux.exe' });
    expect(normalizeProcessRows({ ProcessId: 5, ParentProcessId: 1, Name: 'x', CreationDate: '/Date(7)/' }, 'win32')).toHaveLength(1);
  });

  it('parses ps lstart output', () => {
    const rows = normalizeProcessRows(
      '    1     0 Thu Oct 22 10:00:00 2026 /sbin/init\n  432     1 Thu Oct 22 10:00:05 2026 /usr/bin/node /x/claude.mjs hi there\nbad line\n',
      'linux',
    );
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ ProcessId: 432, ParentProcessId: 1, Name: 'node', CommandLine: '/usr/bin/node /x/claude.mjs hi there' });
    expect(rows[1].CreationDate).toBe(Date.parse('Thu Oct 22 10:00:05 2026'));
  });

  const app = { ProcessId: 10, CreationDate: 1000 };
  const daemon = { ProcessId: 20, CreationDate: 2000 };

  it('records the app and daemon trees, never a stale-parent stranger', () => {
    const tree = runProcessTree(win, [app, daemon, null]);
    expect(tree.map((r) => r.ProcessId).sort()).toEqual([10, 11, 20, 21]);
  });

  it('expands a root only while its pid still holds the recorded process', () => {
    // The app died early and pid 10 now belongs to an unrelated program that
    // started later, with children of its own: none of it is recorded.
    const reused = normalizeProcessRows([
      { ProcessId: 10, ParentProcessId: 1, Name: 'Photos.exe', CreationDate: '/Date(9000)/', CommandLine: 'Photos' },
      { ProcessId: 12, ParentProcessId: 10, Name: 'Photos.Helper.exe', CreationDate: '/Date(9100)/', CommandLine: 'helper' },
      { ProcessId: 20, ParentProcessId: 10, Name: 'wmux.exe', CreationDate: '/Date(2000)/', CommandLine: null },
      { ProcessId: 21, ParentProcessId: 20, Name: 'powershell.exe', CreationDate: '/Date(2100)/', CommandLine: 'powershell' },
    ], 'win32');
    expect(runProcessTree(reused, [app])).toEqual([]);
    // The daemon, still the recorded process, keeps its own tree.
    expect(runProcessTree(reused, [app, daemon]).map((r) => r.ProcessId).sort()).toEqual([20, 21]);
    // A bare pid is not an identity: nothing to expand.
    expect(runProcessTree(win, [10, 20])).toEqual([]);
  });

  it('a survivor is the same pid with the same creation time; a reused pid is not', () => {
    const recorded = runProcessTree(win, [app, daemon]);
    const now = [
      { ProcessId: 21, CreationDate: 2100 }, // still ours
      { ProcessId: 11, CreationDate: 9999 }, // pid reused by someone else
    ];
    expect(survivors(recorded, now).map((r) => r.ProcessId)).toEqual([21]);
  });

  it('merges snapshots without duplicates', () => {
    const a = runProcessTree(win, [app]);
    expect(mergeTrees(a, a, runProcessTree(win, [daemon])).length).toBe(4);
  });
});

describe('adoptDaemon', () => {
  const app = { ProcessId: 10, CreationDate: 1000 };
  const rows = [
    { ProcessId: 10, ParentProcessId: 1, Name: 'wmux.exe', CreationDate: 1000 },
    { ProcessId: 20, ParentProcessId: 10, Name: 'wmux.exe', CreationDate: 2000 },
    { ProcessId: 30, ParentProcessId: 7, Name: 'notepad.exe', CreationDate: 3000 },
    { ProcessId: 40, ParentProcessId: 10, Name: 'old.exe', CreationDate: 500 },
  ];

  it('ties the daemon to the run when it was seen in the verified app tree', () => {
    expect(adoptDaemon({ daemonPid: 20, rows: [rows[1]], app: null, recordedTree: [rows[1]] })).toEqual(rows[1]);
  });

  it('or when it is the recorded app’s child, created after it', () => {
    expect(adoptDaemon({ daemonPid: 20, rows, app })).toEqual(rows[1]);
    // After the app exits (Windows keeps the dead parent's pid on the child).
    expect(adoptDaemon({ daemonPid: 20, rows: rows.slice(1), app })).toEqual(rows[1]);
  });

  it('never a stale pid file naming a stranger, an older process, or a child of a reused app pid', () => {
    expect(adoptDaemon({ daemonPid: 30, rows, app })).toBeNull();
    expect(adoptDaemon({ daemonPid: 40, rows, app })).toBeNull();
    const reusedApp = [{ ProcessId: 10, ParentProcessId: 1, Name: 'Photos.exe', CreationDate: 1500 }, rows[1]];
    expect(adoptDaemon({ daemonPid: 20, rows: reusedApp, app })).toBeNull();
    expect(adoptDaemon({ daemonPid: 99, rows, app })).toBeNull();
    expect(adoptDaemon({ daemonPid: null, rows, app })).toBeNull();
  });

  it('POSIX: a daemon whose own environment carries the run’s suffix (macOS launchd job)', () => {
    expect(adoptDaemon({ daemonPid: 30, rows, app, envOwned: true })).toEqual(rows[2]);
  });
});

describe('removableLeftovers', () => {
  it('deletes only suffixed paths that appeared during the run', () => {
    const pre = ['C:\\Users\\me\\.wmux-e2e-x'];
    const now = ['C:\\Users\\me\\.wmux-e2e-x', 'C:\\Users\\me\\AppData\\Roaming\\wmux-e2e-x'];
    expect(removableLeftovers(now, pre)).toEqual(['C:\\Users\\me\\AppData\\Roaming\\wmux-e2e-x']);
    expect(removableLeftovers(now, [])).toEqual(now);
    expect(removableLeftovers([], pre)).toEqual([]);
  });
});

describe('squirrelInstallRefusal', () => {
  const lad = 'C:\\Users\\me\\AppData\\Local';
  it('refuses anything under the Squirrel install root, in any case', () => {
    expect(squirrelInstallRefusal('C:\\Users\\me\\AppData\\Local\\wmux\\app-4.0.0\\wmux.exe', lad, 'win32')).toMatch(/installed wmux/);
    expect(squirrelInstallRefusal('c:\\users\\ME\\appdata\\local\\WMUX\\wmux.exe', lad, 'win32')).toMatch(/installed wmux/);
  });

  it('refuses a child folder whose name starts with two dots', () => {
    expect(squirrelInstallRefusal('C:\\Users\\me\\AppData\\Local\\wmux\\..x\\wmux.exe', lad, 'win32')).toMatch(/installed wmux/);
    expect(squirrelInstallRefusal('C:\\Users\\me\\AppData\\Local\\wmux\\..\\wmux-other\\wmux.exe', lad, 'win32')).toBeNull();
  });

  it('accepts a packaged build elsewhere, a sibling folder, and other platforms', () => {
    expect(squirrelInstallRefusal('D:\\wmux\\out\\wmux-win32-x64\\wmux.exe', lad, 'win32')).toBeNull();
    expect(squirrelInstallRefusal('C:\\Users\\me\\AppData\\Local\\wmux-e2e\\wmux.exe', lad, 'win32')).toBeNull();
    expect(squirrelInstallRefusal('/Applications/wmux.app/Contents/MacOS/wmux', '/x', 'darwin')).toBeNull();
    expect(squirrelInstallRefusal('D:\\out\\wmux.exe', undefined, 'win32')).toBeNull();
  });
});

describe('agentRanInPane', () => {
  it('needs a tty start and then a prompt from the same agent', () => {
    const log = [
      JSON.stringify({ agent: 'claude', event: 'probe', kind: 'version' }),
      JSON.stringify({ agent: 'claude', event: 'start', tty: true }),
      JSON.stringify({ agent: 'claude', event: 'prompt', text: 'Use the wmux browser_open tool' }),
    ].join('\n');
    expect(agentRanInPane(log)).toEqual({ started: true, prompted: true });
    expect(agentRanInPane(JSON.stringify({ agent: 'claude', event: 'start', tty: false }))).toEqual({ started: false, prompted: false });
    expect(agentRanInPane(`not json\n${JSON.stringify({ agent: 'codex', event: 'start', tty: true })}`)).toEqual({ started: false, prompted: false });
  });
});

describe('teardown on Ctrl+C / SIGTERM', () => {
  it('runs one teardown however many callers ask, sharing its result', async () => {
    let calls = 0;
    const run = onceAsync(async () => { calls++; return { problems: [] }; });
    const [a, b] = await Promise.all([run(), run()]);
    expect(await run()).toBe(a);
    expect(b).toBe(a);
    expect(calls).toBe(1);
  });

  it('shares a failed teardown too, never retrying it', async () => {
    let calls = 0;
    const run = onceAsync(() => { calls++; throw new Error('boom'); });
    await expect(run()).rejects.toThrow('boom');
    await expect(run()).rejects.toThrow('boom');
    expect(calls).toBe(1);
  });

  it('exits 130 on SIGINT and 143 on SIGTERM', () => {
    expect(INTERRUPT_EXIT_CODES).toEqual({ SIGINT: 130, SIGTERM: 143 });
  });

  it('the driver tears down through the shared runner from the main flow and both signals', () => {
    const src = fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'e2e-first-run.mjs'), 'utf8');
    expect(src).toMatch(/const runTeardown = onceAsync\(teardown\);/);
    expect(src).toMatch(/for \(const \[signal, exitCode\] of Object\.entries\(INTERRUPT_EXIT_CODES\)\) \{\s*process\.once\(signal,/);
    expect(src).toMatch(/await runTeardown\(\)/);
    expect(src).not.toMatch(/await teardown\(\)/);
  });
});

describe('verdictLine', () => {
  it('is one line either way', () => {
    expect(verdictLine({ ok: true, seconds: 12.34 })).toBe('first-run e2e: PASS (12.3 s)');
    expect(verdictLine({ ok: false, step: 'Claude card ready', reason: 'never\nready', seconds: 3 })).toBe('first-run e2e: FAIL at Claude card ready: never ready (3.0 s)');
  });
});

describe('macOS daemon sockets fit sun_path', () => {
  const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
  afterEach(() => {
    Object.defineProperty(process, 'platform', realPlatform);
    vi.unstubAllEnvs();
  });

  it('keeps the sandbox off the long per-user temp dir on macOS only', () => {
    const asIs = (p) => p;
    expect(sandboxBase('darwin', '/var/folders/ab/cdefghijklmnopqrstuvwxyz0123/T', asIs)).toBe('/tmp');
    // Resolved, so the sandbox paths the driver predicts read like the
    // /private/tmp/… the app logs.
    expect(sandboxBase('darwin', '/var/folders/ab/cdefghijklmnopqrstuvwxyz0123/T', (p) => (p === '/tmp' ? '/private/tmp' : p))).toBe('/private/tmp');
    expect(sandboxBase('linux', '/tmp')).toBe('/tmp');
    expect(sandboxBase('win32', path.win32.join('C:', 'Temp'))).toBe(path.win32.join('C:', 'Temp'));
  });

  it('the longest socket path the driver can produce stays within 103 bytes', () => {
    // The longest suffix control-wmux accepts (the driver launches through it).
    const suffix = `-a${'b'.repeat(39)}`;
    expect(suffixRefusal(suffix)).toBeNull();
    expect(suffixRefusal(`${suffix}c`)).not.toBeNull();
    // The session id shape the app gives each pane (pty.handler.ts).
    const handler = fs.readFileSync(path.join(REPO, 'src', 'main', 'ipc', 'handlers', 'pty.handler.ts'), 'utf8');
    const idShape = /`daemon-\$\{randomUUID\(\)\.slice\(0, (\d+)\)\}`/.exec(handler);
    expect(idShape, 'pty.handler.ts no longer builds `daemon-<uuid prefix>` session ids; update this check').not.toBeNull();
    const sessionId = `daemon-${'f'.repeat(Number(idShape[1]))}`;
    // mkdtemp appends six characters. /tmp is a symlink to /private/tmp on
    // macOS, and sandboxBase returns the resolved form, the longer one.
    const home = path.posix.join(sandboxBase('darwin', undefined, () => '/private/tmp'), `${SANDBOX_PREFIX}XXXXXX`);
    Object.defineProperty(process, 'platform', { ...realPlatform, value: 'darwin' });
    vi.stubEnv('HOME', home);
    // os.homedir() reads USERPROFILE on a Windows host; same value as HOME.
    vi.stubEnv('USERPROFILE', home);
    vi.stubEnv('WMUX_DATA_SUFFIX', suffix);
    const sockets = [
      getSessionSocketPath(sessionId),
      getDaemonSocketPath(),
      getLegacySessionSocketPath(sessionId),
      getPipeName(),
      getMcpBrokerPipeName(),
    ];
    for (const s of sockets) expect(s.startsWith(home)).toBe(true);
    const longest = Math.max(...sockets.map((s) => Buffer.byteLength(s)));
    expect(longest).toBeLessThanOrEqual(103);
  });
});

describe('killSurvivors', () => {
  const a = { ProcessId: 10, CreationDate: 100, Name: 'a' };
  const b = { ProcessId: 11, CreationDate: 110, Name: 'b' };

  it('POSIX: re-lists before each kill and spares a pid that changed hands', async () => {
    const killed = [];
    let listed = 0;
    const tables = [
      [a, b],
      // By the second kill, pid 11 belongs to someone else.
      [{ ...b, CreationDate: 999 }],
    ];
    const out = await killSurvivors([a, b], {
      platform: 'linux',
      listRows: async () => tables[listed++],
      killPosix: async (pid) => { killed.push(pid); },
      killWindows: async () => { throw new Error('not on POSIX'); },
    });
    expect(killed).toEqual([10]);
    expect(listed).toBe(2);
    expect(out).toEqual([{ pid: 10, result: 'killed' }, { pid: 11, result: 'gone' }]);
  });

  it('POSIX: kills nothing when the table cannot be read', async () => {
    const killed = [];
    const out = await killSurvivors([a], { platform: 'darwin', listRows: async () => null, killPosix: (pid) => killed.push(pid), killWindows: null });
    expect(killed).toEqual([]);
    expect(out[0].result).toMatch(/not killed/);
  });

  it('Windows: one pinned-handle call with every recorded creation time', async () => {
    let seen = null;
    const out = await killSurvivors([a, b], {
      platform: 'win32',
      listRows: async () => { throw new Error('the handle call checks identity itself'); },
      killPosix: () => { throw new Error('never a bare-pid kill'); },
      killWindows: async (targets) => { seen = targets; return { 10: 'killed', 11: 'mismatch' }; },
    });
    expect(seen).toEqual([{ pid: 10, createdAt: 100 }, { pid: 11, createdAt: 110 }]);
    expect(out).toEqual([{ pid: 10, result: 'killed' }, { pid: 11, result: 'mismatch' }]);
  });
});

describe('the pane runs the fake claude (P2-2)', () => {
  it('a sandbox ~/.zprofile puts the fakes back ahead of path_helper, POSIX only', () => {
    expect(sandboxShellProfiles('/tmp/wmux-fr-x/fake-bin', 'darwin')).toEqual([
      { name: '.zprofile', content: 'export PATH="/tmp/wmux-fr-x/fake-bin:$PATH"\n' },
    ]);
    expect(sandboxShellProfiles('C:/s/fake-bin', 'win32')).toEqual([]);
  });

  it('sandboxEnv drops an inherited ZDOTDIR, so zsh reads the sandbox dotfiles', () => {
    const env = sandboxEnv({ PATH: '/bin', ZDOTDIR: '/Users/owner/.config/zsh' }, { home: '/tmp/s', fakeBin: '/tmp/s/fake-bin', platform: 'darwin' });
    expect(env.ZDOTDIR).toBeUndefined();
  });

  it('asks the shell which claude it would run', () => {
    expect(paneProbeCommand('/tmp/s/claude-probe.txt', 'darwin')).toBe("{ command -v claude || echo NOT-FOUND; } > '/tmp/s/claude-probe.txt' 2>&1");
    expect(paneProbeCommand('C:\\s\\claude-probe.txt', 'win32')).toContain("Get-Command claude");
    expect(paneProbeCommand('C:\\s\\claude-probe.txt', 'win32')).toContain("-LiteralPath 'C:\\s\\claude-probe.txt'");
    expect(() => paneProbeCommand("/tmp/it's", 'linux')).toThrow(/quote/);
  });

  it('accepts only the fake, and refuses a real install, an alias or nothing', () => {
    const fake = '/tmp/wmux-fr-x/fake-bin';
    expect(paneProbeRefusal('/tmp/wmux-fr-x/fake-bin/claude\n', fake, 'darwin')).toBeNull();
    expect(paneProbeRefusal('/usr/local/bin/claude\n', fake, 'darwin')).toMatch(/not the fake.*real Claude Code/);
    expect(paneProbeRefusal('claude: aliased to /opt/homebrew/bin/claude\n', fake, 'darwin')).toMatch(/not the fake/);
    expect(paneProbeRefusal('NOT-FOUND\n', fake, 'linux')).toMatch(/not the fake/);
    expect(paneProbeRefusal('', fake, 'linux')).toMatch(/nothing/);
  });

  it('Windows: an Application under the fake dir, BOM and case aside', () => {
    const fake = path.win32.join('C:', 'Temp', 'wmux-fr-x', 'fake-bin');
    const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(`Application|${path.win32.join(fake.toUpperCase(), 'claude.cmd')}\r\n`)]);
    expect(paneProbeRefusal(bom, fake, 'win32')).toBeNull();
    expect(paneProbeRefusal(`Application|${path.win32.join('C:', 'Users', 'u', '.local', 'bin', 'claude.exe')}`, fake, 'win32')).toMatch(/real Claude Code/);
    expect(paneProbeRefusal('Alias|', fake, 'win32')).toMatch(/a Alias/);
    expect(paneProbeRefusal('|', fake, 'win32')).toMatch(/not found/);
  });
});

describe('the first task', () => {
  it('builds a repository with a GitHub origin and one commit, without reading any git config', () => {
    const { files, git } = firstTaskRepoFixture();
    expect(files.map((f) => f.name)).toEqual(['README.md']);
    expect(git[0].slice(-2)).toEqual(['init', '-q']);
    expect(git).toContainEqual(['remote', 'add', 'origin', FIRST_TASK_REPO_ORIGIN]);
    expect(FIRST_TASK_REPO_ORIGIN).toMatch(/^https:\/\/github\.com\/[^/]+\/[^/]+\.git$/);
    // The commit carries its own identity and never signs (no prompt, no key).
    const commit = git.find((g) => g.includes('commit'));
    expect(commit).toEqual(expect.arrayContaining(['-c', 'user.name=wmux e2e', 'commit.gpgsign=false', 'commit']));
    expect(git.indexOf(commit)).toBe(git.length - 1);
  });

  it('moves a pane into the folder and writes where it landed, per shell; refuses a quote', () => {
    expect(paneCdCommand('/tmp/wmux-fr-1/first-run-e2e', '/tmp/wmux-fr-1/pane-cwd.txt', 'darwin'))
      .toBe("cd '/tmp/wmux-fr-1/first-run-e2e' && pwd -P > '/tmp/wmux-fr-1/pane-cwd.txt'");
    expect(paneCdCommand('C:\\T\\fr\\first-run-e2e', 'C:\\T\\fr\\cwd.txt', 'win32'))
      .toBe("Set-Location -LiteralPath 'C:\\T\\fr\\first-run-e2e'; (Get-Location).Path | Set-Content -Encoding UTF8 -LiteralPath 'C:\\T\\fr\\cwd.txt'");
    expect(() => paneCdCommand("/tmp/it's", '/tmp/x', 'linux')).toThrow(/quote/);
  });

  it('reads bots.json as exactly one bot profile, naming what is wrong otherwise', () => {
    const one = JSON.stringify({ version: 1, bots: [{ id: 'bot-1', name: 'Repo guide', repo: { repoPath: '/r' } }], removed: [] });
    expect(oneBotProfile(one)).toEqual({ ok: true, bot: { id: 'bot-1', name: 'Repo guide', repoPath: '/r' } });
    expect(oneBotProfile(JSON.stringify({ version: 1, bots: [] }))).toEqual({ ok: false, reason: 'bots.json holds 0 bot profiles, not 1' });
    expect(oneBotProfile(JSON.stringify({ version: 1, bots: [{ id: 'a' }, { id: 'b' }] })).reason).toMatch(/2 bot profiles/);
    expect(oneBotProfile(JSON.stringify({ version: 2, bots: [] })).ok).toBe(false);
    expect(oneBotProfile('{').reason).toMatch(/not JSON/);
  });

  it('finds the Agent SDK prompt holding the task, whatever the prompt wraps around it', () => {
    const log = [
      JSON.stringify({ agent: 'claude', event: 'sdk-start' }),
      JSON.stringify({ agent: 'claude', event: 'prompt', text: 'Explain this repository' }),
      JSON.stringify({ agent: 'claude', event: 'sdk-prompt', prompt: 'You are a bot.\nThe owner wrote:\n  Explain   this\nrepository, briefly.' }),
      'not json',
    ].join('\n');
    const found = sdkPromptWith(log, 'Explain this repository, briefly.');
    expect(found.prompts).toHaveLength(1);
    expect(found.match).toContain('The owner wrote');
    // A TUI prompt (a pane's agent) is not the bot's turn.
    expect(sdkPromptWith(log, 'Something else').match).toBeNull();
    expect(sdkPromptWith('', 'x')).toEqual({ prompts: [], match: null });
  });
});
