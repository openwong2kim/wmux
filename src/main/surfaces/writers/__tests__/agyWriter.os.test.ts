import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  applySurfaceChanges,
  previewSurfaceChanges,
  type WriterDeps,
} from '../index';
import { readInventory } from '../../inventory';
import { createAgyWriter } from '../agyWriter';
import * as safeWrite from '../../safeWrite';
import { ConfigChangedError, SurfacesStore } from '../../safeWrite';

// Real files on disk, several applies per test: slow Windows runners need more than vitest's 5 s.
vi.setConfig({ testTimeout: 30_000 });

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function makeDeps(home: string, projectDir?: string, version = '1.2.14'): WriterDeps {
  return {
    homeDir: home,
    projectDir,
    run: async () => version,
    now: () => 1_700_000_000_000,
    surfacesStorePath: path.join(home, '.wmux', 'surfaces.json'),
  };
}

describe('agyWriter', () => {
  describe('mcp-server', () => {
    it('disables, enables, and round trips user mcp-server while preserving other keys', async () => {
      const home = tempDir('wmux-agy-mcpserver-');
      const cfgDir = path.join(home, '.gemini', 'config');
      fs.mkdirSync(cfgDir, { recursive: true });

      const initialConfig = {
        mcpServers: {
          alpha: {
            command: 'node',
            args: ['server.js'],
            env: { DEBUG: '1' },
          },
        },
      };
      const mcpConfigPath = path.join(cfgDir, 'mcp_config.json');
      fs.writeFileSync(mcpConfigPath, JSON.stringify(initialConfig, null, 2));

      const deps = makeDeps(home);
      const inv1 = await readInventory('agy', { homeDir: home, run: deps.run });
      const alpha = inv1.items.find((i) => i.kind === 'mcp-server' && i.name === 'alpha')!;
      expect(alpha).toBeDefined();
      expect(alpha.enabled).toBe(true);

      // Preview disable
      const previewDisable = await previewSurfaceChanges(
        { provider: 'agy', changes: [{ itemId: alpha.id, enabled: false }] },
        { deps },
      );
      expect(previewDisable.rejected).toEqual([]);
      expect(previewDisable.requiresNewSession).toBe(true);
      expect(previewDisable.edits).toEqual([
        {
          path: mcpConfigPath,
          summary: 'set mcpServers."alpha".disabled = true',
        },
      ]);

      // Apply disable
      const applyDisable = await applySurfaceChanges(
        { provider: 'agy', changes: [{ itemId: alpha.id, enabled: false }] },
        { deps },
      );
      expect(applyDisable.ok).toBe(true);
      expect(applyDisable.appliedItemIds).toEqual([alpha.id]);
      expect(applyDisable.backups.length).toBe(1);
      expect(fs.existsSync(applyDisable.backups[0])).toBe(true);

      const disabledOnDisk = JSON.parse(fs.readFileSync(mcpConfigPath, 'utf8'));
      expect(disabledOnDisk.mcpServers.alpha.disabled).toBe(true);
      expect(disabledOnDisk.mcpServers.alpha.command).toBe('node');
      expect(disabledOnDisk.mcpServers.alpha.args).toEqual(['server.js']);

      // Inventory reflects disabled
      const inv2 = await readInventory('agy', { homeDir: home, run: deps.run });
      const alpha2 = inv2.items.find((i) => i.id === alpha.id)!;
      expect(alpha2.enabled).toBe(false);

      // Verify store recorded intent
      const store = new SurfacesStore(deps.surfacesStorePath);
      store.load();
      expect(store.getIntent('agy', alpha.id)).toBe(false);

      // Apply enable
      const applyEnable = await applySurfaceChanges(
        { provider: 'agy', changes: [{ itemId: alpha.id, enabled: true }] },
        { deps },
      );
      expect(applyEnable.ok).toBe(true);
      expect(applyEnable.appliedItemIds).toEqual([alpha.id]);

      // File is round tripped back to original content
      const enabledOnDisk = JSON.parse(fs.readFileSync(mcpConfigPath, 'utf8'));
      expect(enabledOnDisk).toEqual(initialConfig);

      // Inventory reflects enabled
      const inv3 = await readInventory('agy', { homeDir: home, run: deps.run });
      const alpha3 = inv3.items.find((i) => i.id === alpha.id)!;
      expect(alpha3.enabled).toBe(true);
    });

    it('edits project mcp_config.json for project mcp-server', async () => {
      const home = tempDir('wmux-agy-home-');
      const project = tempDir('wmux-agy-project-');
      const projectAgentDir = path.join(project, '.agents');
      fs.mkdirSync(projectAgentDir, { recursive: true });

      const projectMcpPath = path.join(projectAgentDir, 'mcp_config.json');
      fs.writeFileSync(
        projectMcpPath,
        JSON.stringify({ mcpServers: { projServer: { command: 'python' } } }, null, 2),
      );

      const deps = makeDeps(home, project);
      const inv = await readInventory('agy', { homeDir: home, projectDir: project, run: deps.run });
      const srv = inv.items.find((i) => i.kind === 'mcp-server' && i.name === 'projServer')!;
      expect(srv).toBeDefined();
      expect(srv.source).toBe('project');

      const res = await applySurfaceChanges(
        { provider: 'agy', changes: [{ itemId: srv.id, enabled: false }] },
        { deps, inventoryDeps: { projectDir: project } },
      );
      expect(res.ok).toBe(true);

      const parsed = JSON.parse(fs.readFileSync(projectMcpPath, 'utf8'));
      expect(parsed.mcpServers.projServer.disabled).toBe(true);
    });
  });

  describe('mcp-tool', () => {
    it('disables, enables, and deletes disabledTools key when empty', async () => {
      const home = tempDir('wmux-agy-mcptool-');
      const cfgDir = path.join(home, '.gemini', 'config');
      fs.mkdirSync(cfgDir, { recursive: true });

      const initialConfig = {
        mcpServers: {
          srv: {
            command: 'node',
            disabledTools: ['toolA'],
          },
        },
      };
      const mcpPath = path.join(cfgDir, 'mcp_config.json');
      fs.writeFileSync(mcpPath, JSON.stringify(initialConfig, null, 2));

      const deps = makeDeps(home);
      const inv1 = await readInventory('agy', { homeDir: home, run: deps.run });
      const toolA = inv1.items.find((i) => i.kind === 'mcp-tool' && i.name === 'toolA')!;
      expect(toolA).toBeDefined();
      expect(toolA.enabled).toBe(false);

      // Enable toolA
      const previewEnable = await previewSurfaceChanges(
        { provider: 'agy', changes: [{ itemId: toolA.id, enabled: true }] },
        { deps },
      );
      expect(previewEnable.edits).toEqual([
        {
          path: mcpPath,
          summary: 'remove "toolA" from mcpServers."srv".disabledTools',
        },
      ]);

      const applyEnable = await applySurfaceChanges(
        { provider: 'agy', changes: [{ itemId: toolA.id, enabled: true }] },
        { deps },
      );
      expect(applyEnable.ok).toBe(true);

      // disabledTools key was deleted because it became empty
      const diskAfterEnable = JSON.parse(fs.readFileSync(mcpPath, 'utf8'));
      expect(diskAfterEnable.mcpServers.srv.disabledTools).toBeUndefined();

      // Fresh inventory no longer reports toolA as disabled
      const inv2 = await readInventory('agy', { homeDir: home, run: deps.run });
      expect(inv2.items.find((i) => i.kind === 'mcp-tool' && i.name === 'toolA')).toBeUndefined();

      // Re-disable toolA using writer.apply directly
      const writer = createAgyWriter();
      const applyDisable = await writer.apply({
        deps,
        inventory: inv2,
        changes: [{ item: { ...toolA, enabled: true }, enabled: false }],
      });
      expect(applyDisable.ok).toBe(true);

      const diskAfterDisable = JSON.parse(fs.readFileSync(mcpPath, 'utf8'));
      expect(diskAfterDisable).toEqual(initialConfig);

      // Fresh inventory reports toolA as disabled again
      const inv3 = await readInventory('agy', { homeDir: home, run: deps.run });
      expect(inv3.items.find((i) => i.kind === 'mcp-tool' && i.name === 'toolA')!.enabled).toBe(false);
    });

    it('handles multiple tools toggled on the same server in a single change', async () => {
      const home = tempDir('wmux-agy-mcptool-multi-');
      const cfgDir = path.join(home, '.gemini', 'config');
      fs.mkdirSync(cfgDir, { recursive: true });

      const mcpPath = path.join(cfgDir, 'mcp_config.json');
      fs.writeFileSync(
        mcpPath,
        JSON.stringify({ mcpServers: { srv: { command: 'node', disabledTools: ['tool1', 'tool2'] } } }, null, 2),
      );

      const deps = makeDeps(home);
      const inv = await readInventory('agy', { homeDir: home, run: deps.run });
      const t1 = inv.items.find((i) => i.kind === 'mcp-tool' && i.name === 'tool1')!;
      const t2 = inv.items.find((i) => i.kind === 'mcp-tool' && i.name === 'tool2')!;
      expect(t1).toBeDefined();
      expect(t2).toBeDefined();

      const preview = await previewSurfaceChanges(
        {
          provider: 'agy',
          changes: [
            { itemId: t1.id, enabled: true },
            { itemId: t2.id, enabled: true },
          ],
        },
        { deps },
      );
      expect(preview.edits).toEqual([
        { path: mcpPath, summary: 'remove "tool1" from mcpServers."srv".disabledTools' },
        { path: mcpPath, summary: 'remove "tool2" from mcpServers."srv".disabledTools' },
      ]);

      const res = await applySurfaceChanges(
        {
          provider: 'agy',
          changes: [
            { itemId: t1.id, enabled: true },
            { itemId: t2.id, enabled: true },
          ],
        },
        { deps },
      );
      expect(res.ok).toBe(true);
      expect(res.appliedItemIds).toEqual([t1.id, t2.id]);

      const disk = JSON.parse(fs.readFileSync(mcpPath, 'utf8'));
      expect(disk.mcpServers.srv.disabledTools).toBeUndefined();
    });

    it('preserves non-string elements and ordering in disabledTools', async () => {
      const home = tempDir('wmux-agy-mcptool-nonstring-');
      const cfgDir = path.join(home, '.gemini', 'config');
      fs.mkdirSync(cfgDir, { recursive: true });

      const initialConfig = {
        mcpServers: {
          srv: {
            command: 'node',
            disabledTools: [42, 'targetTool', { complex: true }, true],
          },
        },
      };
      const mcpPath = path.join(cfgDir, 'mcp_config.json');
      fs.writeFileSync(mcpPath, JSON.stringify(initialConfig, null, 2));

      const deps = makeDeps(home);
      const inv1 = await readInventory('agy', { homeDir: home, run: deps.run });
      const tool = inv1.items.find((i) => i.kind === 'mcp-tool' && i.name === 'targetTool')!;
      expect(tool).toBeDefined();
      expect(tool.enabled).toBe(false);

      // Enable targetTool
      const applyEnable = await applySurfaceChanges(
        { provider: 'agy', changes: [{ itemId: tool.id, enabled: true }] },
        { deps },
      );
      expect(applyEnable.ok).toBe(true);

      // Non-string elements remain in original order, key not deleted
      const diskAfterEnable = JSON.parse(fs.readFileSync(mcpPath, 'utf8'));
      expect(diskAfterEnable.mcpServers.srv.disabledTools).toEqual([42, { complex: true }, true]);

      // Fresh inventory no longer reports targetTool
      const inv2 = await readInventory('agy', { homeDir: home, run: deps.run });
      expect(inv2.items.find((i) => i.kind === 'mcp-tool' && i.name === 'targetTool')).toBeUndefined();

      // Disable targetTool again
      const writer = createAgyWriter();
      const applyDisable = await writer.apply({
        deps,
        inventory: inv2,
        changes: [{ item: { ...tool, enabled: true }, enabled: false }],
      });
      expect(applyDisable.ok).toBe(true);

      const diskAfterDisable = JSON.parse(fs.readFileSync(mcpPath, 'utf8'));
      expect(diskAfterDisable.mcpServers.srv.disabledTools).toEqual([42, { complex: true }, true, 'targetTool']);
    });
  });

  describe('plugin', () => {
    it('disables and enables plugins by directory name, leaving other keys intact', async () => {
      const home = tempDir('wmux-agy-plugin-');
      const pluginsDir = path.join(home, '.gemini', 'config', 'plugins', 'pkg-dir');
      fs.mkdirSync(pluginsDir, { recursive: true });
      fs.writeFileSync(
        path.join(pluginsDir, 'plugin.json'),
        JSON.stringify({ name: 'Display Name of Plugin' }, null, 2),
      );

      const configPath = path.join(home, '.gemini', 'config', 'config.json');
      fs.writeFileSync(
        configPath,
        JSON.stringify({
          plugins: {
            'pkg-dir': { version: '2.0.0' },
          },
          unrelated: true,
        }, null, 2),
      );

      const deps = makeDeps(home);
      const inv1 = await readInventory('agy', { homeDir: home, run: deps.run });
      const pluginItem = inv1.items.find((i) => i.kind === 'plugin')!;
      expect(pluginItem).toBeDefined();
      expect(pluginItem.name).toBe('Display Name of Plugin');
      expect(pluginItem.enabled).toBe(true);

      // Preview disable
      const preview = await previewSurfaceChanges(
        { provider: 'agy', changes: [{ itemId: pluginItem.id, enabled: false }] },
        { deps },
      );
      expect(preview.edits).toEqual([
        {
          path: configPath,
          summary: 'set plugins."pkg-dir".enabled = false',
        },
      ]);

      // Apply disable
      const applyDisable = await applySurfaceChanges(
        { provider: 'agy', changes: [{ itemId: pluginItem.id, enabled: false }] },
        { deps },
      );
      expect(applyDisable.ok).toBe(true);

      const diskDisabled = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      expect(diskDisabled.plugins['pkg-dir'].enabled).toBe(false);
      expect(diskDisabled.plugins['pkg-dir'].version).toBe('2.0.0');
      expect(diskDisabled.unrelated).toBe(true);

      const inv2 = await readInventory('agy', { homeDir: home, run: deps.run });
      expect(inv2.items.find((i) => i.id === pluginItem.id)!.enabled).toBe(false);

      // Apply enable
      const applyEnable = await applySurfaceChanges(
        { provider: 'agy', changes: [{ itemId: pluginItem.id, enabled: true }] },
        { deps },
      );
      expect(applyEnable.ok).toBe(true);

      const diskEnabled = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      expect(diskEnabled.plugins['pkg-dir'].enabled).toBe(true);
      expect(diskEnabled.plugins['pkg-dir'].version).toBe('2.0.0');

      const inv3 = await readInventory('agy', { homeDir: home, run: deps.run });
      expect(inv3.items.find((i) => i.id === pluginItem.id)!.enabled).toBe(true);
    });

    it('round trip when config.json had no entry before leaves inventory enabled (assert inventory state, not byte equality)', async () => {
      const home = tempDir('wmux-agy-plugin-roundtrip-');
      const pluginsDir = path.join(home, '.gemini', 'config', 'plugins', 'clean-plugin');
      fs.mkdirSync(pluginsDir, { recursive: true });
      fs.writeFileSync(
        path.join(pluginsDir, 'plugin.json'),
        JSON.stringify({ name: 'Clean Plugin' }, null, 2),
      );

      const deps = makeDeps(home);
      const inv1 = await readInventory('agy', { homeDir: home, run: deps.run });
      const item = inv1.items.find((i) => i.kind === 'plugin')!;
      expect(item.enabled).toBe(true);

      // Disable
      await applySurfaceChanges(
        { provider: 'agy', changes: [{ itemId: item.id, enabled: false }] },
        { deps },
      );
      const invDisabled = await readInventory('agy', { homeDir: home, run: deps.run });
      expect(invDisabled.items.find((i) => i.id === item.id)!.enabled).toBe(false);

      // Re-enable
      await applySurfaceChanges(
        { provider: 'agy', changes: [{ itemId: item.id, enabled: true }] },
        { deps },
      );
      const configJson = JSON.parse(
        fs.readFileSync(path.join(home, '.gemini', 'config', 'config.json'), 'utf8'),
      );
      expect(configJson.plugins['clean-plugin'].enabled).toBe(true);

      const invEnabled = await readInventory('agy', { homeDir: home, run: deps.run });
      expect(invEnabled.items.find((i) => i.id === item.id)!.enabled).toBe(true);
    });
  });

  describe('skill', () => {
    it('disables and enables skills via exclude array in skills.json, creating file if missing', async () => {
      const home = tempDir('wmux-agy-skill-');
      const skillDir = path.join(home, '.gemini', 'config', 'skills', 'skill-one');
      fs.mkdirSync(skillDir, { recursive: true });
      fs.writeFileSync(
        path.join(skillDir, 'SKILL.md'),
        '---\nname: skill-one\ndescription: test skill\n---\n',
      );

      const skillsJsonPath = path.join(home, '.gemini', 'config', 'skills.json');
      expect(fs.existsSync(skillsJsonPath)).toBe(false);

      const deps = makeDeps(home);
      const inv1 = await readInventory('agy', { homeDir: home, run: deps.run });
      const skillItem = inv1.items.find((i) => i.kind === 'skill' && i.source === 'user')!;
      expect(skillItem).toBeDefined();
      expect(skillItem.enabled).toBe(true);

      // Preview disable
      const preview = await previewSurfaceChanges(
        { provider: 'agy', changes: [{ itemId: skillItem.id, enabled: false }] },
        { deps },
      );
      expect(preview.edits).toEqual([
        {
          path: skillsJsonPath,
          summary: 'add "skill-one" to exclude',
        },
      ]);

      // Apply disable
      const applyDisable = await applySurfaceChanges(
        { provider: 'agy', changes: [{ itemId: skillItem.id, enabled: false }] },
        { deps },
      );
      expect(applyDisable.ok).toBe(true);
      expect(fs.existsSync(skillsJsonPath)).toBe(true);

      const disk1 = JSON.parse(fs.readFileSync(skillsJsonPath, 'utf8'));
      expect(disk1.exclude).toEqual(['skill-one']);

      const inv2 = await readInventory('agy', { homeDir: home, run: deps.run });
      expect(inv2.items.find((i) => i.id === skillItem.id)!.enabled).toBe(false);

      // Enable skill
      const applyEnable = await applySurfaceChanges(
        { provider: 'agy', changes: [{ itemId: skillItem.id, enabled: true }] },
        { deps },
      );
      expect(applyEnable.ok).toBe(true);

      const disk2 = JSON.parse(fs.readFileSync(skillsJsonPath, 'utf8'));
      expect(disk2.exclude).toBeUndefined();

      const inv3 = await readInventory('agy', { homeDir: home, run: deps.run });
      expect(inv3.items.find((i) => i.id === skillItem.id)!.enabled).toBe(true);
    });

    it('matches exact name only and leaves similar names in exclude untouched', async () => {
      const home = tempDir('wmux-agy-skill-exact-');
      const skillDir = path.join(home, '.gemini', 'config', 'skills', 'my-skill');
      fs.mkdirSync(skillDir, { recursive: true });
      fs.writeFileSync(
        path.join(skillDir, 'SKILL.md'),
        '---\nname: my-skill\ndescription: my skill\n---\n',
      );

      const skillsJsonPath = path.join(home, '.gemini', 'config', 'skills.json');
      fs.writeFileSync(
        skillsJsonPath,
        JSON.stringify({ exclude: ['my-skill-extra', 'other-skill'] }, null, 2),
      );

      const deps = makeDeps(home);
      const inv = await readInventory('agy', { homeDir: home, run: deps.run });
      const skill = inv.items.find((i) => i.name === 'my-skill' && i.source === 'user')!;
      expect(skill.enabled).toBe(true);

      // Disable my-skill
      await applySurfaceChanges(
        { provider: 'agy', changes: [{ itemId: skill.id, enabled: false }] },
        { deps },
      );
      const disk1 = JSON.parse(fs.readFileSync(skillsJsonPath, 'utf8'));
      expect(disk1.exclude).toEqual(['my-skill-extra', 'other-skill', 'my-skill']);

      // Enable my-skill
      await applySurfaceChanges(
        { provider: 'agy', changes: [{ itemId: skill.id, enabled: true }] },
        { deps },
      );
      const disk2 = JSON.parse(fs.readFileSync(skillsJsonPath, 'utf8'));
      expect(disk2.exclude).toEqual(['my-skill-extra', 'other-skill']);
    });

    it('toggling the same skill name in global and project roots only edits the root of the item selected', async () => {
      const home = tempDir('wmux-agy-skill-global-');
      const project = tempDir('wmux-agy-skill-project-');

      // Global skill
      const globalSkillDir = path.join(home, '.gemini', 'config', 'skills', 'shared-skill');
      fs.mkdirSync(globalSkillDir, { recursive: true });
      fs.writeFileSync(
        path.join(globalSkillDir, 'SKILL.md'),
        '---\nname: shared-skill\ndescription: global skill\n---\n',
      );

      // Project skill
      const projectSkillDir = path.join(project, '.agents', 'skills', 'shared-skill');
      fs.mkdirSync(projectSkillDir, { recursive: true });
      fs.writeFileSync(
        path.join(projectSkillDir, 'SKILL.md'),
        '---\nname: shared-skill\ndescription: project skill\n---\n',
      );

      const deps = makeDeps(home, project);
      const inv1 = await readInventory('agy', { homeDir: home, projectDir: project, run: deps.run });
      const globalItem = inv1.items.find((i) => i.kind === 'skill' && i.source === 'user')!;
      const projectItem = inv1.items.find((i) => i.kind === 'skill' && i.source === 'project')!;
      expect(globalItem).toBeDefined();
      expect(projectItem).toBeDefined();
      expect(globalItem.id).not.toBe(projectItem.id);

      const globalSkillsJson = path.join(home, '.gemini', 'config', 'skills.json');
      const projectSkillsJson = path.join(project, '.agents', 'skills.json');

      // Disable ONLY the global skill
      const resGlobal = await applySurfaceChanges(
        { provider: 'agy', changes: [{ itemId: globalItem.id, enabled: false }] },
        { deps, inventoryDeps: { projectDir: project } },
      );
      expect(resGlobal.ok).toBe(true);

      // Global root was edited, project root was untouched
      expect(fs.existsSync(globalSkillsJson)).toBe(true);
      expect(JSON.parse(fs.readFileSync(globalSkillsJson, 'utf8')).exclude).toEqual(['shared-skill']);
      expect(fs.existsSync(projectSkillsJson)).toBe(false);

      // Re-enable global skill to clean up global root
      const resGlobalEnable = await applySurfaceChanges(
        { provider: 'agy', changes: [{ itemId: globalItem.id, enabled: true }] },
        { deps, inventoryDeps: { projectDir: project } },
      );
      expect(resGlobalEnable.ok).toBe(true);
      expect(fs.existsSync(projectSkillsJson)).toBe(false);

      // Now disable ONLY the project skill
      const resProject = await applySurfaceChanges(
        { provider: 'agy', changes: [{ itemId: projectItem.id, enabled: false }] },
        { deps, inventoryDeps: { projectDir: project } },
      );
      expect(resProject.ok).toBe(true);

      // Project root was edited, global root has no exclusions
      expect(fs.existsSync(projectSkillsJson)).toBe(true);
      expect(JSON.parse(fs.readFileSync(projectSkillsJson, 'utf8')).exclude).toEqual(['shared-skill']);
      if (fs.existsSync(globalSkillsJson)) {
        expect(JSON.parse(fs.readFileSync(globalSkillsJson, 'utf8')).exclude).toBeUndefined();
      }
    });

    it('enabling a skill clears exclusion written under frontmatter name as well as directory name', async () => {
      const home = tempDir('wmux-agy-skill-fm-');
      const skillDir = path.join(home, '.gemini', 'config', 'skills', 'skill-dir-name');
      fs.mkdirSync(skillDir, { recursive: true });
      fs.writeFileSync(
        path.join(skillDir, 'SKILL.md'),
        '---\nname: skill-custom-name\ndescription: test skill with custom name\n---\n',
      );

      const skillsJsonPath = path.join(home, '.gemini', 'config', 'skills.json');
      fs.writeFileSync(
        skillsJsonPath,
        JSON.stringify({ exclude: ['skill-custom-name'] }, null, 2),
      );

      const deps = makeDeps(home);
      const inv1 = await readInventory('agy', { homeDir: home, run: deps.run });
      const skillItem = inv1.items.find((i) => i.name === 'skill-custom-name')!;
      expect(skillItem).toBeDefined();
      expect(skillItem.enabled).toBe(false);

      // Enable skill
      const applyEnable = await applySurfaceChanges(
        { provider: 'agy', changes: [{ itemId: skillItem.id, enabled: true }] },
        { deps },
      );
      expect(applyEnable.ok).toBe(true);

      // exclude was cleared from disk
      const disk1 = JSON.parse(fs.readFileSync(skillsJsonPath, 'utf8'));
      expect(disk1.exclude).toBeUndefined();

      // Fresh inventory shows skill enabled
      const inv2 = await readInventory('agy', { homeDir: home, run: deps.run });
      expect(inv2.items.find((i) => i.id === skillItem.id)!.enabled).toBe(true);

      // Now disable it - should add directory name only
      const applyDisable = await applySurfaceChanges(
        { provider: 'agy', changes: [{ itemId: skillItem.id, enabled: false }] },
        { deps },
      );
      expect(applyDisable.ok).toBe(true);

      const disk2 = JSON.parse(fs.readFileSync(skillsJsonPath, 'utf8'));
      expect(disk2.exclude).toEqual(['skill-dir-name']);

      const inv3 = await readInventory('agy', { homeDir: home, run: deps.run });
      expect(inv3.items.find((i) => i.id === skillItem.id)!.enabled).toBe(false);

      // Re-enable clears directory name
      const applyEnable2 = await applySurfaceChanges(
        { provider: 'agy', changes: [{ itemId: skillItem.id, enabled: true }] },
        { deps },
      );
      expect(applyEnable2.ok).toBe(true);

      const inv4 = await readInventory('agy', { homeDir: home, run: deps.run });
      expect(inv4.items.find((i) => i.id === skillItem.id)!.enabled).toBe(true);
    });

    it('preserves non-string elements and ordering in exclude', async () => {
      const home = tempDir('wmux-agy-skill-nonstring-');
      const skillDir = path.join(home, '.gemini', 'config', 'skills', 'skill-a');
      fs.mkdirSync(skillDir, { recursive: true });
      fs.writeFileSync(
        path.join(skillDir, 'SKILL.md'),
        '---\nname: skill-a\ndescription: skill a\n---\n',
      );

      const skillsJsonPath = path.join(home, '.gemini', 'config', 'skills.json');
      fs.writeFileSync(
        skillsJsonPath,
        JSON.stringify({ exclude: [999, 'skill-a', false, { obj: 1 }] }, null, 2),
      );

      const deps = makeDeps(home);
      const inv1 = await readInventory('agy', { homeDir: home, run: deps.run });
      const skill = inv1.items.find((i) => i.name === 'skill-a')!;
      expect(skill).toBeDefined();
      expect(skill.enabled).toBe(false);

      // Enable skill-a
      const applyEnable = await applySurfaceChanges(
        { provider: 'agy', changes: [{ itemId: skill.id, enabled: true }] },
        { deps },
      );
      expect(applyEnable.ok).toBe(true);

      // Non-string entries remain in order, key not deleted
      const diskAfterEnable = JSON.parse(fs.readFileSync(skillsJsonPath, 'utf8'));
      expect(diskAfterEnable.exclude).toEqual([999, false, { obj: 1 }]);

      const inv2 = await readInventory('agy', { homeDir: home, run: deps.run });
      expect(inv2.items.find((i) => i.id === skill.id)!.enabled).toBe(true);

      // Disable skill-a again
      const applyDisable = await applySurfaceChanges(
        { provider: 'agy', changes: [{ itemId: skill.id, enabled: false }] },
        { deps },
      );
      expect(applyDisable.ok).toBe(true);

      const diskAfterDisable = JSON.parse(fs.readFileSync(skillsJsonPath, 'utf8'));
      expect(diskAfterDisable.exclude).toEqual([999, false, { obj: 1 }, 'skill-a']);
    });

    it('edits project skills.json when project skills directory is reached through a symlink', async () => {
      const home = tempDir('wmux-agy-home-');
      const project = tempDir('wmux-agy-project-');

      const realSkillsDir = path.join(project, 'symlinked-skills-store');
      const skillSubdir = path.join(realSkillsDir, 'linked-skill');
      fs.mkdirSync(skillSubdir, { recursive: true });
      fs.writeFileSync(
        path.join(skillSubdir, 'SKILL.md'),
        '---\nname: linked-skill\ndescription: skill reached via symlink\n---\n',
      );

      const agentsDir = path.join(project, '.agents');
      fs.mkdirSync(agentsDir, { recursive: true });
      const linkPath = path.join(agentsDir, 'skills');

      try {
        fs.symlinkSync(realSkillsDir, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
      } catch {
        // Skip if environment does not allow symlink creation
        return;
      }

      const deps = makeDeps(home, project);
      const inv1 = await readInventory('agy', { homeDir: home, projectDir: project, run: deps.run });
      const skillItem = inv1.items.find((i) => i.name === 'linked-skill' && i.source === 'project')!;
      expect(skillItem).toBeDefined();
      expect(skillItem.enabled).toBe(true);

      // Disable linked skill
      const applyDisable = await applySurfaceChanges(
        { provider: 'agy', changes: [{ itemId: skillItem.id, enabled: false }] },
        { deps, inventoryDeps: { projectDir: project } },
      );
      expect(applyDisable.ok).toBe(true);

      const projectSkillsJson = path.join(project, '.agents', 'skills.json');
      const globalSkillsJson = path.join(home, '.gemini', 'config', 'skills.json');

      expect(fs.existsSync(projectSkillsJson)).toBe(true);
      expect(JSON.parse(fs.readFileSync(projectSkillsJson, 'utf8')).exclude).toEqual(['linked-skill']);
      expect(fs.existsSync(globalSkillsJson)).toBe(false);

      const inv2 = await readInventory('agy', { homeDir: home, projectDir: project, run: deps.run });
      expect(inv2.items.find((i) => i.id === skillItem.id)!.enabled).toBe(false);

      // Re-enable linked skill
      const applyEnable = await applySurfaceChanges(
        { provider: 'agy', changes: [{ itemId: skillItem.id, enabled: true }] },
        { deps, inventoryDeps: { projectDir: project } },
      );
      expect(applyEnable.ok).toBe(true);

      expect(JSON.parse(fs.readFileSync(projectSkillsJson, 'utf8')).exclude).toBeUndefined();

      const inv3 = await readInventory('agy', { homeDir: home, projectDir: project, run: deps.run });
      expect(inv3.items.find((i) => i.id === skillItem.id)!.enabled).toBe(true);
    });
  });

  describe('hook', () => {
    it('disables, enables, and round trips user hooks', async () => {
      const home = tempDir('wmux-agy-hook-');
      const cfgDir = path.join(home, '.gemini', 'config');
      fs.mkdirSync(cfgDir, { recursive: true });

      const initialHooks = {
        myHook: {
          event: 'PreInvocation',
          command: 'node hook.js',
        },
      };
      const hooksPath = path.join(cfgDir, 'hooks.json');
      fs.writeFileSync(hooksPath, JSON.stringify(initialHooks, null, 2));

      const deps = makeDeps(home);
      const inv1 = await readInventory('agy', { homeDir: home, run: deps.run });
      const hookItem = inv1.items.find((i) => i.kind === 'hook' && i.name === 'myHook')!;
      expect(hookItem).toBeDefined();
      expect(hookItem.enabled).toBe(true);

      // Preview disable
      const preview = await previewSurfaceChanges(
        { provider: 'agy', changes: [{ itemId: hookItem.id, enabled: false }] },
        { deps },
      );
      expect(preview.edits).toEqual([
        {
          path: hooksPath,
          summary: 'set myHook.enabled = false',
        },
      ]);

      // Apply disable
      const resDisable = await applySurfaceChanges(
        { provider: 'agy', changes: [{ itemId: hookItem.id, enabled: false }] },
        { deps },
      );
      expect(resDisable.ok).toBe(true);

      const diskDisabled = JSON.parse(fs.readFileSync(hooksPath, 'utf8'));
      expect(diskDisabled.myHook.enabled).toBe(false);

      const inv2 = await readInventory('agy', { homeDir: home, run: deps.run });
      expect(inv2.items.find((i) => i.id === hookItem.id)!.enabled).toBe(false);

      // Apply enable
      const resEnable = await applySurfaceChanges(
        { provider: 'agy', changes: [{ itemId: hookItem.id, enabled: true }] },
        { deps },
      );
      expect(resEnable.ok).toBe(true);

      const diskEnabled = JSON.parse(fs.readFileSync(hooksPath, 'utf8'));
      expect(diskEnabled).toEqual(initialHooks);

      const inv3 = await readInventory('agy', { homeDir: home, run: deps.run });
      expect(inv3.items.find((i) => i.id === hookItem.id)!.enabled).toBe(true);
    });

    it('disables a hook in a plugin hooks.json and edits that file', async () => {
      const home = tempDir('wmux-agy-plugin-hook-');
      const pluginDir = path.join(home, '.gemini', 'config', 'plugins', 'hooked-plug');
      fs.mkdirSync(pluginDir, { recursive: true });
      fs.writeFileSync(
        path.join(pluginDir, 'plugin.json'),
        JSON.stringify({ name: 'Hooked Plugin' }, null, 2),
      );

      const pluginHooksPath = path.join(pluginDir, 'hooks.json');
      fs.writeFileSync(
        pluginHooksPath,
        JSON.stringify({
          plugHook: {
            event: 'PostInvocation',
            command: 'echo plugin-hook',
          },
        }, null, 2),
      );

      const deps = makeDeps(home);
      const inv1 = await readInventory('agy', { homeDir: home, run: deps.run });
      const hookItem = inv1.items.find((i) => i.kind === 'hook' && i.source === 'plugin')!;
      expect(hookItem).toBeDefined();
      expect(hookItem.originPath).toBe(pluginHooksPath);

      const res = await applySurfaceChanges(
        { provider: 'agy', changes: [{ itemId: hookItem.id, enabled: false }] },
        { deps },
      );
      expect(res.ok).toBe(true);

      const disk = JSON.parse(fs.readFileSync(pluginHooksPath, 'utf8'));
      expect(disk.plugHook.enabled).toBe(false);

      const inv2 = await readInventory('agy', { homeDir: home, run: deps.run });
      expect(inv2.items.find((i) => i.id === hookItem.id)!.enabled).toBe(false);
    });

    it('handles hooks wrapped in top-level hooks block', async () => {
      const home = tempDir('wmux-agy-hook-block-');
      const cfgDir = path.join(home, '.gemini', 'config');
      fs.mkdirSync(cfgDir, { recursive: true });

      const hooksPath = path.join(cfgDir, 'hooks.json');
      fs.writeFileSync(
        hooksPath,
        JSON.stringify({
          hooks: {
            nestedHook: { event: 'PreInvocation', command: 'node test.js' },
          },
        }, null, 2),
      );

      const deps = makeDeps(home);
      const inv = await readInventory('agy', { homeDir: home, run: deps.run });
      const hookItem = inv.items.find((i) => i.kind === 'hook')!;
      expect(hookItem).toBeDefined();

      const preview = await previewSurfaceChanges(
        { provider: 'agy', changes: [{ itemId: hookItem.id, enabled: false }] },
        { deps },
      );
      expect(preview.edits).toEqual([
        {
          path: hooksPath,
          summary: 'set hooks.nestedHook.enabled = false',
        },
      ]);

      await applySurfaceChanges(
        { provider: 'agy', changes: [{ itemId: hookItem.id, enabled: false }] },
        { deps },
      );

      const disk = JSON.parse(fs.readFileSync(hooksPath, 'utf8'));
      expect(disk.hooks.nestedHook.enabled).toBe(false);
    });
  });

  describe('formatting and integrity', () => {
    it('preserves JSON indentation (4 spaces) and key order', async () => {
      const home = tempDir('wmux-agy-format-');
      const cfgDir = path.join(home, '.gemini', 'config');
      fs.mkdirSync(cfgDir, { recursive: true });

      const mcpPath = path.join(cfgDir, 'mcp_config.json');
      const originalText =
        '{\n' +
        '    "zeta": 100,\n' +
        '    "mcpServers": {\n' +
        '        "srv": {\n' +
        '            "command": "node"\n' +
        '        }\n' +
        '    },\n' +
        '    "alpha": "first"\n' +
        '}\n';

      fs.writeFileSync(mcpPath, originalText, 'utf8');

      const deps = makeDeps(home);
      const inv = await readInventory('agy', { homeDir: home, run: deps.run });
      const srv = inv.items.find((i) => i.name === 'srv')!;

      await applySurfaceChanges(
        { provider: 'agy', changes: [{ itemId: srv.id, enabled: false }] },
        { deps },
      );

      const updatedText = fs.readFileSync(mcpPath, 'utf8');
      expect(updatedText).toContain('    "zeta": 100,');
      expect(updatedText).toContain('    "mcpServers": {');
      expect(updatedText).toContain('    "alpha": "first"');

      // Check key order in the text
      const zetaIndex = updatedText.indexOf('"zeta"');
      const mcpIndex = updatedText.indexOf('"mcpServers"');
      const alphaIndex = updatedText.indexOf('"alpha"');
      expect(zetaIndex).toBeLessThan(mcpIndex);
      expect(mcpIndex).toBeLessThan(alphaIndex);
    });
  });

  describe('safety and errors', () => {
    it('catches ConfigChangedError and reports safe error', async () => {
      const home = tempDir('wmux-agy-race-');
      const cfgDir = path.join(home, '.gemini', 'config');
      fs.mkdirSync(cfgDir, { recursive: true });
      const mcpPath = path.join(cfgDir, 'mcp_config.json');
      fs.writeFileSync(mcpPath, JSON.stringify({ mcpServers: { s: { command: 'node' } } }));

      const deps = makeDeps(home);
      const inv = await readInventory('agy', { homeDir: home, run: deps.run });
      const item = inv.items.find((i) => i.name === 's')!;

      // Simulate concurrent change via ConfigChangedError
      vi.spyOn(safeWrite, 'applyConfigEdit').mockImplementationOnce(() => {
        throw new ConfigChangedError(mcpPath, 'modified');
      });

      const res = await applySurfaceChanges(
        { provider: 'agy', changes: [{ itemId: item.id, enabled: false }] },
        { deps },
      );

      expect(res.ok).toBe(false);
      expect(res.error).toBe('The configuration changed while editing; reload and try again.');
    });

    it('rolls back an earlier file when a later file fails', async () => {
      const home = tempDir('wmux-agy-rollback-');
      const dirA = path.join(home, '.gemini', 'config');
      const dirB = path.join(home, 'other');
      fs.mkdirSync(dirA, { recursive: true });
      fs.mkdirSync(dirB, { recursive: true });
      const fileA = path.join(dirA, 'mcp_config.json');
      const fileB = path.join(dirB, 'mcp_config.json');
      const originalA = JSON.stringify({ mcpServers: { a: { command: 'node' } } });
      fs.writeFileSync(fileA, originalA);
      fs.writeFileSync(fileB, JSON.stringify({ mcpServers: { b: { command: 'node' } } }));

      const mcpItem = (name: string, originPath: string) => ({
        id: `agy:mcp-server::${name}`,
        provider: 'agy' as const,
        kind: 'mcp-server' as const,
        name,
        parent: null,
        source: 'user' as const,
        enabled: true,
        effect: 'removes' as const,
        toggleable: true,
        readOnlyReason: null,
        hookEvent: null,
        hookCost: null,
        descriptionChars: null,
        originPath,
        wmuxRequired: false,
      });
      const a = mcpItem('a', fileA);
      const b = mcpItem('b', fileB);

      const real = safeWrite.applyConfigEdit;
      let calls = 0;
      const spy = vi.spyOn(safeWrite, 'applyConfigEdit').mockImplementation((opts) => {
        calls += 1;
        if (calls === 2) throw new Error('disk full');
        return real(opts);
      });
      try {
        const res = await createAgyWriter().apply({
          deps: makeDeps(home),
          inventory: {
            provider: 'agy',
            cliVersion: '1.2.14',
            versionSupported: true,
            writable: true,
            items: [a, b],
            warnings: [],
            scannedAtMs: 0,
          },
          changes: [
            { item: a, enabled: false },
            { item: b, enabled: false },
          ],
        });
        expect(res.ok).toBe(false);
        expect(res.appliedItemIds).toEqual([]);
        expect(res.error).toBe('Applying the change failed; no file was left half-written.');
        expect(fs.readFileSync(fileA, 'utf8')).toBe(originalA);
      } finally {
        spy.mockRestore();
      }
    });

    it('refuses to modify configuration when target path escapes homeDir and projectDir', async () => {
      const home = tempDir('wmux-agy-escape-home-');
      const outside = tempDir('wmux-agy-outside-');
      const outsideMcp = path.join(outside, 'mcp_config.json');
      const originalOutsideContent = JSON.stringify({ mcpServers: { evil: { command: 'sh' } } });
      fs.writeFileSync(outsideMcp, originalOutsideContent);

      const deps = makeDeps(home);
      const writer = createAgyWriter();

      const evilItem = {
        id: 'agy:mcp-server::evil',
        provider: 'agy' as const,
        kind: 'mcp-server' as const,
        name: 'evil',
        parent: null,
        source: 'user' as const,
        enabled: true,
        effect: 'removes' as const,
        toggleable: true,
        readOnlyReason: null,
        hookEvent: null,
        hookCost: null,
        descriptionChars: null,
        originPath: outsideMcp,
        wmuxRequired: false,
      };

      const preview = await writer.preview({
        deps,
        inventory: {
          provider: 'agy',
          cliVersion: '1.2.14',
          versionSupported: true,
          writable: true,
          items: [evilItem],
          warnings: [],
          scannedAtMs: 1000,
        },
        changes: [{ item: evilItem, enabled: false }],
      });
      expect(preview.edits).toEqual([]);

      const result = await writer.apply({
        deps,
        inventory: {
          provider: 'agy',
          cliVersion: '1.2.14',
          versionSupported: true,
          writable: true,
          items: [evilItem],
          warnings: [],
          scannedAtMs: 1000,
        },
        changes: [{ item: evilItem, enabled: false }],
      });

      expect(result.ok).toBe(false);
      expect(result.appliedItemIds).toEqual([]);
      expect(fs.readFileSync(outsideMcp, 'utf8')).toBe(originalOutsideContent);
    });

    it('refuses symlink pointing outside homeDir', async () => {
      const home = tempDir('wmux-agy-sym-home-');
      const outside = tempDir('wmux-agy-sym-outside-');
      const outsideTarget = path.join(outside, 'secret.json');
      fs.writeFileSync(outsideTarget, JSON.stringify({ secret: true }));

      const linkPath = path.join(home, 'escaped-link.json');
      try {
        fs.symlinkSync(outsideTarget, linkPath);
      } catch {
        // Skip symlink test if OS lacks permissions
        return;
      }

      const deps = makeDeps(home);
      const writer = createAgyWriter();
      const symItem = {
        id: 'agy:mcp-server::sym',
        provider: 'agy' as const,
        kind: 'mcp-server' as const,
        name: 'sym',
        parent: null,
        source: 'user' as const,
        enabled: true,
        effect: 'removes' as const,
        toggleable: true,
        readOnlyReason: null,
        hookEvent: null,
        hookCost: null,
        descriptionChars: null,
        originPath: linkPath,
        wmuxRequired: false,
      };

      await expect(
        writer.apply({
          deps,
          inventory: {
            provider: 'agy',
            cliVersion: '1.2.14',
            versionSupported: true,
            writable: true,
            items: [symItem],
            warnings: [],
            scannedAtMs: 1000,
          },
          changes: [{ item: symItem, enabled: false }],
        }),
      ).resolves.toMatchObject({ ok: false, appliedItemIds: [] });
    });

    it('throws on unsupported item kinds', async () => {
      const home = tempDir('wmux-agy-unsupported-');
      const deps = makeDeps(home);
      const writer = createAgyWriter();

      const unsupportedItem = {
        id: 'agy:builtin-tool::bash',
        provider: 'agy' as const,
        kind: 'builtin-tool' as const,
        name: 'bash',
        parent: null,
        source: 'builtin' as const,
        enabled: true,
        effect: 'blocks' as const,
        toggleable: true,
        readOnlyReason: null,
        hookEvent: null,
        hookCost: null,
        descriptionChars: null,
        originPath: null,
        wmuxRequired: false,
      };

      await expect(
        writer.preview({
          deps,
          inventory: {
            provider: 'agy',
            cliVersion: '1.2.14',
            versionSupported: true,
            writable: true,
            items: [unsupportedItem],
            warnings: [],
            scannedAtMs: 1000,
          },
          changes: [{ item: unsupportedItem, enabled: false }],
        }),
      ).rejects.toThrow('Unsupported item kind: builtin-tool');
    });
  });
});
