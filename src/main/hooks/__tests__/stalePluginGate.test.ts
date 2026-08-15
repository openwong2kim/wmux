/**
 * #898 — the detector behind the "your plugin is still forcing prompts" notice.
 *
 * The property under test is that the decision is BEHAVIOURAL. Version numbers
 * cannot answer it: `plugin.json` stayed at 0.2.0 across the release that
 * introduced the permission gate, so the same version string names both a
 * harmless snapshot and a broken one. Each fixture below therefore pairs a
 * hooks.json with a bridge that actually writes (or does not write) a decision,
 * and they all carry the SAME version on purpose.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { detectStalePluginGates } from '../stalePluginGate';

const GATE_HOOKS = JSON.stringify({
  hooks: {
    PreToolUse: [
      { matcher: '', hooks: [{ type: 'command', command: 'node "${CLAUDE_PLUGIN_ROOT}/bin/wmux-bridge.mjs" PreToolUse --permission-gate' }] },
    ],
  },
});

/** A hooks.json from before the gate existed — the bridge is never asked. */
const PRE_GATE_HOOKS = JSON.stringify({
  hooks: {
    Stop: [
      { matcher: '', hooks: [{ type: 'command', command: 'node "${CLAUDE_PLUGIN_ROOT}/bin/wmux-bridge.mjs" Stop' }] },
    ],
  },
});

const BRIDGE_THAT_PROMPTS = `process.stdout.write(JSON.stringify({
  hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask' },
}));
`;

/** The fixed shape: exit 0 having written nothing at all. */
const BRIDGE_THAT_IS_SILENT = 'process.exit(0);\n';

let configDir: string;

function writeInstall(name: string, opts: { hooks: string; bridge: string }): string {
  const installPath = path.join(configDir, 'plugins', 'cache', 'wmux', name, '0.2.0');
  fs.mkdirSync(path.join(installPath, 'bin'), { recursive: true });
  fs.mkdirSync(path.join(installPath, 'hooks'), { recursive: true });
  fs.writeFileSync(path.join(installPath, 'hooks', 'hooks.json'), opts.hooks, 'utf8');
  fs.writeFileSync(path.join(installPath, 'bin', 'wmux-bridge.mjs'), opts.bridge, 'utf8');
  return installPath;
}

function writeRecord(entries: Record<string, Array<{ installPath: string; version: string }>>): void {
  const dir = path.join(configDir, 'plugins');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'installed_plugins.json'),
    JSON.stringify({ version: 2, plugins: entries }),
    'utf8',
  );
}

beforeEach(() => {
  configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-stale-gate-'));
});

afterEach(() => {
  fs.rmSync(configDir, { recursive: true, force: true });
});

describe('detectStalePluginGates', () => {
  it('reports an install whose bridge still writes a decision', async () => {
    const installPath = writeInstall('wmux-claude-integration', {
      hooks: GATE_HOOKS,
      bridge: BRIDGE_THAT_PROMPTS,
    });
    writeRecord({ 'wmux-claude-integration@wmux': [{ installPath, version: '0.2.0' }] });

    const found = await detectStalePluginGates({ configDir });
    expect(found).toHaveLength(1);
    expect(found[0].pluginKey).toBe('wmux-claude-integration@wmux');
    // The command has to name the marketplace-qualified id, because that is
    // what `claude plugin update` resolves.
    expect(found[0].updateCommand).toBe('claude plugin update wmux-claude-integration@wmux');
  });

  it('stays quiet for a bridge that writes nothing — same version', async () => {
    const installPath = writeInstall('wmux-claude-integration', {
      hooks: GATE_HOOKS,
      bridge: BRIDGE_THAT_IS_SILENT,
    });
    writeRecord({ 'wmux-claude-integration@wmux': [{ installPath, version: '0.2.0' }] });

    expect(await detectStalePluginGates({ configDir })).toEqual([]);
  });

  it('stays quiet when the install predates the gate, however old the bridge', async () => {
    // The bridge WOULD write a decision, but nothing ever invokes it with
    // --permission-gate, so warning about it would be a false alarm.
    const installPath = writeInstall('wmux-claude-integration', {
      hooks: PRE_GATE_HOOKS,
      bridge: BRIDGE_THAT_PROMPTS,
    });
    writeRecord({ 'wmux-claude-integration@wmux': [{ installPath, version: '0.2.0' }] });

    expect(await detectStalePluginGates({ configDir })).toEqual([]);
  });

  it('ignores other plugins that happen to be installed', async () => {
    const installPath = writeInstall('someone-elses-plugin', {
      hooks: GATE_HOOKS,
      bridge: BRIDGE_THAT_PROMPTS,
    });
    writeRecord({ 'someone-elses-plugin@wmux': [{ installPath, version: '0.2.0' }] });

    expect(await detectStalePluginGates({ configDir })).toEqual([]);
  });

  it('matches on the name half, so any marketplace the user added is covered', async () => {
    const installPath = writeInstall('wmux-claude-integration', {
      hooks: GATE_HOOKS,
      bridge: BRIDGE_THAT_PROMPTS,
    });
    writeRecord({ 'wmux-claude-integration@some-fork': [{ installPath, version: '0.2.0' }] });

    const found = await detectStalePluginGates({ configDir });
    expect(found).toHaveLength(1);
    expect(found[0].updateCommand).toBe('claude plugin update wmux-claude-integration@some-fork');
  });

  it('returns nothing rather than throwing when there is no plugin config', async () => {
    expect(await detectStalePluginGates({ configDir })).toEqual([]);
    fs.writeFileSync(path.join(configDir, 'garbage.json'), 'not json', 'utf8');
    expect(await detectStalePluginGates({ configDir: path.join(configDir, 'nope') })).toEqual([]);
  });

  it('survives a corrupt installed_plugins.json', async () => {
    const dir = path.join(configDir, 'plugins');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'installed_plugins.json'), '{ not json', 'utf8');
    expect(await detectStalePluginGates({ configDir })).toEqual([]);
  });

  it('does not touch the real home while probing', async () => {
    // The probe writes HOME/USERPROFILE at a throwaway dir. A bridge that logs
    // on this path must land there and nowhere else.
    const installPath = writeInstall('wmux-claude-integration', {
      hooks: GATE_HOOKS,
      bridge: `import fs from 'node:fs';
import path from 'node:path';
fs.writeFileSync(path.join(process.env.HOME, 'probe-marker'), process.env.HOME);
process.stdout.write('{"hookSpecificOutput":{"permissionDecision":"ask"}}');
`,
    });
    writeRecord({ 'wmux-claude-integration@wmux': [{ installPath, version: '0.2.0' }] });

    const realHome = os.homedir();
    const found = await detectStalePluginGates({ configDir });
    expect(found).toHaveLength(1);
    expect(fs.existsSync(path.join(realHome, 'probe-marker'))).toBe(false);
  });
});
