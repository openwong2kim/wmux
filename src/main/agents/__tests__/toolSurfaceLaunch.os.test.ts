import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyWmuxToolsToCommand, isWmuxToolsHint, locateWmuxMcpEntry } from '../toolSurfaceLaunch';
import { codexConfigPath, codexHasWmuxServer } from '../../../shared/mcpRegistration';
import { tokenize } from '../../../shared/agentResume';
import { MODEL_ENV_MARKER } from '../../../shared/workerLaunch';

// Config files go to the instance's (suffixed) data dir; the bundle lives in
// the unsuffixed stable copy McpRegistrar keeps.
const mcpDir = path.join('C:', 'u', '.wmux-dev', 'mcp');
const entry = path.join('C:', 'u', '.wmux', 'mcp', 'index.js');

function run(command: string, tools: 'full' | 'core' | 'role', role?: string, exists = true, codexRegistered = true) {
  const written: Record<string, string> = {};
  const logs: string[] = [];
  const out = applyWmuxToolsToCommand(command, { tools, ...(role ? { role } : {}) }, {
    mcpDir,
    entry,
    exists: () => exists,
    writeFile: (p, d) => { written[p] = d; },
    codexHasWmuxServer: () => codexRegistered,
    log: (line) => logs.push(line),
  });
  return { out, written, logs };
}

describe('wmux tool level on a role-bound launch line', () => {
  it('claude gets a config FILE (no JSON on the shell line) naming the surface', () => {
    const { out, written } = run('claude --model claude-sonnet-5-5', 'role', 'Planner');
    const file = path.join(mcpDir, 'surface-role-planner.json');
    expect(out).toBe(`claude --mcp-config="${file}" --model claude-sonnet-5-5`);
    expect(JSON.parse(written[file])).toEqual({ mcpServers: { wmux: { command: 'node', args: [entry, '--role=Planner'] } } });
  });

  it('codex gets TOML literal strings inside one double-quoted -c', () => {
    expect(run('codex --model gpt-6-sol', 'core', 'Reviewer').out).toBe(
      `codex -c "mcp_servers.wmux.args=['${entry}','--core']" --model gpt-6-sol`,
    );
    expect(run('codex', 'role', 'Tester').out).toBe(`codex -c "mcp_servers.wmux.args=['${entry}','--role=Tester']"`);
    expect(run('codex', 'full', 'Reviewer').out).toBe(`codex -c "mcp_servers.wmux.args=['${entry}']"`);
  });

  it('leaves agy, unknown launchers, hand-configured lines and a missing bundle alone', () => {
    expect(run('agy -i "x"', 'role', 'Builder').out).toBe('agy -i "x"');
    expect(run('npm test', 'core').out).toBe('npm test');
    expect(run('claude --mcp-config my.json', 'role', 'Planner').out).toBe('claude --mcp-config my.json');
    expect(run('claude --mcp-config=my.json', 'role', 'Planner').out).toBe('claude --mcp-config=my.json');
    expect(run('claude', 'core', undefined, false).out).toBe('claude');
    expect(run('claude', 'role', 'Custom').out).toBe('claude');
  });

  it('launches codex unchanged (and says why) when codex has no wmux server registered', () => {
    // codex-cli 0.158 aborts on either override without a registered server:
    // "invalid transport in `mcp_servers.wmux`".
    for (const [tools, role] of [['core', 'Reviewer'], ['role', 'Tester'], ['full', 'Reviewer']] as const) {
      const { out, logs } = run('codex --model gpt-6-sol', tools, role, true, false);
      expect(out).toBe('codex --model gpt-6-sol');
      expect(logs.join(' ')).toMatch(/codex has no wmux MCP server registered/);
    }
    // claude is unaffected: its --mcp-config file carries the whole server entry.
    expect(run('claude', 'core', undefined, true, false).out).toMatch(/^claude --mcp-config=/);
  });

  it('keeps a positional prompt a separate argument after the variadic --mcp-config', () => {
    // claude's --mcp-config takes <configs...>: in the space form the prompt
    // would be read as a second config file.
    const file = path.join(mcpDir, 'surface-core.json');
    const out = run('claude "fix the bug"', 'core').out;
    expect(out).toBe(`claude --mcp-config="${file}" "fix the bug"`);
    const words = tokenize(out).map((t) => t.value);
    expect(words).toEqual(['claude', `--mcp-config=${file}`, 'fix the bug']);
  });

  it('splices behind a leading model-env marker and keeps the marker in front', () => {
    const file = path.join(mcpDir, 'surface-core.json');
    const { out, written } = run(`${MODEL_ENV_MARKER}claude "$(cat '/m/p.md')"`, 'core');
    expect(out).toBe(`${MODEL_ENV_MARKER}claude --mcp-config="${file}" "$(cat '/m/p.md')"`);
    expect(written[file]).toBeDefined();
    // A marked line with a non-agent launcher is still left alone.
    expect(run(`${MODEL_ENV_MARKER}npm test`, 'core').out).toBe(`${MODEL_ENV_MARKER}npm test`);
  });

  it('validates the hint shape', () => {
    expect(isWmuxToolsHint({ tools: 'core' })).toBe(true);
    expect(isWmuxToolsHint({ tools: 'core', role: 'Planner' })).toBe(true);
    expect(isWmuxToolsHint({ tools: 'all' })).toBe(false);
    expect(isWmuxToolsHint('core')).toBe(false);
  });
});

// Run against BOTH path flavours on every OS: the locator walks parents with
// resolve(), so a fixture root must be absolute under the rules in force (a
// `D:/repo` literal is a relative path on POSIX). Each flavour gets its own
// absolute root and builds every expected path with its own join.
describe.each([
  ['posix', path.posix, '/'],
  ['win32', path.win32, 'D:\\'],
] as const)('locating the MCP bundle like McpRegistrar (%s paths)', (_name, p, root) => {
  const home = p.join(root, 'home', 'u');
  const res = p.join(root, 'app', 'resources');
  const has = (...present: string[]) => (candidate: string) => present.includes(candidate);

  it('packaged: prefers the unsuffixed stable copy, then the versioned resources bundle', () => {
    const stable = p.join(home, '.wmux', 'mcp', 'index.js');
    const versioned = p.join(res, 'mcp-bundle', 'index.js');
    const legacy = p.join(res, 'mcp', 'mcp', 'index.js');
    const base = { home, isPackaged: true, resourcesPath: res, pathApi: p, isolated: false };
    expect(locateWmuxMcpEntry({ ...base, exists: has(stable, versioned) })).toBe(stable);
    expect(locateWmuxMcpEntry({ ...base, exists: has(versioned) })).toBe(versioned);
    expect(locateWmuxMcpEntry({ ...base, exists: has(legacy) })).toBe(legacy);
    expect(locateWmuxMcpEntry({ ...base, exists: has() })).toBeNull();
    // A suffixed data dir is never where the bundle is.
    expect(locateWmuxMcpEntry({ ...base, exists: has(p.join(home, '.wmux-dev', 'mcp', 'index.js')) })).toBeNull();
  });

  it('packaged, isolated instance: its own bundle first (the stable copy is the installed app\'s), the copy as fallback', () => {
    const stable = p.join(home, '.wmux', 'mcp', 'index.js');
    const versioned = p.join(res, 'mcp-bundle', 'index.js');
    const legacy = p.join(res, 'mcp', 'mcp', 'index.js');
    const base = { home, isPackaged: true, resourcesPath: res, pathApi: p, isolated: true };
    expect(locateWmuxMcpEntry({ ...base, exists: has(stable, versioned) })).toBe(versioned);
    expect(locateWmuxMcpEntry({ ...base, exists: has(stable, legacy) })).toBe(legacy);
    expect(locateWmuxMcpEntry({ ...base, exists: has(stable) })).toBe(stable);
  });

  it('packaged: a data suffix in the environment counts as isolated', () => {
    const stable = p.join(home, '.wmux', 'mcp', 'index.js');
    const versioned = p.join(res, 'mcp-bundle', 'index.js');
    const base = { home, isPackaged: true, resourcesPath: res, pathApi: p, exists: has(stable, versioned) };
    const saved = { suffix: process.env.WMUX_DATA_SUFFIX, external: process.env.WMUX_MCP_REGISTER_EXTERNAL };
    try {
      process.env.WMUX_DATA_SUFFIX = '-e2e';
      delete process.env.WMUX_MCP_REGISTER_EXTERNAL;
      expect(locateWmuxMcpEntry(base)).toBe(versioned);
      // An instance that claims the registration slot also syncs the copy.
      process.env.WMUX_MCP_REGISTER_EXTERNAL = '1';
      expect(locateWmuxMcpEntry(base)).toBe(stable);
      delete process.env.WMUX_DATA_SUFFIX;
      delete process.env.WMUX_MCP_REGISTER_EXTERNAL;
      expect(locateWmuxMcpEntry(base)).toBe(stable);
    } finally {
      if (saved.suffix === undefined) delete process.env.WMUX_DATA_SUFFIX; else process.env.WMUX_DATA_SUFFIX = saved.suffix;
      if (saved.external === undefined) delete process.env.WMUX_MCP_REGISTER_EXTERNAL; else process.env.WMUX_MCP_REGISTER_EXTERNAL = saved.external;
    }
  });

  it('dev: dist/mcp/mcp/entry.js under the app path or a parent', () => {
    const repo = p.join(root, 'work', 'repo');
    const appPath = p.join(repo, '.vite', 'build');
    const base = { home, isPackaged: false, appPath, pathApi: p };
    // Found two levels up (the app path is .vite/build inside the checkout)…
    const dist = p.join(repo, 'dist', 'mcp', 'mcp', 'entry.js');
    expect(locateWmuxMcpEntry({ ...base, exists: has(dist) })).toBe(dist);
    // …and directly under the app path, which wins over a parent's.
    const own = p.join(appPath, 'dist', 'mcp', 'mcp', 'entry.js');
    expect(locateWmuxMcpEntry({ ...base, exists: has(dist, own) })).toBe(own);
    expect(locateWmuxMcpEntry({ ...base, exists: has() })).toBeNull();
    // The walk stops at the filesystem root instead of looping.
    expect(locateWmuxMcpEntry({ ...base, appPath: root, exists: has(p.join(root, 'dist', 'mcp', 'mcp', 'entry.js')) }))
      .toBe(p.join(root, 'dist', 'mcp', 'mcp', 'entry.js'));
  });
});

describe('the splice and the located entry', () => {

  it('the splice uses the located entry and writes the claude config under the data dir', () => {
    const dist = path.join('D:', 'repo', 'dist', 'mcp', 'mcp', 'entry.js');
    const written: Record<string, string> = {};
    const out = applyWmuxToolsToCommand('claude', { tools: 'core' }, {
      mcpDir, entry: dist, exists: (p) => p === dist, writeFile: (p, d) => { written[p] = d; },
    });
    const file = path.join(mcpDir, 'surface-core.json');
    expect(out).toBe(`claude --mcp-config="${file}"`);
    expect(JSON.parse(written[file]).mcpServers.wmux.args[0]).toBe(dist);
    // No bundle found: the line is left alone.
    expect(applyWmuxToolsToCommand('claude', { tools: 'core' }, { mcpDir, entry: null })).toBe('claude');
  });
});

describe('codex wmux server detection', () => {
  const write = (text: string | null): string => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-codexcfg-'));
    const file = path.join(dir, 'config.toml');
    if (text !== null) fs.writeFileSync(file, text);
    return file;
  };

  it('needs a [mcp_servers.wmux] table with a command', () => {
    const toml = (...lines: string[]) => `${lines.join('\n')}\n`;
    expect(codexHasWmuxServer(write(toml('[mcp_servers.wmux]', 'command = "node"', 'args = ["C:/u/.wmux/mcp/index.js"]')))).toBe(true);
    expect(codexHasWmuxServer(write(null))).toBe(false);
    expect(codexHasWmuxServer(write(''))).toBe(false);
    expect(codexHasWmuxServer(write(toml('[mcp_servers.other]', 'command = "node"')))).toBe(false);
    expect(codexHasWmuxServer(write(toml('[mcp_servers.wmux]', 'enabled = false')))).toBe(false);
    expect(codexHasWmuxServer(write('this is = = not toml'))).toBe(false);
  });

  it('reads CODEX_HOME from the launch env first, then falls back to <home>/.codex', () => {
    const home = path.join('C:', 'h');
    const saved = process.env.CODEX_HOME;
    delete process.env.CODEX_HOME;
    try {
      expect(codexConfigPath({ CODEX_HOME: path.join('C:', 'acct') }, home)).toBe(path.join('C:', 'acct', 'config.toml'));
      expect(codexConfigPath({}, home)).toBe(path.join(home, '.codex', 'config.toml'));
    } finally {
      if (saved !== undefined) process.env.CODEX_HOME = saved;
    }
  });
});
