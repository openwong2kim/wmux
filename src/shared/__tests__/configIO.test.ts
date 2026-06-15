import { describe, it, expect } from 'vitest';
import {
  parseConfig,
  getMcpServerScript,
  getMcpServerEntry,
  isWmuxOwnedEntry,
  upsertMcpServer,
  removeMcpServers,
  ConfigParseError,
} from '../configIO';

// ── TOML (Codex) — surgical block, must preserve every other byte ────────────

// A realistic Codex config: a leading comment, a Windows-path literal-key table
// (the exact shape that a smol-toml round-trip corrupts), and a nested table.
const CODEX_CONFIG = `# user's hand-written config — must survive
model = "gpt-5.5"

[projects.'d:\\wmux']
trust_level = "trusted"

[projects.'c:\\users\\rizz']
trust_level = "trusted"

[tui.model_availability_nux]
"gpt-5.5" = 4
`;

describe('configIO — TOML surgical write', () => {
  it('appends [mcp_servers.wmux] at EOF and preserves all foreign bytes', () => {
    const out = upsertMcpServer(CODEX_CONFIG, 'toml', 'wmux', 'C:\\wmux\\index.js');
    // Every original line survives verbatim (comments, ordering, backslash keys).
    expect(out).toContain(`# user's hand-written config — must survive`);
    expect(out).toContain(`[projects.'d:\\wmux']`);
    expect(out).toContain(`[projects.'c:\\users\\rizz']`);
    expect(out).toContain(`[tui.model_availability_nux]`);
    // New block appended in canonical Codex shape.
    expect(out).toContain('[mcp_servers.wmux]');
    expect(out).toContain('command = "node"');
    // The Windows backslash path round-trips correctly through parse.
    const parsed = parseConfig(out, 'toml');
    expect(getMcpServerScript(parsed, 'toml', 'wmux')).toBe('C:\\wmux\\index.js');
    // Foreign backslash project keys are NOT corrupted.
    expect((parsed.projects as Record<string, unknown>)['d:\\wmux']).toBeTruthy();
    expect((parsed.projects as Record<string, unknown>)['c:\\users\\rizz']).toBeTruthy();
  });

  it('is idempotent: re-upserting the same path is a no-op on re-parse', () => {
    const once = upsertMcpServer(CODEX_CONFIG, 'toml', 'wmux', 'C:\\wmux\\index.js');
    const twice = upsertMcpServer(once, 'toml', 'wmux', 'C:\\wmux\\index.js');
    expect(twice).toBe(once);
  });

  it('replaces an existing block (incl. child sub-tables) on path change', () => {
    const withEnv = `[mcp_servers.wmux]
command = "node"
args = ["C:\\\\old\\\\index.js"]

[mcp_servers.wmux.env]
FOO = "bar"

[other]
keep = true
`;
    const out = upsertMcpServer(withEnv, 'toml', 'wmux', 'C:\\new\\index.js');
    const parsed = parseConfig(out, 'toml');
    expect(getMcpServerScript(parsed, 'toml', 'wmux')).toBe('C:\\new\\index.js');
    // The stale child env sub-table is gone (replaced as part of the block)…
    expect(out).not.toContain('FOO = "bar"');
    // …but the unrelated [other] table is preserved.
    expect((parsed.other as Record<string, unknown>).keep).toBe(true);
  });

  it('removes only the wmux blocks, leaving foreign tables intact', () => {
    const seeded = upsertMcpServer(
      upsertMcpServer(CODEX_CONFIG, 'toml', 'wmux', 'C:\\w\\i.js'),
      'toml',
      'wmux-a2a',
      'C:\\w\\a.js',
    );
    const removed = removeMcpServers(seeded, 'toml', ['wmux', 'wmux-a2a']);
    const parsed = parseConfig(removed, 'toml');
    expect(getMcpServerScript(parsed, 'toml', 'wmux')).toBeNull();
    expect(getMcpServerScript(parsed, 'toml', 'wmux-a2a')).toBeNull();
    expect(parsed.model).toBe('gpt-5.5');
    expect((parsed.projects as Record<string, unknown>)['d:\\wmux']).toBeTruthy();
    expect((parsed.tui as Record<string, unknown>).model_availability_nux).toBeTruthy();
  });

  it('preserves CRLF line endings', () => {
    const crlf = CODEX_CONFIG.replace(/\n/g, '\r\n');
    const out = upsertMcpServer(crlf, 'toml', 'wmux', 'C:\\w\\i.js');
    expect(out).toContain('\r\n');
    expect(out).not.toMatch(/[^\r]\n/); // no lone LF
    expect(getMcpServerScript(parseConfig(out, 'toml'), 'toml', 'wmux')).toBe('C:\\w\\i.js');
  });

  it('handles a quoted/dashed key (wmux-a2a) and an empty file', () => {
    const out = upsertMcpServer('', 'toml', 'wmux-a2a', 'C:\\w\\a.js');
    expect(out).toContain('[mcp_servers.wmux-a2a]');
    expect(getMcpServerScript(parseConfig(out, 'toml'), 'toml', 'wmux-a2a')).toBe('C:\\w\\a.js');
  });

  it('throws ConfigParseError on malformed TOML (never clobbers)', () => {
    expect(() => upsertMcpServer('this = = broken', 'toml', 'wmux', 'x')).toThrow(ConfigParseError);
  });

  it('does NOT remove a foreign array-of-tables [[mcp_servers.wmux]] (P2: bracket match)', () => {
    const arr = `[[mcp_servers.wmux]]\ncommand = "other"\nargs = ["x"]\n`;
    // removeMcpServers must leave the array-of-tables construct untouched.
    expect(removeMcpServers(arr, 'toml', ['wmux'])).toBe(arr);
  });

  it('throws when the surgical edit would produce invalid TOML (inline-table → duplicate)', () => {
    const inline = `[mcp_servers]\nwmux = { command = "node", args = ["/old.js"] }\n`;
    expect(() => upsertMcpServer(inline, 'toml', 'wmux', '/new.js')).toThrow(ConfigParseError);
  });

  it('recognizes a header with a trailing inline comment (P2)', () => {
    const withComment = `[mcp_servers.wmux] # wmux server\ncommand = "node"\nargs = ["/old.js"]\n\n[other]\nx = 1\n`;
    const out = upsertMcpServer(withComment, 'toml', 'wmux', '/new.js');
    // Replaced in place (not duplicated) → still parses, path updated, [other] kept.
    const parsed = parseConfig(out, 'toml');
    expect(getMcpServerScript(parsed, 'toml', 'wmux')).toBe('/new.js');
    expect((parsed.other as Record<string, unknown>).x).toBe(1);
    expect(removeMcpServers(out, 'toml', ['wmux'])).not.toContain('[mcp_servers.wmux]');
  });
});

// ── JSON (Claude / Gemini) ───────────────────────────────────────────────────

describe('configIO — JSON write', () => {
  const CLAUDE = JSON.stringify({
    mcpServers: { foreign: { command: 'x', args: ['y'] } },
    otherTopLevel: 42,
  });

  it('upserts wmux while preserving foreign servers and top-level keys', () => {
    const out = upsertMcpServer(CLAUDE, 'json', 'wmux', '/abs/index.js');
    const parsed = parseConfig(out, 'json');
    expect(getMcpServerScript(parsed, 'json', 'wmux')).toBe('/abs/index.js');
    expect((parsed.mcpServers as Record<string, unknown>).foreign).toBeTruthy();
    expect(parsed.otherTopLevel).toBe(42);
  });

  it('removes wmux keys and drops empty mcpServers, preserving foreign', () => {
    const seeded = upsertMcpServer(CLAUDE, 'json', 'wmux', '/abs/index.js');
    const removed = removeMcpServers(seeded, 'json', ['wmux']);
    const parsed = parseConfig(removed, 'json');
    expect(getMcpServerScript(parsed, 'json', 'wmux')).toBeNull();
    expect((parsed.mcpServers as Record<string, unknown>).foreign).toBeTruthy();
  });

  it('creates from empty and round-trips through 2-space JSON', () => {
    const out = upsertMcpServer('', 'json', 'wmux', '/abs/index.js');
    expect(out).toContain('  "mcpServers"');
    expect(getMcpServerScript(parseConfig(out, 'json'), 'json', 'wmux')).toBe('/abs/index.js');
  });

  it('strips __proto__ pollution on parse', () => {
    const malicious = '{"__proto__":{"polluted":true},"mcpServers":{}}';
    const parsed = parseConfig(malicious, 'json');
    expect((parsed as Record<string, unknown>).__proto__).not.toHaveProperty('polluted');
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('throws ConfigParseError on malformed JSON', () => {
    expect(() => upsertMcpServer('{ not json', 'json', 'wmux', 'x')).toThrow(ConfigParseError);
  });

  it('rejects a non-object root and an array mcpServers (parseConfig hardening)', () => {
    expect(() => parseConfig('[1,2,3]', 'json')).toThrow(ConfigParseError);
    expect(() => parseConfig('null', 'json')).toThrow(ConfigParseError);
    expect(() => parseConfig('{"mcpServers":[1,2]}', 'json')).toThrow(ConfigParseError);
  });
});

// ── read helpers ─────────────────────────────────────────────────────────────

describe('configIO — read helpers', () => {
  it('isWmuxOwnedEntry recognizes node-launched entries and rejects foreign', () => {
    expect(isWmuxOwnedEntry({ command: 'node', args: ['/x.js'] })).toBe(true);
    expect(isWmuxOwnedEntry({ command: 'python', args: ['/x.py'] })).toBe(false);
    expect(isWmuxOwnedEntry({ command: 'node', args: [] })).toBe(false);
    expect(isWmuxOwnedEntry(null)).toBe(false);
  });

  it('getMcpServerEntry returns null for absent / malformed', () => {
    expect(getMcpServerEntry({}, 'toml', 'wmux')).toBeNull();
    expect(getMcpServerEntry({ mcp_servers: { wmux: 'nope' } }, 'toml', 'wmux')).toBeNull();
  });
});
