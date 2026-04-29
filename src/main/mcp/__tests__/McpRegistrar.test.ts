import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Use a per-test temp directory as the simulated home so we can exercise
// real fs reads/writes without touching the developer's actual ~/.claude.json.
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

// secureWriteTokenFile is invoked by register(); stub it so we don't try to
// run icacls / chmod under tests.
vi.mock('../../../shared/security', () => ({
  secureWriteTokenFile: vi.fn(),
}));

// Avoid requiring the real macOS error catalogue at import time.
vi.mock('../../../shared/errors/macos', () => ({
  formatMacosError: vi.fn(() => ''),
  MACOS_ERRORS: { mcpPermissionDenied: { code: 'TEST', summary: '', remedy: '' } },
}));

vi.mock('../../../shared/platform', () => ({ isMac: false }));

// IMPORTANT: import the SUT after vi.mock() declarations.
import { McpRegistrar } from '../McpRegistrar';

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-mcp-test-'));
});

afterEach(() => {
  try {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

describe('McpRegistrar.getStatus', () => {
  it('reports both servers as not registered when ~/.claude.json is absent', () => {
    const registrar = new McpRegistrar();
    const status = registrar.getStatus();

    expect(status.configExists).toBe(false);
    expect(status.configModified).toBeNull();
    expect(status.wmux).toEqual({ registered: false, path: null });
    expect(status.wmuxA2a).toEqual({ registered: false, path: null });
    expect(status.configPath).toBe(path.join(tmpHome, '.claude.json'));
  });

  it('does NOT create ~/.claude.json as a side effect of getStatus', () => {
    const registrar = new McpRegistrar();
    registrar.getStatus();
    expect(fs.existsSync(path.join(tmpHome, '.claude.json'))).toBe(false);
  });

  it('extracts registered script paths from ~/.claude.json', () => {
    const cfg = {
      mcpServers: {
        wmux: { command: 'node', args: ['/abs/path/to/mcp-bundle/index.js'] },
        'wmux-a2a': { command: 'node', args: ['/abs/path/to/a2a-bundle/index.js'] },
        // Unrelated entry must be ignored, not considered for our status.
        'someone-else': { command: 'node', args: ['/elsewhere/index.js'] },
      },
    };
    fs.writeFileSync(path.join(tmpHome, '.claude.json'), JSON.stringify(cfg), 'utf8');

    const registrar = new McpRegistrar();
    const status = registrar.getStatus();

    expect(status.configExists).toBe(true);
    expect(status.configModified).toBeInstanceOf(Date);
    expect(status.wmux).toEqual({ registered: true, path: '/abs/path/to/mcp-bundle/index.js' });
    expect(status.wmuxA2a).toEqual({ registered: true, path: '/abs/path/to/a2a-bundle/index.js' });
  });

  it('treats malformed entries as not registered', () => {
    const cfg = {
      mcpServers: {
        wmux: { command: 'node' /* missing args */ },
        'wmux-a2a': { command: 'node', args: [] /* empty */ },
      },
    };
    fs.writeFileSync(path.join(tmpHome, '.claude.json'), JSON.stringify(cfg), 'utf8');

    const status = new McpRegistrar().getStatus();
    expect(status.wmux.registered).toBe(false);
    expect(status.wmuxA2a.registered).toBe(false);
  });

  it('returns "not registered" rather than throwing on corrupted JSON', () => {
    fs.writeFileSync(path.join(tmpHome, '.claude.json'), '{ this is not json', 'utf8');

    const status = new McpRegistrar().getStatus();
    expect(status.configExists).toBe(true);
    expect(status.wmux.registered).toBe(false);
    expect(status.wmuxA2a.registered).toBe(false);
  });
});

describe('McpRegistrar.forceUnregister', () => {
  it('removes only wmux + wmux-a2a, leaving foreign entries intact', () => {
    const cfg = {
      mcpServers: {
        wmux: { command: 'node', args: ['/x/wmux.js'] },
        'wmux-a2a': { command: 'node', args: ['/x/a2a.js'] },
        'someone-else': { command: 'node', args: ['/y/other.js'] },
      },
      otherTopLevel: { keep: true },
    };
    fs.writeFileSync(path.join(tmpHome, '.claude.json'), JSON.stringify(cfg), 'utf8');

    new McpRegistrar().forceUnregister();

    const after = JSON.parse(
      fs.readFileSync(path.join(tmpHome, '.claude.json'), 'utf8'),
    ) as { mcpServers?: Record<string, unknown>; otherTopLevel?: unknown };
    expect(after.mcpServers).toEqual({
      'someone-else': { command: 'node', args: ['/y/other.js'] },
    });
    expect(after.otherTopLevel).toEqual({ keep: true });
  });

  it('drops the empty mcpServers object when wmux were the only entries', () => {
    const cfg = {
      mcpServers: {
        wmux: { command: 'node', args: ['/x/wmux.js'] },
        'wmux-a2a': { command: 'node', args: ['/x/a2a.js'] },
      },
    };
    fs.writeFileSync(path.join(tmpHome, '.claude.json'), JSON.stringify(cfg), 'utf8');

    new McpRegistrar().forceUnregister();

    const after = JSON.parse(
      fs.readFileSync(path.join(tmpHome, '.claude.json'), 'utf8'),
    ) as { mcpServers?: unknown };
    expect(after.mcpServers).toBeUndefined();
  });

  it('is a safe no-op when ~/.claude.json does not exist', () => {
    expect(() => new McpRegistrar().forceUnregister()).not.toThrow();
    // Should not have created the file.
    expect(fs.existsSync(path.join(tmpHome, '.claude.json'))).toBe(false);
  });
});

describe('McpRegistrar.unregister (legacy no-op)', () => {
  it('does NOT remove keys (preserves the chicken-and-egg fix)', () => {
    const cfg = {
      mcpServers: {
        wmux: { command: 'node', args: ['/x/wmux.js'] },
        'wmux-a2a': { command: 'node', args: ['/x/a2a.js'] },
      },
    };
    fs.writeFileSync(path.join(tmpHome, '.claude.json'), JSON.stringify(cfg), 'utf8');

    new McpRegistrar().unregister();

    const after = JSON.parse(
      fs.readFileSync(path.join(tmpHome, '.claude.json'), 'utf8'),
    ) as { mcpServers?: Record<string, unknown> };
    expect(after.mcpServers?.wmux).toBeDefined();
    expect(after.mcpServers?.['wmux-a2a']).toBeDefined();
  });
});
