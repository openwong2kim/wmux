import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Use a per-test temp directory as the simulated home so we can exercise
// real fs reads/writes without touching the developer's actual configs.
let tmpHome = '';

vi.mock('electron', () => ({
  app: {
    getPath: (key: string) => {
      if (key === 'home') return tmpHome;
      throw new Error(`unexpected getPath(${key}) in test`);
    },
    isPackaged: false,
    getAppPath: () => tmpHome, // dev-mode script discovery walks up; harmless here
  },
}));

vi.mock('../../../shared/security', () => ({ secureWriteTokenFile: vi.fn() }));
vi.mock('../../../shared/errors/macos', () => ({
  formatMacosError: vi.fn(() => ''),
  MACOS_ERRORS: { mcpPermissionDenied: { code: 'TEST', summary: '', remedy: '' } },
}));
vi.mock('../../../shared/platform', () => ({ isMac: false }));

// IMPORTANT: import the SUT after vi.mock() declarations.
import { McpRegistrar, type McpRegistrarStatus, type McpTargetStatus } from '../McpRegistrar';

const claudeJson = () => path.join(tmpHome, '.claude.json');
const codexToml = () => path.join(tmpHome, '.codex', 'config.toml');
const geminiJson = () => path.join(tmpHome, '.gemini', 'settings.json');
const target = (s: McpRegistrarStatus, id: string): McpTargetStatus =>
  s.targets.find((t) => t.id === id) as McpTargetStatus;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-mcp-test-'));
});
afterEach(() => {
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
});

describe('McpRegistrar.getStatus (multi-target)', () => {
  it('reports every target as not registered when no configs exist', () => {
    const status = new McpRegistrar().getStatus();
    expect(status.targets.map((t) => t.id).sort()).toEqual(['claude', 'codex', 'gemini']);
    for (const t of status.targets) {
      expect(t.configExists).toBe(false);
      expect(t.configModified).toBeNull();
      expect(t.wmux).toEqual({ registered: false, path: null });
    }
    expect(target(status, 'claude').configPath).toBe(claudeJson());
    expect(target(status, 'codex').configPath).toBe(codexToml());
  });

  it('does NOT create any config file as a side effect of getStatus', () => {
    new McpRegistrar().getStatus();
    expect(fs.existsSync(claudeJson())).toBe(false);
    expect(fs.existsSync(codexToml())).toBe(false);
  });

  it('extracts registered script paths from Claude JSON', () => {
    const cfg = {
      mcpServers: {
        wmux: { command: 'node', args: ['/abs/mcp-bundle/index.js'] },
        'someone-else': { command: 'node', args: ['/elsewhere/index.js'] },
      },
    };
    fs.writeFileSync(claudeJson(), JSON.stringify(cfg), 'utf8');

    const claude = target(new McpRegistrar().getStatus(), 'claude');
    expect(claude.configExists).toBe(true);
    expect(claude.configModified).toBeInstanceOf(Date);
    expect(claude.wmux).toEqual({ registered: true, path: '/abs/mcp-bundle/index.js' });
  });

  it('extracts registered script paths from Codex TOML (mcp_servers table)', () => {
    fs.mkdirSync(path.dirname(codexToml()), { recursive: true });
    fs.writeFileSync(
      codexToml(),
      `[mcp_servers.wmux]\ncommand = "node"\nargs = ["C:\\\\w\\\\index.js"]\n`,
      'utf8',
    );
    const codex = target(new McpRegistrar().getStatus(), 'codex');
    expect(codex.configExists).toBe(true);
    expect(codex.format).toBe('toml');
    expect(codex.wmux).toEqual({ registered: true, path: 'C:\\w\\index.js' });
  });

  it('treats malformed entries / corrupt configs as not registered (no throw)', () => {
    fs.writeFileSync(
      claudeJson(),
      JSON.stringify({ mcpServers: { wmux: { command: 'node' }, 'wmux-a2a': { command: 'node', args: [] } } }),
      'utf8',
    );
    fs.mkdirSync(path.dirname(codexToml()), { recursive: true });
    fs.writeFileSync(codexToml(), 'this = = broken', 'utf8');

    const status = new McpRegistrar().getStatus();
    expect(target(status, 'claude').wmux.registered).toBe(false);
    expect(target(status, 'codex').configExists).toBe(true);
    expect(target(status, 'codex').wmux.registered).toBe(false);
  });

  it('marks claude/codex verified and gemini unverified', () => {
    const status = new McpRegistrar().getStatus();
    expect(target(status, 'claude').verified).toBe(true);
    expect(target(status, 'codex').verified).toBe(true);
    expect(target(status, 'gemini').verified).toBe(false);
  });
});

describe('McpRegistrar.forceUnregister (multi-target)', () => {
  it('removes the wmux key from both Claude JSON and Codex TOML, leaving foreign intact', () => {
    fs.writeFileSync(
      claudeJson(),
      JSON.stringify({
        mcpServers: {
          wmux: { command: 'node', args: ['/x/wmux.js'] },
          'someone-else': { command: 'node', args: ['/y/other.js'] },
        },
        otherTopLevel: { keep: true },
      }),
      'utf8',
    );
    fs.mkdirSync(path.dirname(codexToml()), { recursive: true });
    fs.writeFileSync(
      codexToml(),
      `# comment\n[projects.'d:\\wmux']\ntrust_level = "trusted"\n\n[mcp_servers.wmux]\ncommand = "node"\nargs = ["C:\\\\w\\\\i.js"]\n`,
      'utf8',
    );

    new McpRegistrar().forceUnregister();

    const claudeAfter = JSON.parse(fs.readFileSync(claudeJson(), 'utf8')) as {
      mcpServers?: Record<string, unknown>; otherTopLevel?: unknown;
    };
    expect(claudeAfter.mcpServers).toEqual({ 'someone-else': { command: 'node', args: ['/y/other.js'] } });
    expect(claudeAfter.otherTopLevel).toEqual({ keep: true });

    const codexAfter = fs.readFileSync(codexToml(), 'utf8');
    expect(codexAfter).not.toContain('[mcp_servers.wmux]');
    // Foreign comment + backslash-key project table preserved byte-stable.
    expect(codexAfter).toContain('# comment');
    expect(codexAfter).toContain(`[projects.'d:\\wmux']`);
  });

  it('is a safe no-op when no configs exist (creates nothing)', () => {
    expect(() => new McpRegistrar().forceUnregister()).not.toThrow();
    expect(fs.existsSync(claudeJson())).toBe(false);
    expect(fs.existsSync(codexToml())).toBe(false);
    expect(fs.existsSync(geminiJson())).toBe(false);
  });
});

describe('McpRegistrar.unregister (legacy no-op)', () => {
  it('does NOT remove keys (preserves the chicken-and-egg fix)', () => {
    fs.writeFileSync(
      claudeJson(),
      JSON.stringify({ mcpServers: { wmux: { command: 'node', args: ['/x/wmux.js'] } } }),
      'utf8',
    );
    new McpRegistrar().unregister();
    const after = JSON.parse(fs.readFileSync(claudeJson(), 'utf8')) as { mcpServers?: Record<string, unknown> };
    expect(after.mcpServers?.wmux).toBeDefined();
  });
});
