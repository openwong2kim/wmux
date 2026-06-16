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
const WMUX_SCRIPT = 'C:\\app\\mcp-bundle\\index.js';

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-mcpreg-'));
});
afterEach(() => {
  try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* best-effort */ }
});

describe('registerTarget — Claude (json, createIfMissing)', () => {
  it('creates ~/.claude.json and writes the wmux server', () => {
    const r = registerTarget(claudeTarget, home, WMUX_SCRIPT);
    expect(r.skipped).toBeNull();
    expect(r.wrote).toEqual(['wmux']);
    expect(readTargetStatus(claudeTarget, home).wmux).toEqual({ registered: true, path: WMUX_SCRIPT });
  });

  it('is idempotent — re-register writes nothing the second time', () => {
    registerTarget(claudeTarget, home, WMUX_SCRIPT);
    const r2 = registerTarget(claudeTarget, home, WMUX_SCRIPT);
    expect(r2.wrote).toEqual([]);
  });

  it('updates a stale path written by a prior session', () => {
    registerTarget(claudeTarget, home, 'C:\\old\\index.js');
    const r = registerTarget(claudeTarget, home, WMUX_SCRIPT);
    expect(r.wrote).toContain('wmux');
    expect(readTargetStatus(claudeTarget, home).wmux.path).toBe(WMUX_SCRIPT);
  });

  it('leaves a FOREIGN (non-node) wmux entry untouched', () => {
    const p = claudeTarget.configPath(home);
    fs.writeFileSync(p, JSON.stringify({ mcpServers: { wmux: { command: 'python', args: ['/x.py'] } } }), 'utf8');
    const r = registerTarget(claudeTarget, home, WMUX_SCRIPT);
    expect(r.foreign).toContain('wmux');
    expect(r.wrote).toEqual([]);
    const after = JSON.parse(fs.readFileSync(p, 'utf8')) as { mcpServers: Record<string, { command: string }> };
    expect(after.mcpServers.wmux.command).toBe('python');
  });

  it('drops a historical stray wmux-a2a key from Claude JSON (dead-server cleanup)', () => {
    const p = claudeTarget.configPath(home);
    fs.writeFileSync(p, JSON.stringify({ mcpServers: { 'wmux-a2a': { command: 'node', args: ['/old/a2a.js'] } } }), 'utf8');
    registerTarget(claudeTarget, home, WMUX_SCRIPT);
    const after = JSON.parse(fs.readFileSync(p, 'utf8')) as { mcpServers: Record<string, unknown> };
    expect(after.mcpServers['wmux-a2a']).toBeUndefined();
    expect(after.mcpServers.wmux).toBeTruthy();
  });
});

describe('registerTarget — Codex (toml, only if installed)', () => {
  it('SKIPS when ~/.codex/config.toml does not exist (never created)', () => {
    const r = registerTarget(codexTarget, home, WMUX_SCRIPT);
    expect(r.skipped).toBe('absent');
    expect(fs.existsSync(codexTarget.configPath(home))).toBe(false);
  });

  it('appends to an existing config.toml, preserving foreign tables/comments byte-stable', () => {
    const p = codexTarget.configPath(home);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const original = `# hand-written\nmodel = "gpt-5.5"\n\n[projects.'d:\\wmux']\ntrust_level = "trusted"\n`;
    fs.writeFileSync(p, original, 'utf8');

    const r = registerTarget(codexTarget, home, WMUX_SCRIPT);
    expect(r.wrote).toEqual(['wmux']);

    const after = fs.readFileSync(p, 'utf8');
    expect(after).toContain('# hand-written');
    expect(after).toContain(`[projects.'d:\\wmux']`); // backslash key NOT corrupted
    expect(after).toContain('[mcp_servers.wmux]');
    expect(readTargetStatus(codexTarget, home).wmux).toEqual({ registered: true, path: WMUX_SCRIPT });
  });

  it('leaves a malformed config.toml untouched (never clobbers)', () => {
    const p = codexTarget.configPath(home);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, 'this = = broken', 'utf8');
    const r = registerTarget(codexTarget, home, WMUX_SCRIPT);
    expect(r.skipped).toBe('malformed');
    expect(fs.readFileSync(p, 'utf8')).toBe('this = = broken');
  });

  // Regression (independent review): an inline-table form under a [mcp_servers]
  // parent can't be surgically replaced by the line-based editor. The
  // output-validation guard must abort rather than append a duplicate table.
  it('does NOT corrupt an inline-table mcp_servers.wmux entry (aborts the write)', () => {
    const p = codexTarget.configPath(home);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const inline = `[mcp_servers]\nwmux = { command = "node", args = ["C:\\\\old\\\\i.js"] }\n`;
    fs.writeFileSync(p, inline, 'utf8');
    const r = registerTarget(codexTarget, home, WMUX_SCRIPT);
    expect(r.wrote).toEqual([]);
    expect(fs.readFileSync(p, 'utf8')).toBe(inline);
    expect(() => readTargetStatus(codexTarget, home)).not.toThrow();
  });
});

describe('registerTarget — Gemini (unverified, never created)', () => {
  it('SKIPS when settings.json does not exist', () => {
    const r = registerTarget(geminiTarget, home, WMUX_SCRIPT);
    expect(r.skipped).toBe('absent');
    expect(fs.existsSync(geminiTarget.configPath(home))).toBe(false);
  });

  it('writes into an existing settings.json (mcpServers, json)', () => {
    const p = geminiTarget.configPath(home);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify({ theme: 'dark' }), 'utf8');
    const r = registerTarget(geminiTarget, home, WMUX_SCRIPT);
    expect(r.wrote).toEqual(['wmux']);
    const after = JSON.parse(fs.readFileSync(p, 'utf8')) as { theme: string; mcpServers: Record<string, unknown> };
    expect(after.theme).toBe('dark');
    expect(after.mcpServers.wmux).toBeTruthy();
  });
});

describe('unregisterTarget', () => {
  it('removes the wmux key from Codex TOML, preserving foreign data', () => {
    const p = codexTarget.configPath(home);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, `[tui]\ntheme = "dark"\n`, 'utf8');
    registerTarget(codexTarget, home, WMUX_SCRIPT);

    const r = unregisterTarget(codexTarget, home);
    expect(r.removed).toEqual(['wmux']);
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
