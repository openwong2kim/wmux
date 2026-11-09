// `wmux uninstall-integrations` and the Squirrel uninstall hook: the entries are
// written by the real installers into a temp home, beside a user's own, so the
// ownership checks are exercised against what wmux actually writes. The
// Squirrel layouts run on every platform, so this also runs on Windows CI, where
// the path rules (win32 case folding, Update.exe) are the real ones.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CODEX_HOOKS_BRIDGE_BASENAME } from '../../../shared/configIO';
import { getMcpTarget } from '../../../shared/mcpTargets';
import { stripBom } from '../../../shared/stripBom';
import { readSourceText } from '../../../test-utils/sourceText';
import { registerCodexHooks, registerCodexNotify, registerTarget } from '../../../shared/mcpRegistration';
import { buildOwnedHookFile } from '../../../shared/hooks/compatHookInstall';
import { openCodeTerminalChatIntegration } from '../../../shared/openCodeTerminalChatIntegration';
import { installAgyQuotaSensor } from '../../../main/quota/installAgyQuotaSensor';
import { FANOUT_WORKER_ALLOWED_TOOLS } from '../../../shared/workerLaunch';
import { allowFanoutWorkerTools, installHooks } from '../setupHooks';
import { installStatusline } from '../setupStatusline';
import {
  describeThisCopy,
  handleUninstallIntegrations,
  removeAgentIntegrations,
  type IntegrationRemovalReport,
  type WmuxCopy,
} from '../uninstallIntegrations';

const ENV_KEYS = ['HOME', 'USERPROFILE', 'WMUX_DATA_SUFFIX', 'WMUX_MCP_REGISTER_EXTERNAL', 'CLAUDE_CONFIG_DIR', 'COPILOT_HOME', 'CODEX_HOME', 'XDG_CONFIG_HOME'];
const REPO = path.resolve(__dirname, '..', '..', '..', '..');
let saved: Record<string, string | undefined>;
let home: string;
let installRoot: string;
let installed: WmuxCopy;

const at = (...parts: string[]) => path.join(home, ...parts);
const write = (file: string, text: string) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};
const readJson = (file: string) => JSON.parse(stripBom(fs.readFileSync(file, 'utf8')));
const run = (copy: WmuxCopy = installed, extra: { force?: boolean; deadlineMs?: number; now?: () => number } = {}) =>
  removeAgentIntegrations({ home, startDir: __dirname, copy, ...extra });
const find = (report: IntegrationRemovalReport, agent: string, item: string) =>
  report.items.filter((i) => i.agent === agent && i.item === item);

/** Every file under the temp home, by content. */
function snapshot(): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else out[path.relative(home, full)] = fs.readFileSync(full, 'utf8');
    }
  };
  walk(home);
  return out;
}

const bridgeSource = () => {
  const source = at('src', 'wmux-bridge.mjs');
  write(source, '// wmux bridge stub\n');
  return source;
};

function hookPaths(settingsPath = at('.claude', 'settings.json')) {
  return { settingsPath, bridgeDest: at('.wmux', 'hooks', 'wmux-bridge.mjs'), bridgeSource: bridgeSource() };
}

function statuslinePaths(targets: Array<{ label: string; settingsPath: string }>) {
  const scriptSource = at('src', 'wmux-statusline.mjs');
  write(scriptSource, '// statusline stub\n');
  return { targets, scriptDest: at('.wmux', 'hooks', 'wmux-statusline.mjs'), scriptSource };
}

/** A machine where wmux wrote into every agent, beside the user's own entries. */
function installEverything(): { accountSettings: string } {
  const script = path.join(installRoot, 'app-4.0.0', 'resources', 'mcp-bundle', 'index.js');
  write(script, '// bundle\n');
  write(at('.claude.json'), `${JSON.stringify({ projects: { a: 1 }, mcpServers: { mine: { command: 'uvx', args: ['mine'] } } })}\n`);
  write(at('.codex', 'config.toml'), '# my codex comment\nmodel = "x"\n\n[mcp_servers.mine]\ncommand = "uvx"\n');
  write(at('.gemini', 'settings.json'), '{ "theme": "dark" }\n');
  write(at('.qwen', 'settings.json'), '{ "theme": "dark" }\n');
  for (const id of ['claude', 'codex', 'gemini', 'qwen', 'agy']) {
    registerTarget(getMcpTarget(id)!, home, { kind: 'node', script });
  }
  write(at('.gemini', 'config', 'mcp_config.json'), '{}\n');
  registerTarget(getMcpTarget('agy')!, home, { kind: 'node', script });
  registerCodexNotify(home, at('.wmux', 'hooks', 'wmux-codex-notify.mjs'));
  registerCodexHooks(home, at('.wmux', 'hooks', CODEX_HOOKS_BRIDGE_BASENAME), 'codex-cli 0.200.0');

  const userHook = { matcher: '', hooks: [{ type: 'command', command: 'my-own-stop-hook' }] };
  // With a byte order mark, as a Windows editor saves it.
  write(at('.claude', 'settings.json'), `${String.fromCharCode(0xfeff)}${JSON.stringify({ model: 'opus', hooks: { Stop: [userHook] }, permissions: { allow: ['Bash(ls)'] } })}`);
  installHooks(hookPaths());
  allowFanoutWorkerTools(hookPaths());

  const accountDir = at('.wmux', 'accounts', 'claude-1');
  const accountSettings = path.join(accountDir, 'settings.json');
  write(accountSettings, JSON.stringify({ statusLine: { type: 'command', command: 'my-own-statusline' } }));
  write(at('.wmux', 'accounts.json'), JSON.stringify({ accounts: [{ name: 'work', vendor: 'claude', configDir: accountDir }] }));
  installHooks(hookPaths(accountSettings));

  const defaultSettings = at('.claude', 'settings.json');
  installStatusline(statuslinePaths([{ label: 'default', settingsPath: defaultSettings }]));
  // Forced over the user's own, so the removal has something to put back.
  installStatusline(statuslinePaths([{ label: 'work', settingsPath: accountSettings }]), { force: true });

  write(at('.copilot', 'hooks', 'wmux.json'), JSON.stringify(buildOwnedHookFile('copilot', at('.wmux', 'hooks', 'wmux-hooks-bridge.mjs'))));

  const configRoot = at('.config', 'opencode');
  write(path.join(configRoot, 'tui.json'), JSON.stringify({ plugin: ['my-plugin'], theme: 'x' }));
  write(path.join(configRoot, 'plugins', 'wmux.js'), '// wmux-managed: opencode-lifecycle-bridge\n');
  write(path.join(configRoot, 'plugins', 'mine.js'), '// my plugin\n');
  const chatSource = at('src', 'wmux-chat-tui.mjs');
  write(chatSource, '// wmux-managed: opencode-terminal-chat\n');
  const chat = openCodeTerminalChatIntegration({ configRoot, startDir: home, sourcePath: chatSource, install: true, version: '1.18.30' });
  expect(chat.state).toBe('current');

  expect(installAgyQuotaSensor(home, { copyScript: false, sinkScriptPath: at('.wmux', 'bin', 'quota-sink.js') }).ok).toBe(true);
  return { accountSettings };
}

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-uninstall-')));
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  // Otherwise OpenCode's folder would follow the machine's own setting.
  process.env.XDG_CONFIG_HOME = at('.config');
  installRoot = at('AppData', 'Local', 'wmux');
  installed = { installed: true, roots: [installRoot] };
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.restoreAllMocks();
  fs.rmSync(home, { recursive: true, force: true });
});

describe('removeAgentIntegrations', () => {
  it('removes every wmux entry and only those', () => {
    const { accountSettings } = installEverything();
    const report = run();

    expect(report.ok).toBe(true);
    expect(report.items.filter((i) => i.outcome === 'failed')).toEqual([]);

    const claudeJson = readJson(at('.claude.json'));
    expect(claudeJson.mcpServers).toEqual({ mine: { command: 'uvx', args: ['mine'] } });
    expect(claudeJson.projects).toEqual({ a: 1 });

    const settingsText = fs.readFileSync(at('.claude', 'settings.json'), 'utf8');
    expect(settingsText.charCodeAt(0)).toBe(0xfeff);
    const settings = readJson(at('.claude', 'settings.json'));
    expect(settings.model).toBe('opus');
    expect(settings.statusLine).toBeUndefined();
    expect(settings.hooks).toEqual({ Stop: [{ matcher: '', hooks: [{ type: 'command', command: 'my-own-stop-hook' }] }] });
    expect(settings.permissions.allow).toEqual(['Bash(ls)']);

    const account = readJson(accountSettings);
    expect(account.hooks).toBeUndefined();
    expect(account.statusLine.command).toBe('my-own-statusline');

    const toml = fs.readFileSync(at('.codex', 'config.toml'), 'utf8');
    expect(toml).toContain('# my codex comment');
    expect(toml).toContain('[mcp_servers.mine]');
    expect(toml).not.toMatch(/wmux/);

    expect(readJson(at('.gemini', 'settings.json'))).toEqual({ theme: 'dark' });
    expect(readJson(at('.qwen', 'settings.json'))).toEqual({ theme: 'dark' });
    expect(readJson(at('.gemini', 'config', 'mcp_config.json')).mcpServers).toBeUndefined();
    expect(readJson(at('.gemini', 'antigravity-cli', 'settings.json')).statusLine).toBeUndefined();
    expect(fs.existsSync(at('.copilot', 'hooks', 'wmux.json'))).toBe(false);

    const configRoot = at('.config', 'opencode');
    expect(fs.existsSync(path.join(configRoot, 'plugins', 'wmux.js'))).toBe(false);
    expect(fs.existsSync(path.join(configRoot, 'plugins', 'mine.js'))).toBe(true);
    expect(fs.existsSync(path.join(configRoot, 'wmux-chat-tui.mjs'))).toBe(false);
    expect(readJson(path.join(configRoot, 'tui.json'))).toEqual({ plugin: ['my-plugin'], theme: 'x' });
  });

  it('reports what happened to each item, per Claude folder', () => {
    const { accountSettings } = installEverything();
    const report = run();
    const hooks = find(report, 'Claude Code', 'hooks');
    expect(hooks.map((i) => [i.path, i.outcome])).toEqual([
      [at('.claude', 'settings.json'), 'removed'],
      [accountSettings, 'removed'],
    ]);
    const statusLines = find(report, 'Claude Code', 'statusLine');
    expect(statusLines[1].detail).toMatch(/is back/);
  });

  it('a second run changes nothing and finds nothing', () => {
    installEverything();
    expect(run().ok).toBe(true);
    const before = snapshot();
    const second = run();
    expect(second.ok).toBe(true);
    const leftovers = second.items.filter((i) => i.outcome !== 'not-present');
    expect(leftovers).toEqual([]);
    expect(snapshot()).toEqual(before);
  });

  it('puts back the agy statusLine the sensor chained', () => {
    const settings = at('.gemini', 'antigravity-cli', 'settings.json');
    write(settings, JSON.stringify({ statusLine: { type: 'command', command: 'my-agy-line', padding: 2 }, other: 1 }));
    installAgyQuotaSensor(home, { copyScript: false, sinkScriptPath: at('.wmux', 'bin', 'quota-sink.js') });
    expect(readJson(settings).statusLine.command).toContain('--chain-b64');
    const [item] = find(run(), 'Antigravity CLI', 'quota statusLine');
    expect(item.outcome).toBe('removed');
    expect(readJson(settings)).toEqual({ statusLine: { type: 'command', command: 'my-agy-line', padding: 2 }, other: 1 });
  });

  it('one failure does not stop the rest, and the reason is reported', () => {
    installEverything();
    write(at('.claude', 'settings.json'), '{ not json');
    write(at('.codex', 'config.toml'), 'this is [ not toml');
    const report = run();
    expect(report.ok).toBe(false);
    expect(find(report, 'Claude Code', 'hooks')[0]).toMatchObject({ outcome: 'failed', detail: expect.stringContaining('not valid JSON') });
    expect(find(report, 'Codex CLI', 'MCP server')[0].outcome).toBe('failed');
    expect(fs.readFileSync(at('.claude', 'settings.json'), 'utf8')).toBe('{ not json');
    expect(fs.readFileSync(at('.codex', 'config.toml'), 'utf8')).toBe('this is [ not toml');
    // Past both: still removed.
    expect(readJson(at('.claude.json')).mcpServers.wmux).toBeUndefined();
    expect(fs.existsSync(at('.config', 'opencode', 'plugins', 'wmux.js'))).toBe(false);
  });

  it('a held Claude config lock fails that item and the others still go', () => {
    installEverything();
    fs.mkdirSync(`${at('.claude.json')}.lock`);
    const report = run();
    expect(find(report, 'Claude Code', 'MCP server')[0]).toMatchObject({ outcome: 'failed', detail: expect.stringContaining('saving its config') });
    expect(readJson(at('.claude.json')).mcpServers.wmux).toBeDefined();
    expect(fs.readFileSync(at('.codex', 'config.toml'), 'utf8')).not.toMatch(/wmux/);
  }, 15_000);

  it('stops starting items once the budget is spent, and says so', () => {
    installEverything();
    const before = snapshot();
    let t = 0;
    const report = run(installed, { deadlineMs: 4000, now: () => (t += 5000) });
    expect(report.ok).toBe(false);
    expect(report.items.length).toBeGreaterThan(0);
    expect(report.items.every((i) => i.outcome === 'failed' && /budget/.test(i.detail ?? ''))).toBe(true);
    expect(snapshot()).toEqual(before);
  });
});

describe('another copy of wmux', () => {
  const claudeEntry = (script: string) =>
    write(at('.claude.json'), JSON.stringify({ mcpServers: { wmux: { command: 'node', args: [script] } } }));
  const mcpItem = (report: IntegrationRemovalReport) => find(report, 'Claude Code', 'MCP server')[0];

  it('the installed copy keeps an MCP entry naming another install that still exists', () => {
    const other = at('other-install', 'resources', 'mcp-bundle', 'index.js');
    write(other, '// bundle\n');
    claudeEntry(other);
    const report = run();
    expect(mcpItem(report)).toMatchObject({ outcome: 'kept', detail: expect.stringContaining(other) });
    expect(readJson(at('.claude.json')).mcpServers.wmux).toBeDefined();
    expect(report.ok).toBe(true);
  });

  it('--force removes it', () => {
    const other = at('other-install', 'index.js');
    write(other, '// bundle\n');
    claudeEntry(other);
    expect(mcpItem(run(installed, { force: true })).outcome).toBe('removed');
  });

  it('removes an entry under its own root, any app-* version, and one whose file is gone', () => {
    claudeEntry(path.join(installRoot, 'app-3.9.0', 'resources', 'mcp-bundle', 'index.js'));
    expect(mcpItem(run()).outcome).toBe('removed');
    claudeEntry(at('deleted-install', 'index.js'));
    expect(mcpItem(run()).outcome).toBe('removed');
  });

  it('a foreign entry under the wmux key stays', () => {
    write(at('.claude.json'), JSON.stringify({ mcpServers: { wmux: { command: 'uvx', args: ['something'] } } }));
    expect(mcpItem(run())).toMatchObject({ outcome: 'kept', detail: expect.stringContaining('not wmux') });
    expect(readJson(at('.claude.json')).mcpServers.wmux.command).toBe('uvx');
  });

  it('a portable copy leaves the shared slot to the installed app, and removes only its own', () => {
    installEverything();
    const stable = at('.wmux', 'mcp', 'index.js');
    write(stable, '// stable bundle\n');
    claudeEntry(stable);
    const before = snapshot();
    const portable: WmuxCopy = { installed: false, roots: [at('Downloads', 'wmux')] };

    const report = run(portable);
    expect(snapshot()).toEqual(before);
    expect(report.items.some((i) => i.outcome === 'removed')).toBe(false);
    expect(find(report, 'Claude Code', 'hooks')[0]).toMatchObject({ outcome: 'kept', detail: expect.stringContaining('not the installed') });
    expect(mcpItem(report).outcome).toBe('kept');

    const own = path.join(portable.roots[0], 'resources', 'mcp-bundle', 'index.js');
    write(own, '// bundle\n');
    claudeEntry(own);
    expect(mcpItem(run(portable)).outcome).toBe('removed');
  });
});

describe('an isolated instance', () => {
  it('touches nothing', () => {
    installEverything();
    const before = snapshot();
    process.env.WMUX_DATA_SUFFIX = '-test';
    const report = run();
    expect(report.ok).toBe(false);
    expect(report.skipped).toContain('WMUX_DATA_SUFFIX=-test');
    expect(report.items).toEqual([]);
    expect(snapshot()).toEqual(before);
    // --force does not reach past it.
    expect(run(installed, { force: true }).items).toEqual([]);
    expect(snapshot()).toEqual(before);
  });

  it('follows the external registration override', () => {
    installEverything();
    process.env.WMUX_DATA_SUFFIX = '-test';
    process.env.WMUX_MCP_REGISTER_EXTERNAL = '1';
    expect(run().skipped).toBeNull();
    expect(readJson(at('.claude.json')).mcpServers.wmux).toBeUndefined();
  });
});

describe('describeThisCopy', () => {
  it('win32: Update.exe above app-* makes it the Squirrel install, rooted above every version', () => {
    const root = '/Users/me/AppData/Local/wmux';
    const exists = (p: string) => path.basename(p) === 'Update.exe' && path.resolve(path.dirname(p)) === path.resolve(root);
    expect(describeThisCopy(`${root}/app-4.0.0/resources/cli-bundle`, { platform: 'win32', exists })).toEqual({ installed: true, roots: [root] });
  });

  it('win32: no Update.exe is a loose copy', () => {
    const copy = '/Users/me/Downloads/wmux-win32-x64';
    expect(describeThisCopy(`${copy}/resources/cli-bundle`, { platform: 'win32', exists: () => false })).toEqual({ installed: false, roots: [copy] });
  });

  // shouldUsePortableData reads POSIX paths, which is all a real macOS hands it.
  it.skipIf(process.platform === 'win32')('darwin: an app under Applications is installed, one on a mounted image is not', () => {
    const copy = (bundle: string) =>
      describeThisCopy(`${bundle}/Contents/Resources/cli-bundle`, { platform: 'darwin', home: '/Users/me', env: {} });
    expect(copy('/Applications/wmux.app')).toEqual({ installed: true, roots: ['/Applications/wmux.app'] });
    expect(copy('/Users/me/Applications/wmux.app').installed).toBe(true);
    expect(copy('/Volumes/wmux/wmux.app')).toEqual({ installed: false, roots: ['/Volumes/wmux/wmux.app'] });
    expect(copy('/Users/me/Downloads/wmux.app').installed).toBe(false);
  });

  it('linux: a package is installed wherever it mounts', () => {
    expect(describeThisCopy('/tmp/.mount_wmux123/resources/cli-bundle', { platform: 'linux' })).toEqual({ installed: true, roots: ['/tmp/.mount_wmux123'] });
  });

  it('a checkout is never the installed copy, on any platform', () => {
    const copy = describeThisCopy(path.join(REPO, 'dist', 'cli-bundle'));
    expect(copy.installed).toBe(false);
    expect(copy.roots.map((r) => fs.realpathSync(r))).toEqual([fs.realpathSync(REPO)]);
  });
});

describe('wmux uninstall-integrations', () => {
  class Exit extends Error {
    constructor(readonly code: number) { super(`exit ${code}`); }
  }
  beforeEach(() => {
    vi.spyOn(process, 'exit').mockImplementation(((code: number) => { throw new Exit(code); }) as never);
  });

  it('prints the report as JSON, and a checkout keeps the shared slot unless forced', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    installEverything();
    await handleUninstallIntegrations([], true);
    const kept = JSON.parse(log.mock.calls[0][0] as string) as IntegrationRemovalReport;
    expect(kept.ok).toBe(true);
    expect(kept.items.some((i) => i.item === 'hooks' && i.outcome === 'kept')).toBe(true);
    expect(readJson(at('.claude', 'settings.json')).hooks.SessionStart).toBeDefined();

    log.mockClear();
    await handleUninstallIntegrations(['--force'], true);
    const forced = JSON.parse(log.mock.calls[0][0] as string) as IntegrationRemovalReport;
    expect(forced.items.some((i) => i.item === 'hooks' && i.outcome === 'removed')).toBe(true);
    expect(readJson(at('.claude', 'settings.json')).hooks.SessionStart).toBeUndefined();
  });

  it('exits non-zero when refused, and rejects an unknown flag instead of running', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    installEverything();
    const before = snapshot();
    await expect(handleUninstallIntegrations(['--forse'], false)).rejects.toMatchObject({ code: 1 });
    expect(error.mock.calls[0][0]).toContain('--forse');
    process.env.WMUX_DATA_SUFFIX = '-test';
    await expect(handleUninstallIntegrations(['--force'], false)).rejects.toMatchObject({ code: 1 });
    expect(snapshot()).toEqual(before);
  });
});

describe('what the removal is pinned to', () => {
  it('the fan-out grants it removes are all in the wmux namespace', () => {
    expect(FANOUT_WORKER_ALLOWED_TOOLS.every((t) => t.startsWith('mcp__wmux__'))).toBe(true);
  });

  it('the shipped OpenCode plugins carry the markers it deletes by', () => {
    const plugins = path.join(REPO, 'integrations', 'opencode', 'plugins');
    expect(fs.readFileSync(path.join(plugins, 'wmux-chat-tui.mjs'), 'utf8')).toContain('wmux-managed: opencode-terminal-chat');
    expect(fs.readFileSync(path.join(plugins, 'wmux.js'), 'utf8')).toContain('wmux-managed: opencode-lifecycle-bridge');
  });

  it('the Squirrel hook runs it on uninstall only, before the file-removing steps', () => {
    const source = readSourceText(path.join(REPO, 'src', 'main', 'index.ts'));
    const start = source.indexOf("squirrelCmd === '--squirrel-uninstall'");
    const end = source.indexOf("squirrelCmd === '--squirrel-obsolete'", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const branch = source.slice(start, end);
    expect(source.split('removeAgentIntegrations(').length - 1).toBe(1);
    const call = branch.indexOf('removeAgentIntegrations(');
    expect(call).toBeGreaterThan(-1);
    expect(call).toBeLessThan(branch.indexOf('uninstallCliShim('));
    expect(call).toBeLessThan(branch.indexOf('terminateStagedDaemons('));
    expect(call).toBeLessThan(branch.indexOf("'--removeShortcut'"));
    expect(branch).toContain('deadlineMs: SQUIRREL_INTEGRATIONS_BUDGET_MS');
  });
});
