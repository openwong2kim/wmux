import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MCP_TARGETS, getMcpTarget } from '../mcpTargets';
import {
  readTargetStatus,
  registerTarget,
  unregisterTarget,
} from '../mcpRegistration';

let home = '';
const claudeTarget = getMcpTarget('claude')!;
const codexTarget = getMcpTarget('codex')!;
const geminiTarget = getMcpTarget('gemini')!;
const SCRIPTS = { wmux: 'C:\\app\\mcp-bundle\\index.js', a2a: 'C:\\app\\a2a-bundle\\index.js' };

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-mcpreg-'));
});
afterEach(() => {
  try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* best-effort */ }
});

describe('registerTarget — Claude (json, createIfMissing)', () => {
  it('creates ~/.claude.json and writes both servers', () => {
    const r = registerTarget(claudeTarget, home, SCRIPTS);
    expect(r.skipped).toBeNull();
    expect(r.wrote.sort()).toEqual(['wmux', 'wmux-a2a']);
    const status = readTargetStatus(claudeTarget, home);
    expect(status.wmux).toEqual({ registered: true, path: SCRIPTS.wmux });
    expect(status.wmuxA2a).toEqual({ registered: true, path: SCRIPTS.a2a });
  });

  it('is idempotent — re-register writes nothing the second time', () => {
    registerTarget(claudeTarget, home, SCRIPTS);
    const r2 = registerTarget(claudeTarget, home, SCRIPTS);
    expect(r2.wrote).toEqual([]);
  });

  it('updates a stale path written by a prior session', () => {
    registerTarget(claudeTarget, home, { wmux: 'C:\\old\\index.js', a2a: null });
    const r = registerTarget(claudeTarget, home, SCRIPTS);
    expect(r.wrote).toContain('wmux');
    expect(readTargetStatus(claudeTarget, home).wmux.path).toBe(SCRIPTS.wmux);
  });

  it('leaves a FOREIGN (non-node) wmux entry untouched', () => {
    const p = claudeTarget.configPath(home);
    fs.writeFileSync(p, JSON.stringify({ mcpServers: { wmux: { command: 'python', args: ['/x.py'] } } }), 'utf8');
    const r = registerTarget(claudeTarget, home, SCRIPTS);
    expect(r.foreign).toContain('wmux');
    const after = JSON.parse(fs.readFileSync(p, 'utf8')) as { mcpServers: Record<string, { command: string }> };
    expect(after.mcpServers.wmux.command).toBe('python');
    // wmux-a2a (absent) is still written.
    expect(after.mcpServers['wmux-a2a']).toBeTruthy();
  });
});

describe('registerTarget — Codex (toml, only if installed)', () => {
  it('SKIPS when ~/.codex/config.toml does not exist (never created)', () => {
    const r = registerTarget(codexTarget, home, SCRIPTS);
    expect(r.skipped).toBe('absent');
    expect(fs.existsSync(codexTarget.configPath(home))).toBe(false);
  });

  it('appends to an existing config.toml, preserving foreign tables/comments byte-stable', () => {
    const p = codexTarget.configPath(home);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const original = `# hand-written\nmodel = "gpt-5.5"\n\n[projects.'d:\\wmux']\ntrust_level = "trusted"\n`;
    fs.writeFileSync(p, original, 'utf8');

    const r = registerTarget(codexTarget, home, SCRIPTS);
    expect(r.wrote.sort()).toEqual(['wmux', 'wmux-a2a']);

    const after = fs.readFileSync(p, 'utf8');
    expect(after).toContain('# hand-written');
    expect(after).toContain(`[projects.'d:\\wmux']`); // backslash key NOT corrupted
    expect(after).toContain('[mcp_servers.wmux]');

    const status = readTargetStatus(codexTarget, home);
    expect(status.wmux).toEqual({ registered: true, path: SCRIPTS.wmux });
    expect(status.wmuxA2a).toEqual({ registered: true, path: SCRIPTS.a2a });
  });

  it('leaves a malformed config.toml untouched (never clobbers)', () => {
    const p = codexTarget.configPath(home);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, 'this = = broken', 'utf8');
    const r = registerTarget(codexTarget, home, SCRIPTS);
    expect(r.skipped).toBe('malformed');
    expect(fs.readFileSync(p, 'utf8')).toBe('this = = broken');
  });

  // Regression (independent review P1): an inline-table form under a
  // [mcp_servers] parent can't be surgically replaced by the line-based editor.
  // The output-validation guard must abort rather than append a duplicate table
  // that makes the file unparseable.
  it('does NOT corrupt an inline-table mcp_servers.wmux entry (aborts the write)', () => {
    const p = codexTarget.configPath(home);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const inline = `[mcp_servers]\nwmux = { command = "node", args = ["C:\\\\old\\\\i.js"] }\n`;
    fs.writeFileSync(p, inline, 'utf8');
    const r = registerTarget(codexTarget, home, SCRIPTS);
    // Left untouched (safe), and the file still parses (no duplicate table).
    expect(r.wrote).toEqual([]);
    expect(fs.readFileSync(p, 'utf8')).toBe(inline);
    expect(() => readTargetStatus(codexTarget, home)).not.toThrow();
  });
});

describe('registerTarget — Gemini (unverified, never created)', () => {
  it('SKIPS when settings.json does not exist', () => {
    const r = registerTarget(geminiTarget, home, SCRIPTS);
    expect(r.skipped).toBe('absent');
    expect(fs.existsSync(geminiTarget.configPath(home))).toBe(false);
  });

  it('writes into an existing settings.json (mcpServers, json)', () => {
    const p = geminiTarget.configPath(home);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify({ theme: 'dark' }), 'utf8');
    const r = registerTarget(geminiTarget, home, SCRIPTS);
    expect(r.wrote.sort()).toEqual(['wmux', 'wmux-a2a']);
    const after = JSON.parse(fs.readFileSync(p, 'utf8')) as { theme: string; mcpServers: Record<string, unknown> };
    expect(after.theme).toBe('dark');
    expect(after.mcpServers.wmux).toBeTruthy();
  });
});

describe('unregisterTarget', () => {
  it('removes only wmux-owned keys from Codex TOML, preserving foreign data', () => {
    const p = codexTarget.configPath(home);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, `[tui]\ntheme = "dark"\n`, 'utf8');
    registerTarget(codexTarget, home, SCRIPTS);

    const r = unregisterTarget(codexTarget, home);
    expect(r.removed.sort()).toEqual(['wmux', 'wmux-a2a']);
    const after = fs.readFileSync(p, 'utf8');
    expect(after).not.toContain('[mcp_servers.wmux]');
    expect(after).toContain('[tui]');
  });

  it('is a no-op when config is absent', () => {
    const r = unregisterTarget(codexTarget, home);
    expect(r.configExisted).toBe(false);
    expect(r.removed).toEqual([]);
  });

  // Codex review: an inline-table entry the line-based editor can't target must
  // not report a removal that didn't happen.
  it('reports removed=[] when the entry is an un-targetable inline table (no false removal)', () => {
    const p = codexTarget.configPath(home);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const inline = `[mcp_servers]\nwmux = { command = "node", args = ["/x.js"] }\n`;
    fs.writeFileSync(p, inline, 'utf8');
    const r = unregisterTarget(codexTarget, home);
    expect(r.removed).toEqual([]);
    expect(fs.readFileSync(p, 'utf8')).toBe(inline); // untouched
  });

  // Codex final review: a MIXED config (un-targetable inline wmux + removable
  // header-form wmux-a2a) must report ONLY the key actually removed.
  it('reports only the actually-removed key in a mixed inline/header config', () => {
    const p = codexTarget.configPath(home);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(
      p,
      `[mcp_servers]\nwmux = { command = "node", args = ["/x.js"] }\n\n[mcp_servers.wmux-a2a]\ncommand = "node"\nargs = ["/a.js"]\n`,
      'utf8',
    );
    const r = unregisterTarget(codexTarget, home);
    expect(r.removed).toEqual(['wmux-a2a']); // NOT ['wmux','wmux-a2a']
    const after = fs.readFileSync(p, 'utf8');
    expect(after).toContain('wmux = { command = "node"'); // inline wmux survives
    expect(after).not.toContain('[mcp_servers.wmux-a2a]');
  });
});

describe('MCP_TARGETS registry', () => {
  it('has the expected ids, formats, and create policy', () => {
    expect(MCP_TARGETS.map((t) => t.id)).toEqual(['claude', 'codex', 'gemini']);
    expect(getMcpTarget('claude')!.createIfMissing).toBe(true);
    expect(getMcpTarget('codex')!.createIfMissing).toBe(false);
    expect(getMcpTarget('codex')!.format).toBe('toml');
    expect(getMcpTarget('gemini')!.createIfMissing).toBe(false);
  });
});
