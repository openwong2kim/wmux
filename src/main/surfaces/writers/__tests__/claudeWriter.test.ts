import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { applySurfaceChanges, previewSurfaceChanges } from '../index';
import { createClaudeWriter } from '../claudeWriter';
import { readInventory } from '../../inventory';
import { ConfigChangedError, SurfacesStore } from '../../safeWrite';
import type { WriterDeps } from '../types';
import type { SurfaceItem } from '../../../../shared/tokenUsage/surfaceTypes';

// Real files on disk, several applies per test: slow Windows runners need more than vitest's 5 s.
vi.setConfig({ testTimeout: 30_000 });

/**
 * Make `file` impossible to replace, on every platform. A read-only file
 * blocks the atomic rename on Windows only; on Linux/macOS rename(2) needs
 * write permission on the DIRECTORY, so the parent is locked too there.
 * Returns the function that undoes both.
 */
function makeUnwritable(file: string): () => void {
  const dir = path.dirname(file);
  fs.chmodSync(file, 0o444);
  if (process.platform !== 'win32') fs.chmodSync(dir, 0o555);
  return () => {
    try { if (process.platform !== 'win32') fs.chmodSync(dir, 0o755); } catch { /* best-effort */ }
    try { fs.chmodSync(file, 0o666); } catch { /* best-effort */ }
  };
}

function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function makeDeps(home: string, projectDir?: string): WriterDeps {
  return {
    homeDir: home,
    projectDir,
    run: async (cmd, args) => {
      if (cmd === 'claude' && args[0] === '--version') return '1.0.5';
      return '1.0.5';
    },
    now: () => 1_000,
    surfacesStorePath: path.join(home, '.wmux', 'surfaces.json'),
  };
}

describe('claudeWriter', () => {
  let tempHome: string;
  let tempProj: string;

  beforeEach(() => {
    tempHome = makeTempDir('claude-writer-home-');
    tempProj = makeTempDir('claude-writer-proj-');
  });

  afterEach(() => {
    try {
      fs.rmSync(tempHome, { recursive: true, force: true });
    } catch {}
    try {
      fs.rmSync(tempProj, { recursive: true, force: true });
    } catch {}
  });

  function seedFixtures() {
    const claudeDir = path.join(tempHome, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });

    // 1. ~/.claude.json
    const claudeJson = {
      mcpServers: {
        'user-server': { command: 'node', args: ['server.js'] },
        'user-server-2': { command: 'node' },
      },
      projects: {
        [tempProj]: {
          mcpServers: {
            'proj-server': { command: 'python', args: ['server.py'] },
            'proj-server-disabled': { command: 'python' },
          },
          disabledMcpServers: ['proj-server-disabled'],
          extraProjectData: { custom: 123 },
        },
      },
      unrelatedCliMeta: { version: '1.0.0', customFlag: true },
    };
    fs.writeFileSync(path.join(tempHome, '.claude.json'), JSON.stringify(claudeJson, null, 2), 'utf8');

    // 2. ~/.claude/settings.json
    const settingsJson = {
      permissions: {
        deny: ['WebSearch', 'mcp__user-server__denied_tool'],
      },
      enabledPlugins: {
        'active-plugin@store': true,
        'disabled-plugin@store': false,
      },
      skillOverrides: {
        'disabled-skill': 'off',
      },
      deniedMcpServers: [{ serverName: 'user-server-2' }],
      autoMemoryEnabled: true,
      skillListingBudgetFraction: 0.25,
      claudeMdExcludes: ['vendor/**'],
      hooks: {
        PreToolUse: [
          { type: 'command', name: 'check-tool', command: 'echo 1' },
          { type: 'command', name: 'log-tool', command: 'echo 2' },
        ],
        Stop: [
          { type: 'command', name: 'stop-hook', command: 'node stop.js' },
        ],
      },
      unrelatedSettingsKey: 'keep-me',
    };
    fs.writeFileSync(path.join(claudeDir, 'settings.json'), JSON.stringify(settingsJson, null, 2), 'utf8');

    // 3. User skills on disk
    const skillsDir = path.join(claudeDir, 'skills');
    fs.mkdirSync(path.join(skillsDir, 'my-skill'), { recursive: true });
    fs.writeFileSync(
      path.join(skillsDir, 'my-skill', 'SKILL.md'),
      '---\nname: my-skill\ndescription: Test skill\n---\nBody',
      'utf8',
    );
    fs.mkdirSync(path.join(skillsDir, 'disabled-skill'), { recursive: true });
    fs.writeFileSync(
      path.join(skillsDir, 'disabled-skill', 'SKILL.md'),
      '---\nname: disabled-skill\ndescription: Disabled\n---\nBody',
      'utf8',
    );
  }

  it('toggles user MCP server disable and re-enable with backup and round-trip equality', async () => {
    seedFixtures();
    const deps = makeDeps(tempHome, tempProj);
    const inv = await readInventory('claude', { homeDir: tempHome, projectDir: tempProj, run: deps.run });
    const userServer = inv.items.find((i) => i.name === 'user-server' && i.kind === 'mcp-server')!;
    expect(userServer).toBeDefined();
    expect(userServer.enabled).toBe(true);

    // Preview disable
    const previewDis = await previewSurfaceChanges(
      { provider: 'claude', changes: [{ itemId: userServer.id, enabled: false }] },
      { deps },
    );
    expect(previewDis.rejected).toHaveLength(0);
    expect(previewDis.edits).toHaveLength(1);
    expect(previewDis.edits[0].summary).toContain('add "user-server" to deniedMcpServers');

    // Apply disable
    const disResult = await applySurfaceChanges(
      { provider: 'claude', changes: [{ itemId: userServer.id, enabled: false }] },
      { deps },
    );
    expect(disResult.ok).toBe(true);
    expect(disResult.appliedItemIds).toContain(userServer.id);
    expect(disResult.backups.length).toBeGreaterThan(0);
    expect(fs.existsSync(disResult.backups[0])).toBe(true);

    // Fresh inventory sees disabled
    const invAfterDis = await readInventory('claude', { homeDir: tempHome, projectDir: tempProj, run: deps.run });
    const userServerAfterDis = invAfterDis.items.find((i) => i.name === 'user-server' && i.kind === 'mcp-server')!;
    expect(userServerAfterDis.enabled).toBe(false);

    // Re-enable
    const enResult = await applySurfaceChanges(
      { provider: 'claude', changes: [{ itemId: userServer.id, enabled: true }] },
      { deps },
    );
    expect(enResult.ok).toBe(true);
    expect(enResult.appliedItemIds).toContain(userServer.id);

    // Fresh inventory sees enabled
    const invAfterEn = await readInventory('claude', { homeDir: tempHome, projectDir: tempProj, run: deps.run });
    const userServerAfterEn = invAfterEn.items.find((i) => i.name === 'user-server' && i.kind === 'mcp-server')!;
    expect(userServerAfterEn.enabled).toBe(true);

    // Verify unrelated keys preserved
    const settings = JSON.parse(fs.readFileSync(path.join(tempHome, '.claude', 'settings.json'), 'utf8'));
    expect(settings.unrelatedSettingsKey).toBe('keep-me');
  });

  it('toggles project MCP server in ~/.claude.json and cleans both places on enable', async () => {
    seedFixtures();
    const deps = makeDeps(tempHome, tempProj);
    const inv = await readInventory('claude', { homeDir: tempHome, projectDir: tempProj, run: deps.run });
    const projServer = inv.items.find((i) => i.name === 'proj-server' && i.kind === 'mcp-server')!;
    expect(projServer).toBeDefined();
    expect(projServer.enabled).toBe(true);

    // Disable project server
    const disResult = await applySurfaceChanges(
      { provider: 'claude', changes: [{ itemId: projServer.id, enabled: false }] },
      { deps, inventoryDeps: { projectDir: tempProj } },
    );
    expect(disResult.ok).toBe(true);

    const cjAfterDis = JSON.parse(fs.readFileSync(path.join(tempHome, '.claude.json'), 'utf8'));
    expect(cjAfterDis.projects[tempProj].disabledMcpServers).toContain('proj-server');

    // Also add to settings.json deniedMcpServers to test BOTH places cleaned on enable
    const settingsPath = path.join(tempHome, '.claude', 'settings.json');
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    settings.deniedMcpServers.push({ serverName: 'proj-server' });
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf8');

    // Enable project server -> should clean BOTH ~/.claude.json AND settings.json
    const enResult = await applySurfaceChanges(
      { provider: 'claude', changes: [{ itemId: projServer.id, enabled: true }] },
      { deps, inventoryDeps: { projectDir: tempProj } },
    );
    expect(enResult.ok).toBe(true);

    const cjAfterEn = JSON.parse(fs.readFileSync(path.join(tempHome, '.claude.json'), 'utf8'));
    expect(cjAfterEn.projects[tempProj].disabledMcpServers).not.toContain('proj-server');
    expect(cjAfterEn.projects[tempProj].disabledMcpServers).toContain('proj-server-disabled');

    const settingsAfterEn = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    const inSettings = settingsAfterEn.deniedMcpServers?.some((d: any) => d.serverName === 'proj-server');
    expect(inSettings).toBeFalsy();
  });

  it('refuses project MCP server toggle if projectDir is unknown', async () => {
    seedFixtures();
    const deps = makeDeps(tempHome, undefined);
    const writer = createClaudeWriter();
    const item: SurfaceItem = {
      id: 'claude:mcp-server::proj-server',
      provider: 'claude',
      kind: 'mcp-server',
      name: 'proj-server',
      parent: null,
      source: 'project',
      enabled: true,
      effect: 'removes',
      toggleable: true,
      readOnlyReason: null,
      hookEvent: null,
      hookCost: null,
      descriptionChars: null,
      originPath: path.join(tempHome, '.claude.json'),
      wmuxRequired: false,
    };

    await expect(
      writer.apply({
        deps,
        inventory: {
          provider: 'claude',
          cliVersion: '1.0.5',
          versionSupported: true,
          writable: true,
          items: [item],
          warnings: [],
          scannedAtMs: 0,
        },
        changes: [{ item, enabled: false }],
      }),
    ).rejects.toThrow('Project directory is required');
  });

  // Three config edits with backups and repeated inventory reads exercise real disk I/O on a loaded runner.
  it('toggles mcp-tool and builtin-tool via permissions.deny', { timeout: 30_000 }, async () => {
    seedFixtures();
    const deps = makeDeps(tempHome, tempProj);
    const inv = await readInventory('claude', { homeDir: tempHome, projectDir: tempProj, run: deps.run });

    const deniedTool = inv.items.find((i) => i.name === 'denied_tool' && i.kind === 'mcp-tool')!;
    expect(deniedTool).toBeDefined();
    expect(deniedTool.enabled).toBe(false);

    const webSearch = inv.items.find((i) => i.name === 'WebSearch' && i.kind === 'builtin-tool')!;
    expect(webSearch).toBeDefined();
    expect(webSearch.enabled).toBe(false);

    // Re-enable WebSearch via applySurfaceChanges
    const enWeb = await applySurfaceChanges(
      { provider: 'claude', changes: [{ itemId: webSearch.id, enabled: true }] },
      { deps },
    );
    expect(enWeb.ok).toBe(true);

    const settings1 = JSON.parse(fs.readFileSync(path.join(tempHome, '.claude', 'settings.json'), 'utf8'));
    expect(settings1.permissions?.deny?.includes('WebSearch')).toBeFalsy();

    // Re-enable mcp-tool
    const enTool = await applySurfaceChanges(
      { provider: 'claude', changes: [{ itemId: deniedTool.id, enabled: true }] },
      { deps },
    );
    expect(enTool.ok).toBe(true);

    // Re-disable WebSearch using writer directly (since config only records denied tools)
    const writer = createClaudeWriter();
    const disWeb = await writer.apply({
      deps,
      inventory: inv,
      changes: [{ item: webSearch, enabled: false }],
    });
    expect(disWeb.ok).toBe(true);
    const settings2 = JSON.parse(fs.readFileSync(path.join(tempHome, '.claude', 'settings.json'), 'utf8'));
    expect(settings2.permissions.deny).toContain('WebSearch');
  });

  it('toggles plugins via enabledPlugins', async () => {
    seedFixtures();
    const deps = makeDeps(tempHome, tempProj);
    const inv = await readInventory('claude', { homeDir: tempHome, projectDir: tempProj, run: deps.run });

    const activePlugin = inv.items.find((i) => i.name === 'active-plugin@store' && i.kind === 'plugin')!;
    expect(activePlugin.enabled).toBe(true);

    // Disable plugin
    const disRes = await applySurfaceChanges(
      { provider: 'claude', changes: [{ itemId: activePlugin.id, enabled: false }] },
      { deps },
    );
    expect(disRes.ok).toBe(true);

    const inv2 = await readInventory('claude', { homeDir: tempHome, projectDir: tempProj, run: deps.run });
    const plugin2 = inv2.items.find((i) => i.name === 'active-plugin@store' && i.kind === 'plugin')!;
    expect(plugin2.enabled).toBe(false);

    // Re-enable plugin
    const enRes = await applySurfaceChanges(
      { provider: 'claude', changes: [{ itemId: activePlugin.id, enabled: true }] },
      { deps },
    );
    expect(enRes.ok).toBe(true);

    const inv3 = await readInventory('claude', { homeDir: tempHome, projectDir: tempProj, run: deps.run });
    const plugin3 = inv3.items.find((i) => i.name === 'active-plugin@store' && i.kind === 'plugin')!;
    expect(plugin3.enabled).toBe(true);
  });

  it('toggles skills via skillOverrides and cleans up key when enabled', async () => {
    seedFixtures();
    const deps = makeDeps(tempHome, tempProj);
    const inv = await readInventory('claude', { homeDir: tempHome, projectDir: tempProj, run: deps.run });

    const mySkill = inv.items.find((i) => i.name === 'my-skill' && i.kind === 'skill')!;
    expect(mySkill.enabled).toBe(true);

    // Disable skill
    const disRes = await applySurfaceChanges(
      { provider: 'claude', changes: [{ itemId: mySkill.id, enabled: false }] },
      { deps },
    );
    expect(disRes.ok).toBe(true);

    const inv2 = await readInventory('claude', { homeDir: tempHome, projectDir: tempProj, run: deps.run });
    const skill2 = inv2.items.find((i) => i.name === 'my-skill' && i.kind === 'skill')!;
    expect(skill2.enabled).toBe(false);

    // Re-enable skill
    const enRes = await applySurfaceChanges(
      { provider: 'claude', changes: [{ itemId: mySkill.id, enabled: true }] },
      { deps },
    );
    expect(enRes.ok).toBe(true);

    const inv3 = await readInventory('claude', { homeDir: tempHome, projectDir: tempProj, run: deps.run });
    const skill3 = inv3.items.find((i) => i.name === 'my-skill' && i.kind === 'skill')!;
    expect(skill3.enabled).toBe(true);
  });

  it('switches boolean context-settings both ways and keeps numbers and lists read-only', async () => {
    seedFixtures();
    const deps = makeDeps(tempHome, tempProj);
    const settingsFile = path.join(tempHome, '.claude', 'settings.json');
    const inventoryOf = () => readInventory('claude', { homeDir: tempHome, projectDir: tempProj, run: deps.run });
    const find = (items: SurfaceItem[], name: string) =>
      items.find((i) => i.name === name && i.kind === 'context-setting')!;

    let inv = await inventoryOf();
    const autoMem = find(inv.items, 'autoMemoryEnabled');
    expect(autoMem.enabled).toBe(true);

    // Off, then back on: the inventory must report the real value or re-enabling is refused.
    const off = await applySurfaceChanges({ provider: 'claude', changes: [{ itemId: autoMem.id, enabled: false }] }, { deps });
    expect(off.ok).toBe(true);
    expect(JSON.parse(fs.readFileSync(settingsFile, 'utf8')).autoMemoryEnabled).toBe(false);
    inv = await inventoryOf();
    expect(find(inv.items, 'autoMemoryEnabled').enabled).toBe(false);
    const on = await applySurfaceChanges({ provider: 'claude', changes: [{ itemId: autoMem.id, enabled: true }] }, { deps });
    expect(on.ok).toBe(true);
    expect(JSON.parse(fs.readFileSync(settingsFile, 'utf8')).autoMemoryEnabled).toBe(true);

    // A number or a list is shown but cannot be switched, and the value stays.
    for (const name of ['skillListingBudgetFraction', 'claudeMdExcludes']) {
      const item = find(inv.items, name);
      expect(item.toggleable).toBe(false);
      expect(item.enabled).toBeNull();
      const res = await applySurfaceChanges({ provider: 'claude', changes: [{ itemId: item.id, enabled: false }] }, { deps });
      expect(res.ok).toBe(false);
    }
    const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    expect(settings.skillListingBudgetFraction).toBe(0.25);
    expect(settings.claudeMdExcludes).toEqual(['vendor/**']);
  });

  it('inverts disable* keys: switching the feature off writes true', async () => {
    const deps = makeDeps(tempHome, tempProj);
    fs.mkdirSync(path.join(tempHome, '.claude'), { recursive: true });
    const settingsFile = path.join(tempHome, '.claude', 'settings.json');
    fs.writeFileSync(settingsFile, JSON.stringify({ disableBundledSkills: false }), 'utf8');

    const inv = await readInventory('claude', { homeDir: tempHome, run: deps.run });
    const item = inv.items.find((i) => i.name === 'disableBundledSkills')!;
    expect(item.enabled).toBe(true);
    const res = await applySurfaceChanges({ provider: 'claude', changes: [{ itemId: item.id, enabled: false }] }, { deps });
    expect(res.ok).toBe(true);
    expect(JSON.parse(fs.readFileSync(settingsFile, 'utf8')).disableBundledSkills).toBe(true);
  });

  it('hook disable then enable restores a definition deep-equal to the original and the hooks structure equals the original except possibly ordering within the same matcher group', async () => {
    const deps = makeDeps(tempHome, tempProj);
    const claudeDir = path.join(tempHome, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });

    // Setup settings.json with matcher groups
    const originalHooks = {
      PreToolUse: [
        {
          matcher: 'Bash',
          hooks: [
            { type: 'command', name: 'check-bash', command: 'echo 1' },
            { type: 'command', name: 'log-bash', command: 'echo 2' },
          ],
        },
      ],
      Stop: [
        {
          hooks: [
            { type: 'command', name: 'stop-hook', command: 'node stop.js' },
          ],
        },
      ],
    };
    const settingsPath = path.join(claudeDir, 'settings.json');
    fs.writeFileSync(settingsPath, JSON.stringify({ hooks: originalHooks }, null, 2), 'utf8');

    const originalHandler = { type: 'command', name: 'check-bash', command: 'echo 1' };
    const hookItem: SurfaceItem = {
      id: 'claude:hook::check-bash',
      provider: 'claude',
      kind: 'hook',
      name: 'check-bash',
      parent: null,
      source: 'user',
      enabled: true,
      effect: 'removes',
      toggleable: true,
      readOnlyReason: null,
      hookEvent: 'PreToolUse',
      hookCost: 'none',
      descriptionChars: null,
      originPath: settingsPath,
      wmuxRequired: false,
    };

    const writer = createClaudeWriter();

    // 1. Disable hook
    const disResult = await writer.apply({
      deps,
      inventory: {
        provider: 'claude',
        cliVersion: '1.0.5',
        versionSupported: true,
        writable: true,
        items: [hookItem],
        warnings: [],
        scannedAtMs: 0,
      },
      changes: [{ item: hookItem, enabled: false }],
    });
    expect(disResult.ok).toBe(true);

    // Verify handler removed from settings.json
    const settingsAfterDis = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    const preToolHooks = settingsAfterDis.hooks.PreToolUse[0].hooks;
    expect(preToolHooks.some((h: any) => h.name === 'check-bash')).toBe(false);
    expect(preToolHooks.some((h: any) => h.name === 'log-bash')).toBe(true);

    // Verify hook definition in surfaces.json store
    const store = new SurfacesStore(deps.surfacesStorePath);
    store.load();
    const storedHook = store.removedHooks.get('claude', hookItem.id);
    expect((storedHook?.definition as any)?.handler).toEqual(originalHandler);
    expect((storedHook?.definition as any)?.event).toBe('PreToolUse');

    // 2. Re-enable hook via writer.apply
    const enResult = await writer.apply({
      deps,
      inventory: {
        provider: 'claude',
        cliVersion: '1.0.5',
        versionSupported: true,
        writable: true,
        items: [hookItem],
        warnings: [],
        scannedAtMs: 0,
      },
      changes: [{ item: hookItem, enabled: true }],
    });
    expect(enResult.ok).toBe(true);

    // Verify definition deep-equal to original and hooks structure equals original
    const settingsAfterEn = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    const restoredGroupHooks = settingsAfterEn.hooks.PreToolUse[0].hooks;
    const restoredHandler = restoredGroupHooks.find((h: any) => h.name === 'check-bash');
    expect(restoredHandler).toEqual(originalHandler);

    // Matcher group and events equal original
    expect(settingsAfterEn.hooks.PreToolUse[0].matcher).toBe(originalHooks.PreToolUse[0].matcher);
    expect(settingsAfterEn.hooks.Stop).toEqual(originalHooks.Stop);
    expect(restoredGroupHooks).toHaveLength(2);
  });

  it('crash simulation — if applyConfigEdit throws after removedHooks.add, the definition is still in the store', async () => {
    seedFixtures();
    const deps = makeDeps(tempHome, tempProj);
    const settingsPath = path.join(tempHome, '.claude', 'settings.json');

    const hookItem: SurfaceItem = {
      id: 'claude:hook::check-tool',
      provider: 'claude',
      kind: 'hook',
      name: 'check-tool',
      parent: null,
      source: 'user',
      enabled: true,
      effect: 'removes',
      toggleable: true,
      readOnlyReason: null,
      hookEvent: 'PreToolUse',
      hookCost: 'none',
      descriptionChars: null,
      originPath: settingsPath,
      wmuxRequired: false,
    };

    // Make the settings file read-only on disk to trigger write failure in applyConfigEdit
    const restoreWritable = makeUnwritable(settingsPath);

    const writer = createClaudeWriter();
    const result = await writer.apply({
      deps,
      inventory: {
        provider: 'claude',
        cliVersion: '1.0.5',
        versionSupported: true,
        writable: true,
        items: [hookItem],
        warnings: [],
        scannedAtMs: 0,
      },
      changes: [{ item: hookItem, enabled: false }],
    });

    // Restore permissions
    restoreWritable();

    // Writer should report failure
    expect(result.ok).toBe(false);

    // But the definition MUST still be in the store on disk!
    const store = new SurfacesStore(deps.surfacesStorePath);
    store.load();
    const entry = store.removedHooks.get('claude', hookItem.id);
    expect(entry).toBeDefined();
    expect(entry?.id).toBe(hookItem.id);
    expect(entry?.definition).toBeDefined();
  });

  it('~/.claude.json edit keeps every other key (including unknown ones) byte-for-byte', async () => {
    seedFixtures();
    const deps = makeDeps(tempHome, tempProj);
    const claudeJsonPath = path.join(tempHome, '.claude.json');

    // Add extra unknown keys with specific types
    const cj = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf8'));
    cj.customTopLevel = 'unmodified-value';
    cj.deepNested = { a: [1, 2, 3], b: { c: 'hello' } };
    fs.writeFileSync(claudeJsonPath, JSON.stringify(cj, null, 2), 'utf8');

    const inv = await readInventory('claude', { homeDir: tempHome, projectDir: tempProj, run: deps.run });
    const projServer = inv.items.find((i) => i.name === 'proj-server' && i.kind === 'mcp-server')!;

    // Disable project server
    await applySurfaceChanges(
      { provider: 'claude', changes: [{ itemId: projServer.id, enabled: false }] },
      { deps },
    );

    const cjAfter = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf8'));
    expect(cjAfter.customTopLevel).toBe('unmodified-value');
    expect(cjAfter.deepNested).toEqual({ a: [1, 2, 3], b: { c: 'hello' } });
    expect(cjAfter.unrelatedCliMeta).toEqual({ version: '1.0.0', customFlag: true });
    expect(cjAfter.projects[tempProj].extraProjectData).toEqual({ custom: 123 });
  });

  it('deniedMcpServers and disabledMcpServers both cleaned on enable', async () => {
    seedFixtures();
    const deps = makeDeps(tempHome, tempProj);
    const claudeJsonPath = path.join(tempHome, '.claude.json');
    const settingsPath = path.join(tempHome, '.claude', 'settings.json');

    // Set server to be the only item in both places
    const cj = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf8'));
    cj.projects[tempProj].disabledMcpServers = ['shared-server'];
    fs.writeFileSync(claudeJsonPath, JSON.stringify(cj, null, 2), 'utf8');

    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    settings.deniedMcpServers = [{ serverName: 'shared-server' }];
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf8');

    const item: SurfaceItem = {
      id: 'claude:mcp-server::shared-server',
      provider: 'claude',
      kind: 'mcp-server',
      name: 'shared-server',
      parent: null,
      source: 'project',
      enabled: false,
      effect: 'removes',
      toggleable: true,
      readOnlyReason: null,
      hookEvent: null,
      hookCost: null,
      descriptionChars: null,
      originPath: claudeJsonPath,
      // The inventory records which settings file holds the deny.
      settingsPath,
      wmuxRequired: false,
    };

    const writer = createClaudeWriter();
    const res = await writer.apply({
      deps,
      inventory: {
        provider: 'claude',
        cliVersion: '1.0.5',
        versionSupported: true,
        writable: true,
        items: [item],
        warnings: [],
        scannedAtMs: 0,
      },
      changes: [{ item, enabled: true }],
    });

    expect(res.ok).toBe(true);

    const cjAfter = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf8'));
    expect(cjAfter.projects[tempProj].disabledMcpServers).toBeUndefined();

    const settingsAfter = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    expect(settingsAfter.deniedMcpServers).toBeUndefined();
  });

  it('handles ConfigChangedError safely if file was modified concurrently', async () => {
    seedFixtures();
    const deps = makeDeps(tempHome, tempProj);
    const inv = await readInventory('claude', { homeDir: tempHome, projectDir: tempProj, run: deps.run });
    const userServer = inv.items.find((i) => i.name === 'user-server' && i.kind === 'mcp-server')!;

    // Modify settings.json after snapshot simulation or lock
    const settingsPath = path.join(tempHome, '.claude', 'settings.json');

    // Simulate ConfigChangedError
    const writer = createClaudeWriter();

    // Use vitest spy to throw ConfigChangedError
    const safeWrite = await import('../../safeWrite');
    const spy = vi.spyOn(safeWrite, 'applyConfigEdit').mockImplementationOnce(() => {
      throw new ConfigChangedError(settingsPath, 'modified');
    });

    const result = await writer.apply({
      deps,
      inventory: inv,
      changes: [{ item: userServer, enabled: false }],
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBe('The configuration changed while editing; reload and try again.');
    spy.mockRestore();
  });

  it('refuses symlink/escape paths outside homeDir and projectDir', async () => {
    seedFixtures();
    const outsideDir = makeTempDir('claude-outside-');
    try {
      const deps = makeDeps(tempHome, tempProj);
      const outsideSettings = path.join(outsideDir, 'secret-settings.json');
      fs.writeFileSync(outsideSettings, JSON.stringify({ autoMemoryEnabled: true }), 'utf8');

      const item: SurfaceItem = {
        id: 'claude:context-setting::autoMemoryEnabled@outside',
        provider: 'claude',
        kind: 'context-setting',
        name: 'autoMemoryEnabled',
        parent: null,
        source: 'user',
        enabled: true,
        effect: 'removes',
        toggleable: true,
        readOnlyReason: null,
        hookEvent: null,
        hookCost: null,
        descriptionChars: null,
        originPath: outsideSettings,
        wmuxRequired: false,
      };

      const writer = createClaudeWriter();
      const preview = await writer.preview({
        deps,
        inventory: {
          provider: 'claude',
          cliVersion: '1.0.5',
          versionSupported: true,
          writable: true,
          items: [item],
          warnings: [],
          scannedAtMs: 0,
        },
        changes: [{ item, enabled: false }],
      });
      expect(preview.edits).toHaveLength(0);

      const apply = await writer.apply({
        deps,
        inventory: {
          provider: 'claude',
          cliVersion: '1.0.5',
          versionSupported: true,
          writable: true,
          items: [item],
          warnings: [],
          scannedAtMs: 0,
        },
        changes: [{ item, enabled: false }],
      });
      expect(apply.appliedItemIds).not.toContain(item.id);
    } finally {
      try {
        fs.rmSync(outsideDir, { recursive: true, force: true });
      } catch {}
    }
  });

  it('fails with ok: false when enabling a hook whose definition is missing from store', async () => {
    seedFixtures();
    const deps = makeDeps(tempHome, tempProj);
    const settingsPath = path.join(tempHome, '.claude', 'settings.json');

    const hookItem: SurfaceItem = {
      id: 'claude:hook::nonexistent-hook',
      provider: 'claude',
      kind: 'hook',
      name: 'nonexistent-hook',
      parent: null,
      source: 'user',
      enabled: false,
      effect: 'removes',
      toggleable: true,
      readOnlyReason: null,
      hookEvent: 'PreToolUse',
      hookCost: 'none',
      descriptionChars: null,
      originPath: settingsPath,
      wmuxRequired: false,
    };

    const writer = createClaudeWriter();
    const res = await writer.apply({
      deps,
      inventory: {
        provider: 'claude',
        cliVersion: '1.0.5',
        versionSupported: true,
        writable: true,
        items: [hookItem],
        warnings: [],
        scannedAtMs: 0,
      },
      changes: [{ item: hookItem, enabled: true }],
    });

    expect(res.ok).toBe(false);
    expect(res.error).toBe('Cannot enable hook: definition not found in store');
    expect(res.appliedItemIds).toEqual([]);
  });

  it('refuses plugin skills and managed hooks from being toggled', async () => {
    seedFixtures();
    const deps = makeDeps(tempHome, tempProj);
    const settingsPath = path.join(tempHome, '.claude', 'settings.json');

    const pluginSkill: SurfaceItem = {
      id: 'claude:skill::plugin-skill',
      provider: 'claude',
      kind: 'skill',
      name: 'plugin-skill',
      parent: null,
      source: 'plugin',
      enabled: true,
      effect: 'removes',
      toggleable: false,
      readOnlyReason: 'Plugin skills cannot be toggled in Claude Code',
      hookEvent: null,
      hookCost: null,
      descriptionChars: null,
      originPath: path.join(tempHome, '.claude', 'plugins', 'p1', 'skills', 's1', 'SKILL.md'),
      wmuxRequired: false,
    };

    const managedHook: SurfaceItem = {
      id: 'claude:hook::managed-hook',
      provider: 'claude',
      kind: 'hook',
      name: 'managed-hook',
      parent: null,
      source: 'managed',
      enabled: true,
      effect: 'removes',
      toggleable: false,
      readOnlyReason: 'Managed hooks cannot be toggled',
      hookEvent: 'Stop',
      hookCost: 'none',
      descriptionChars: null,
      originPath: settingsPath,
      wmuxRequired: false,
    };

    const writer = createClaudeWriter();
    const preview = await writer.preview({
      deps,
      inventory: {
        provider: 'claude',
        cliVersion: '1.0.5',
        versionSupported: true,
        writable: true,
        items: [pluginSkill, managedHook],
        warnings: [],
        scannedAtMs: 0,
      },
      changes: [
        { item: pluginSkill, enabled: false },
        { item: managedHook, enabled: false },
      ],
    });
    expect(preview.edits).toHaveLength(0);

    const apply = await writer.apply({
      deps,
      inventory: {
        provider: 'claude',
        cliVersion: '1.0.5',
        versionSupported: true,
        writable: true,
        items: [pluginSkill, managedHook],
        warnings: [],
        scannedAtMs: 0,
      },
      changes: [
        { item: pluginSkill, enabled: false },
        { item: managedHook, enabled: false },
      ],
    });
    expect(apply.appliedItemIds).toHaveLength(0);
  });

  it('enabling a hook preserves the definition in the store if the settings write fails', async () => {
    seedFixtures();
    const deps = makeDeps(tempHome, tempProj);
    const settingsPath = path.join(tempHome, '.claude', 'settings.json');

    const hookItem: SurfaceItem = {
      id: 'claude:hook::pre-saved-hook',
      provider: 'claude',
      kind: 'hook',
      name: 'pre-saved-hook',
      parent: null,
      source: 'user',
      enabled: false,
      effect: 'removes',
      toggleable: true,
      readOnlyReason: null,
      hookEvent: 'PreToolUse',
      hookCost: 'none',
      descriptionChars: null,
      originPath: settingsPath,
      wmuxRequired: false,
    };

    // Pre-populate store with a removed hook definition
    const hookDef = { type: 'command', name: 'pre-saved-hook', command: 'echo hello-safe' };
    const store = new SurfacesStore(deps.surfacesStorePath);
    store.load();
    store.removedHooks.add('claude', {
      id: hookItem.id,
      definition: {
        event: 'PreToolUse',
        groupMeta: { matcher: 'Bash' },
        handler: hookDef,
      },
      originPath: settingsPath,
    });
    store.save();

    // Make settings.json read-only so applyConfigEdit fails on write
    const restoreWritable = makeUnwritable(settingsPath);

    const writer = createClaudeWriter();
    const result = await writer.apply({
      deps,
      inventory: {
        provider: 'claude',
        cliVersion: '1.0.5',
        versionSupported: true,
        writable: true,
        items: [hookItem],
        warnings: [],
        scannedAtMs: 0,
      },
      changes: [{ item: hookItem, enabled: true }],
    });

    // Restore permissions
    restoreWritable();

    expect(result.ok).toBe(false);

    // Verify definition is STILL in the store on disk
    const storeAfter = new SurfacesStore(deps.surfacesStorePath);
    storeAfter.load();
    const entry = storeAfter.removedHooks.get('claude', hookItem.id);
    expect(entry).toBeDefined();
    expect((entry?.definition as any)?.handler).toEqual(hookDef);

    // Verify hook is still not in settings.json (still disabled)
    const settingsAfter = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    const preTool = settingsAfter.hooks?.PreToolUse ?? [];
    const hasHook = preTool.some((g: any) =>
      Array.isArray(g.hooks)
        ? g.hooks.some((h: any) => h.name === 'pre-saved-hook')
        : g.name === 'pre-saved-hook',
    );
    expect(hasHook).toBe(false);
  });

  it('restores hook handler containing event, groupMeta, and handler keys untouched and deep-equal', async () => {
    seedFixtures();
    const deps = makeDeps(tempHome, tempProj);
    const settingsPath = path.join(tempHome, '.claude', 'settings.json');

    // Handler that legitimately contains keys named event, groupMeta, and handler
    const trickyHandler = {
      type: 'command',
      name: 'tricky-keys-hook',
      command: 'echo tricky',
      event: 'arbitrary-event-string',
      groupMeta: { specialKey: 123 },
      handler: 'myCustomHandlerValue',
    };

    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    settings.hooks = {
      PostToolUse: [
        {
          matcher: 'FileEdit',
          hooks: [trickyHandler],
        },
      ],
    };
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf8');

    const hookItem: SurfaceItem = {
      id: 'claude:hook::tricky-keys-hook',
      provider: 'claude',
      kind: 'hook',
      name: 'tricky-keys-hook',
      parent: null,
      source: 'user',
      enabled: true,
      effect: 'removes',
      toggleable: true,
      readOnlyReason: null,
      hookEvent: 'PostToolUse',
      hookCost: 'none',
      descriptionChars: null,
      originPath: settingsPath,
      wmuxRequired: false,
    };

    const writer = createClaudeWriter();

    // 1. Disable the hook
    const disResult = await writer.apply({
      deps,
      inventory: {
        provider: 'claude',
        cliVersion: '1.0.5',
        versionSupported: true,
        writable: true,
        items: [hookItem],
        warnings: [],
        scannedAtMs: 0,
      },
      changes: [{ item: hookItem, enabled: false }],
    });
    expect(disResult.ok).toBe(true);

    // Verify envelope in store
    const store = new SurfacesStore(deps.surfacesStorePath);
    store.load();
    const entry = store.removedHooks.get('claude', hookItem.id);
    expect(entry).toBeDefined();
    expect((entry?.definition as any)?.event).toBe('PostToolUse');
    expect((entry?.definition as any)?.groupMeta).toEqual({ matcher: 'FileEdit' });
    expect((entry?.definition as any)?.handler).toEqual(trickyHandler);

    // 2. Re-enable the hook
    const enResult = await writer.apply({
      deps,
      inventory: {
        provider: 'claude',
        cliVersion: '1.0.5',
        versionSupported: true,
        writable: true,
        items: [hookItem],
        warnings: [],
        scannedAtMs: 0,
      },
      changes: [{ item: hookItem, enabled: true }],
    });
    expect(enResult.ok).toBe(true);

    // Verify restored handler in settings.json matches original handler deep-equal
    const settingsAfter = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    const restoredHandler = settingsAfter.hooks.PostToolUse[0].hooks.find(
      (h: any) => h.name === 'tricky-keys-hook',
    );
    expect(restoredHandler).toEqual(trickyHandler);
    expect(restoredHandler.event).toBe('arbitrary-event-string');
    expect(restoredHandler.groupMeta).toEqual({ specialKey: 123 });
    expect(restoredHandler.handler).toBe('myCustomHandlerValue');
  });

  it('restores hook from old merged store shape without envelope', async () => {
    seedFixtures();
    const deps = makeDeps(tempHome, tempProj);
    const settingsPath = path.join(tempHome, '.claude', 'settings.json');

    const hookItem: SurfaceItem = {
      id: 'claude:hook::legacy-hook',
      provider: 'claude',
      kind: 'hook',
      name: 'legacy-hook',
      parent: null,
      source: 'user',
      enabled: false,
      effect: 'removes',
      toggleable: true,
      readOnlyReason: null,
      hookEvent: 'PreToolUse',
      hookCost: 'none',
      descriptionChars: null,
      originPath: settingsPath,
      wmuxRequired: false,
    };

    // Store has old merged shape where handler fields are at top level
    const store = new SurfacesStore(deps.surfacesStorePath);
    store.load();
    store.removedHooks.add('claude', {
      id: hookItem.id,
      definition: {
        event: 'PreToolUse',
        groupMeta: { matcher: 'Bash' },
        type: 'command',
        name: 'legacy-hook',
        command: 'echo legacy',
      },
      originPath: settingsPath,
    });
    store.save();

    const writer = createClaudeWriter();
    const enResult = await writer.apply({
      deps,
      inventory: {
        provider: 'claude',
        cliVersion: '1.0.5',
        versionSupported: true,
        writable: true,
        items: [hookItem],
        warnings: [],
        scannedAtMs: 0,
      },
      changes: [{ item: hookItem, enabled: true }],
    });
    expect(enResult.ok).toBe(true);

    const settingsAfter = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    const restored = settingsAfter.hooks.PreToolUse.flatMap((g: any) => g.hooks || g).find(
      (h: any) => h.name === 'legacy-hook',
    );
    expect(restored).toEqual({
      type: 'command',
      name: 'legacy-hook',
      command: 'echo legacy',
    });
  });

  it('toggles plugin, builtin tool, and MCP tool defined in project settings.json', async () => {
    seedFixtures();
    const deps = makeDeps(tempHome, tempProj);

    // Create project .claude/settings.json
    const projClaudeDir = path.join(tempProj, '.claude');
    fs.mkdirSync(projClaudeDir, { recursive: true });
    const projSettingsPath = path.join(projClaudeDir, 'settings.json');

    const projSettings = {
      permissions: {
        deny: ['Bash', 'mcp__proj-server__denied_proj_tool'],
      },
      enabledPlugins: {
        'project-plugin@store': true,
      },
    };
    fs.writeFileSync(projSettingsPath, JSON.stringify(projSettings, null, 2), 'utf8');

    const globalSettingsPath = path.join(tempHome, '.claude', 'settings.json');
    const globalSettingsBefore = fs.readFileSync(globalSettingsPath, 'utf8');

    const pluginItem: SurfaceItem = {
      id: 'claude:plugin::project-plugin@store',
      provider: 'claude',
      kind: 'plugin',
      name: 'project-plugin@store',
      parent: null,
      source: 'project',
      enabled: true,
      effect: 'removes',
      toggleable: true,
      readOnlyReason: null,
      hookEvent: null,
      hookCost: null,
      descriptionChars: null,
      originPath: projSettingsPath,
      wmuxRequired: false,
    };

    const builtinToolItem: SurfaceItem = {
      id: 'claude:builtin-tool::Bash',
      provider: 'claude',
      kind: 'builtin-tool',
      name: 'Bash',
      parent: null,
      source: 'project',
      enabled: false,
      effect: 'removes',
      toggleable: true,
      readOnlyReason: null,
      hookEvent: null,
      hookCost: null,
      descriptionChars: null,
      originPath: projSettingsPath,
      wmuxRequired: false,
    };

    const mcpToolItem: SurfaceItem = {
      id: 'claude:mcp-tool:proj-server:denied_proj_tool',
      provider: 'claude',
      kind: 'mcp-tool',
      name: 'denied_proj_tool',
      parent: 'proj-server',
      source: 'project',
      enabled: false,
      effect: 'removes',
      toggleable: true,
      readOnlyReason: null,
      hookEvent: null,
      hookCost: null,
      descriptionChars: null,
      originPath: projSettingsPath,
      wmuxRequired: false,
    };

    const writer = createClaudeWriter();

    // Preview changes targeting project settings
    const preview = await writer.preview({
      deps,
      inventory: {
        provider: 'claude',
        cliVersion: '1.0.5',
        versionSupported: true,
        writable: true,
        items: [pluginItem, builtinToolItem, mcpToolItem],
        warnings: [],
        scannedAtMs: 0,
      },
      changes: [
        { item: pluginItem, enabled: false },
        { item: builtinToolItem, enabled: true },
        { item: mcpToolItem, enabled: true },
      ],
    });

    expect(preview.edits).toHaveLength(3);
    for (const edit of preview.edits) {
      expect(edit.path).toBe(projSettingsPath);
    }

    // Apply changes
    const applyRes = await writer.apply({
      deps,
      inventory: {
        provider: 'claude',
        cliVersion: '1.0.5',
        versionSupported: true,
        writable: true,
        items: [pluginItem, builtinToolItem, mcpToolItem],
        warnings: [],
        scannedAtMs: 0,
      },
      changes: [
        { item: pluginItem, enabled: false },
        { item: builtinToolItem, enabled: true },
        { item: mcpToolItem, enabled: true },
      ],
    });

    expect(applyRes.ok).toBe(true);
    expect(applyRes.appliedItemIds).toContain(pluginItem.id);
    expect(applyRes.appliedItemIds).toContain(builtinToolItem.id);
    expect(applyRes.appliedItemIds).toContain(mcpToolItem.id);

    // Verify project settings file was updated
    const projSettingsAfter = JSON.parse(fs.readFileSync(projSettingsPath, 'utf8'));
    expect(projSettingsAfter.enabledPlugins['project-plugin@store']).toBe(false);
    expect(projSettingsAfter.permissions?.deny).toBeUndefined(); // both tools removed, deny deleted

    // Verify global settings file was completely untouched
    const globalSettingsAfter = fs.readFileSync(globalSettingsPath, 'utf8');
    expect(globalSettingsAfter).toBe(globalSettingsBefore);
  });

  it('asserts failing apply error contains no secret fragment and no item id', async () => {
    seedFixtures();
    const deps = makeDeps(tempHome, tempProj);
    const settingsPath = path.join(tempHome, '.claude', 'settings.json');

    const secretFragment = 'SUPER_SECRET_TOKEN_abc123_XYZ789';
    const secretItemId = 'claude:hook::hook-with-secret-id-456';

    // Plant secret fragment in settings.json
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    settings.secretApiKey = secretFragment;
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf8');

    const hookItem: SurfaceItem = {
      id: secretItemId,
      provider: 'claude',
      kind: 'hook',
      name: 'hook-with-secret-id-456',
      parent: null,
      source: 'user',
      enabled: false,
      effect: 'removes',
      toggleable: true,
      readOnlyReason: null,
      hookEvent: 'PreToolUse',
      hookCost: 'none',
      descriptionChars: null,
      originPath: settingsPath,
      wmuxRequired: false,
    };

    // Pre-save hook definition
    const store = new SurfacesStore(deps.surfacesStorePath);
    store.load();
    store.removedHooks.add('claude', {
      id: hookItem.id,
      definition: {
        event: 'PreToolUse',
        handler: { type: 'command', name: 'hook-with-secret-id-456', command: 'echo test' },
      },
      originPath: settingsPath,
    });
    store.save();

    // Trigger failure by making settingsPath read-only
    const restoreWritable = makeUnwritable(settingsPath);

    const writer = createClaudeWriter();
    const result = await writer.apply({
      deps,
      inventory: {
        provider: 'claude',
        cliVersion: '1.0.5',
        versionSupported: true,
        writable: true,
        items: [hookItem],
        warnings: [],
        scannedAtMs: 0,
      },
      changes: [{ item: hookItem, enabled: true }],
    });

    restoreWritable();

    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
    expect(typeof result.error).toBe('string');
    expect(result.error).not.toContain(secretFragment);
    expect(result.error).not.toContain(secretItemId);
    expect(result.error).not.toContain('hook-with-secret-id-456');
  });

  it('multi-file change all-or-nothing: rolls back ~/.claude.json when settings.json fails and does not report item applied', async () => {
    seedFixtures();
    const deps = makeDeps(tempHome, tempProj);
    const claudeJsonPath = path.join(tempHome, '.claude.json');
    const settingsPath = path.join(tempHome, '.claude', 'settings.json');

    // Setup proj-server as disabled in ~/.claude.json AND denied in settings.json
    const cj = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf8'));
    cj.projects[tempProj].disabledMcpServers = ['proj-server'];
    fs.writeFileSync(claudeJsonPath, JSON.stringify(cj, null, 2), 'utf8');

    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    settings.deniedMcpServers = [{ serverName: 'proj-server' }];
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf8');

    const projServerItem: SurfaceItem = {
      id: 'claude:mcp-server::proj-server',
      provider: 'claude',
      kind: 'mcp-server',
      name: 'proj-server',
      parent: null,
      source: 'project',
      enabled: false,
      effect: 'removes',
      toggleable: true,
      readOnlyReason: null,
      hookEvent: null,
      hookCost: null,
      descriptionChars: null,
      originPath: claudeJsonPath,
      settingsPath,
      wmuxRequired: false,
    };

    // Make settingsPath read-only so the second edit fails
    const restoreWritable = makeUnwritable(settingsPath);

    const writer = createClaudeWriter();
    const result = await writer.apply({
      deps,
      inventory: {
        provider: 'claude',
        cliVersion: '1.0.5',
        versionSupported: true,
        writable: true,
        items: [projServerItem],
        warnings: [],
        scannedAtMs: 0,
      },
      changes: [{ item: projServerItem, enabled: true }],
    });

    restoreWritable();

    expect(result.ok).toBe(false);
    expect(result.appliedItemIds).not.toContain(projServerItem.id);
    expect(result.error).toBe('Applying the change failed; no file was left half-written.');

    // ~/.claude.json should have been rolled back to containing proj-server in disabledMcpServers
    const cjAfter = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf8'));
    expect(cjAfter.projects[tempProj].disabledMcpServers).toContain('proj-server');
  });

  it('multi-file change all-or-nothing: reports settings warning if rollback fails', async () => {
    seedFixtures();
    const deps = makeDeps(tempHome, tempProj);
    const claudeJsonPath = path.join(tempHome, '.claude.json');
    const settingsPath = path.join(tempHome, '.claude', 'settings.json');

    const cj = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf8'));
    cj.projects[tempProj].disabledMcpServers = ['proj-server'];
    fs.writeFileSync(claudeJsonPath, JSON.stringify(cj, null, 2), 'utf8');

    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    settings.deniedMcpServers = [{ serverName: 'proj-server' }];
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf8');

    const projServerItem: SurfaceItem = {
      id: 'claude:mcp-server::proj-server',
      provider: 'claude',
      kind: 'mcp-server',
      name: 'proj-server',
      parent: null,
      source: 'project',
      enabled: false,
      effect: 'removes',
      toggleable: true,
      readOnlyReason: null,
      hookEvent: null,
      hookCost: null,
      descriptionChars: null,
      originPath: claudeJsonPath,
      settingsPath,
      wmuxRequired: false,
    };

    // Spy on applyConfigEdit: for the first call (claudeJsonPath) perform normally,
    // then concurrently modify claudeJsonPath before settings edit fails, so hash mismatch triggers rollback failure
    const safeWrite = await import('../../safeWrite');
    const originalApplyConfigEdit = safeWrite.applyConfigEdit;
    let callCount = 0;
    const spy = vi.spyOn(safeWrite, 'applyConfigEdit').mockImplementation((options) => {
      callCount++;
      if (callCount === 1) {
        return originalApplyConfigEdit(options);
      }
      // Call 2: Tamper with claudeJsonPath after Call 1 completed its postSnapshot
      fs.writeFileSync(claudeJsonPath, JSON.stringify({ tampered: true }), 'utf8');
      throw new Error('Simulated settings write failure');
    });

    try {
      const writer = createClaudeWriter();
      const result = await writer.apply({
        deps,
        inventory: {
          provider: 'claude',
          cliVersion: '1.0.5',
          versionSupported: true,
          writable: true,
          items: [projServerItem],
          warnings: [],
          scannedAtMs: 0,
        },
        changes: [{ item: projServerItem, enabled: true }],
      });

      expect(result.ok).toBe(false);
      expect(result.appliedItemIds).not.toContain(projServerItem.id);
      expect(result.error).toContain('Some files may have changed; check your Claude settings');
    } finally {
      spy.mockRestore();
    }
  });

  it('rolls back first written file when subsequent hook enable definition is missing from store', async () => {
    seedFixtures();
    const deps = makeDeps(tempHome, tempProj);
    const claudeJsonPath = path.join(tempHome, '.claude.json');
    const settingsPath = path.join(tempHome, '.claude', 'settings.json');

    const originalClaudeJson = fs.readFileSync(claudeJsonPath, 'utf8');

    // Item 1: Project MCP server disable, which writes to ~/.claude.json
    const mcpItem: SurfaceItem = {
      id: 'claude:mcp-server:project:my-server',
      provider: 'claude',
      kind: 'mcp-server',
      name: 'my-server',
      parent: null,
      source: 'project',
      enabled: true,
      effect: 'removes',
      toggleable: true,
      readOnlyReason: null,
      hookEvent: null,
      hookCost: null,
      descriptionChars: null,
      originPath: claudeJsonPath,
      wmuxRequired: false,
    };

    // Item 2: Hook enable whose definition is missing from store, targets settings.json
    const hookItem: SurfaceItem = {
      id: 'claude:hook::missing-hook',
      provider: 'claude',
      kind: 'hook',
      name: 'missing-hook',
      parent: null,
      source: 'user',
      enabled: false,
      effect: 'removes',
      toggleable: true,
      readOnlyReason: null,
      hookEvent: 'PreToolUse',
      hookCost: 'none',
      descriptionChars: null,
      originPath: settingsPath,
      wmuxRequired: false,
    };

    const writer = createClaudeWriter();
    const res = await writer.apply({
      deps,
      inventory: {
        provider: 'claude',
        cliVersion: '1.0.5',
        versionSupported: true,
        writable: true,
        items: [mcpItem, hookItem],
        warnings: [],
        scannedAtMs: 0,
      },
      changes: [
        { item: mcpItem, enabled: false },
        { item: hookItem, enabled: true },
      ],
    });

    expect(res.ok).toBe(false);
    expect(res.error).toBe('Cannot enable hook: definition not found in store');
    expect(res.appliedItemIds).toEqual([]);

    // Verify first file (~/.claude.json) was restored to its exact original content
    const restoredClaudeJson = fs.readFileSync(claudeJsonPath, 'utf8');
    expect(restoredClaudeJson).toBe(originalClaudeJson);
  });

  it('skips duplicate insert when hook is already present with a stale store entry and removes store entry', async () => {
    seedFixtures();
    const deps = makeDeps(tempHome, tempProj);
    const settingsPath = path.join(tempHome, '.claude', 'settings.json');

    // Ensure settings.json already has the hook
    const existingHandler = {
      type: 'command',
      command: 'echo pre-tool-check',
    };
    const settingsContent = {
      hooks: {
        PreToolUse: [
          {
            matcher: 'Edit',
            hooks: [existingHandler],
          },
        ],
      },
    };
    fs.writeFileSync(settingsPath, JSON.stringify(settingsContent, null, 2), 'utf8');

    // Plant a stale store entry for this exact hook definition
    const hookId = 'claude:hook:settings.json:PreToolUse:echo-pre-tool-check';
    const store = new SurfacesStore(deps.surfacesStorePath);
    store.load();
    store.removedHooks.add('claude', {
      id: hookId,
      definition: {
        event: 'PreToolUse',
        groupMeta: { matcher: 'Edit' },
        handler: existingHandler,
      },
      originPath: settingsPath,
    });
    store.save();

    // Verify store has the stale entry before apply
    expect(store.removedHooks.get('claude', hookId)).toBeDefined();

    const hookItem: SurfaceItem = {
      id: hookId,
      provider: 'claude',
      kind: 'hook',
      name: 'echo-pre-tool-check',
      parent: null,
      source: 'user',
      enabled: false,
      effect: 'removes',
      toggleable: true,
      readOnlyReason: null,
      hookEvent: 'PreToolUse',
      hookCost: 'none',
      descriptionChars: null,
      originPath: settingsPath,
      wmuxRequired: false,
    };

    const writer = createClaudeWriter();
    const res = await writer.apply({
      deps,
      inventory: {
        provider: 'claude',
        cliVersion: '1.0.5',
        versionSupported: true,
        writable: true,
        items: [hookItem],
        warnings: [],
        scannedAtMs: 0,
      },
      changes: [{ item: hookItem, enabled: true }],
    });

    expect(res.ok).toBe(true);
    expect(res.appliedItemIds).toContain(hookId);

    // Verify settings.json has NO duplicate
    const updatedSettings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    const preToolGroups = updatedSettings.hooks.PreToolUse;
    expect(preToolGroups).toHaveLength(1);
    expect(preToolGroups[0].hooks).toHaveLength(1);
    expect(preToolGroups[0].hooks[0]).toEqual(existingHandler);

    // Verify stale entry was removed from the store on disk
    const storeAfter = new SurfacesStore(deps.surfacesStorePath);
    storeAfter.load();
    expect(storeAfter.removedHooks.get('claude', hookId)).toBeUndefined();
  });
});

describe('claudeWriter hook identity', () => {
  let home: string;
  let settingsPath: string;

  beforeEach(() => {
    home = makeTempDir('claude-writer-hookid-');
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    settingsPath = path.join(home, '.claude', 'settings.json');
  });

  afterEach(() => {
    try { fs.rmSync(home, { recursive: true, force: true }); } catch {}
  });

  async function listHooks(deps: WriterDeps): Promise<SurfaceItem[]> {
    const inv = await readInventory('claude', {
      homeDir: deps.homeDir,
      run: deps.run,
      now: deps.now,
      surfacesStorePath: deps.surfacesStorePath,
    });
    return inv.items.filter((i) => i.kind === 'hook');
  }

  it('disables the unnamed hook that was picked, not the first one with the same generated name', async () => {
    const deps = makeDeps(home);
    const wmuxHook = { type: 'command', command: 'node C:/Users/x/.wmux/hooks/stop.js' };
    const userHook = { type: 'command', command: 'node my-stop.js' };
    fs.writeFileSync(settingsPath, JSON.stringify({ hooks: { Stop: [{ hooks: [wmuxHook, userHook] }] } }), 'utf8');

    const hooks = await listHooks(deps);
    expect(hooks.map((h) => h.name)).toEqual(['Stop-command', 'Stop-command']);
    const target = hooks.find((h) => !h.wmuxRequired)!;

    const res = await applySurfaceChanges({ provider: 'claude', changes: [{ itemId: target.id, enabled: false }] }, { deps });
    expect(res.ok).toBe(true);
    const after = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    expect(after.hooks.Stop[0].hooks).toEqual([wmuxHook]);
  });

  it('keeps each unnamed hook restorable after the other one is removed', async () => {
    const deps = makeDeps(home);
    const a = { type: 'command', command: 'node a.js' };
    const b = { type: 'command', command: 'node b.js' };
    fs.writeFileSync(settingsPath, JSON.stringify({ hooks: { Stop: [{ hooks: [a, b] }] } }), 'utf8');
    const before = await listHooks(deps);
    const [idA, idB] = before.map((h) => h.id);
    expect(idA).not.toBe(idB);

    expect((await applySurfaceChanges({ provider: 'claude', changes: [{ itemId: idA, enabled: false }] }, { deps })).ok).toBe(true);
    const afterA = await listHooks(deps);
    // B keeps its id; A is listed (off) under its own id.
    expect(afterA.find((h) => h.id === idB)?.enabled).toBe(true);
    expect(afterA.find((h) => h.id === idA)?.enabled).toBe(false);

    expect((await applySurfaceChanges({ provider: 'claude', changes: [{ itemId: idB, enabled: false }] }, { deps })).ok).toBe(true);
    expect((await applySurfaceChanges({ provider: 'claude', changes: [{ itemId: idA, enabled: true }] }, { deps })).ok).toBe(true);
    const restored = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    expect(restored.hooks.Stop[0].hooks).toEqual([a]);
  });

  it('leaves a matcher group that was already empty alone', async () => {
    const deps = makeDeps(home);
    const hook = { type: 'command', command: 'node a.js' };
    fs.writeFileSync(settingsPath, JSON.stringify({ hooks: { Stop: [{ matcher: 'x', hooks: [] }, { hooks: [hook] }] } }), 'utf8');
    const [item] = await listHooks(deps);
    expect((await applySurfaceChanges({ provider: 'claude', changes: [{ itemId: item.id, enabled: false }] }, { deps })).ok).toBe(true);
    const after = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    expect(after.hooks.Stop).toEqual([{ matcher: 'x', hooks: [] }]);
  });

  it('refuses when two identical handlers match, and leaves the file untouched', async () => {
    const deps = makeDeps(home);
    const dup = { type: 'command', command: 'node my-stop.js' };
    const original = JSON.stringify({ hooks: { Stop: [{ hooks: [dup] }, { hooks: [dup] }] } });
    fs.writeFileSync(settingsPath, original, 'utf8');

    const [first] = await listHooks(deps);
    const res = await applySurfaceChanges({ provider: 'claude', changes: [{ itemId: first.id, enabled: false }] }, { deps });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/More than one hook matches/);
    expect(fs.readFileSync(settingsPath, 'utf8')).toBe(original);
  });
});

describe('claudeWriter target settings file', () => {
  let home: string;
  let proj: string;

  beforeEach(() => {
    home = makeTempDir('claude-writer-target-home-');
    proj = makeTempDir('claude-writer-target-proj-');
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.mkdirSync(path.join(proj, '.claude', 'skills', 'proj-skill'), { recursive: true });
    fs.writeFileSync(path.join(proj, '.claude', 'skills', 'proj-skill', 'SKILL.md'), '---\nname: proj-skill\ndescription: d\n---\n', 'utf8');
  });

  afterEach(() => {
    for (const d of [home, proj]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
  });

  const inv = async (deps: WriterDeps) => readInventory('claude', {
    homeDir: deps.homeDir, projectDir: deps.projectDir, run: deps.run, surfacesStorePath: deps.surfacesStorePath,
  });

  it('switches a project skill off in the project, not in the user-wide settings', async () => {
    const deps = makeDeps(home, proj);
    const skill = (await inv(deps)).items.find((i) => i.kind === 'skill' && i.name === 'proj-skill')!;
    const res = await applySurfaceChanges({ provider: 'claude', changes: [{ itemId: skill.id, enabled: false }] }, { deps });
    expect(res.ok).toBe(true);
    expect(fs.existsSync(path.join(home, '.claude', 'settings.json'))).toBe(false);
    const local = JSON.parse(fs.readFileSync(path.join(proj, '.claude', 'settings.local.json'), 'utf8'));
    expect(local.skillOverrides['proj-skill']).toBe('off');
  });

  it('turns a skill back on in the file that holds its override', async () => {
    const deps = makeDeps(home, proj);
    const userSettings = path.join(home, '.claude', 'settings.json');
    const localSettings = path.join(home, '.claude', 'settings.local.json');
    fs.writeFileSync(userSettings, JSON.stringify({ theme: 'dark' }), 'utf8');
    fs.writeFileSync(localSettings, JSON.stringify({ skillOverrides: { 'proj-skill': 'off' } }), 'utf8');
    const skill = (await inv(deps)).items.find((i) => i.kind === 'skill' && i.name === 'proj-skill')!;
    expect(skill.enabled).toBe(false);
    const res = await applySurfaceChanges({ provider: 'claude', changes: [{ itemId: skill.id, enabled: true }] }, { deps });
    expect(res.ok).toBe(true);
    expect(JSON.parse(fs.readFileSync(localSettings, 'utf8')).skillOverrides).toBeUndefined();
    expect(JSON.parse(fs.readFileSync(userSettings, 'utf8'))).toEqual({ theme: 'dark' });
  });

  it('does not report a change as applied when no file was edited for it', async () => {
    const deps = makeDeps(home, proj);
    const writer = createClaudeWriter();
    const item: SurfaceItem = {
      id: 'claude:mcp-tool:srv:t', provider: 'claude', kind: 'mcp-tool', name: 't', parent: 'srv', source: 'user',
      enabled: false, effect: 'removes', toggleable: true, readOnlyReason: null, hookEvent: null, hookCost: null,
      descriptionChars: null, originPath: path.join(home, '.claude.json'), wmuxRequired: false,
    };
    const res = await writer.apply({
      deps,
      inventory: { provider: 'claude', cliVersion: '1.0.5', versionSupported: true, writable: true, items: [item], warnings: [], scannedAtMs: 0 },
      changes: [{ item, enabled: true }],
    });
    expect(res.ok).toBe(false);
    expect(res.appliedItemIds).toEqual([]);
  });
});
