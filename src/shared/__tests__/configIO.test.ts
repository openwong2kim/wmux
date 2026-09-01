import { describe, it, expect } from 'vitest';
import {
  parseConfig,
  getMcpServerScript,
  getMcpServerEntry,
  isWmuxOwnedEntry,
  upsertMcpServer,
  removeMcpServers,
  ConfigParseError,
  getNotify,
  isWmuxOwnedNotify,
  upsertNotifyToml,
  removeNotifyToml,
  wmuxMcpEntry,
  wmuxEntryArgs,
  entryProfileFlags,
  DEFAULT_HOST_PROFILE,
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

  it('removes multiple named blocks, leaving foreign tables intact', () => {
    const seeded = upsertMcpServer(
      upsertMcpServer(CODEX_CONFIG, 'toml', 'wmux', 'C:\\w\\i.js'),
      'toml',
      'wmux-extra',
      'C:\\w\\a.js',
    );
    const removed = removeMcpServers(seeded, 'toml', ['wmux', 'wmux-extra']);
    const parsed = parseConfig(removed, 'toml');
    expect(getMcpServerScript(parsed, 'toml', 'wmux')).toBeNull();
    expect(getMcpServerScript(parsed, 'toml', 'wmux-extra')).toBeNull();
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

  it('handles a quoted/dashed key (wmux-extra) and an empty file', () => {
    const out = upsertMcpServer('', 'toml', 'wmux-extra', 'C:\\w\\a.js');
    expect(out).toContain('[mcp_servers.wmux-extra]');
    expect(getMcpServerScript(parseConfig(out, 'toml'), 'toml', 'wmux-extra')).toBe('C:\\w\\a.js');
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

// ── Codex notify (root-level array) ──────────────────────────────────────────

describe('configIO — codex notify', () => {
  const SCRIPT = 'C:\\Users\\u\\.wmux\\hooks\\wmux-codex-notify.mjs';

  it('isWmuxOwnedNotify recognizes ours (node + our basename), rejects foreign', () => {
    expect(isWmuxOwnedNotify(['node', SCRIPT])).toBe(true);
    expect(isWmuxOwnedNotify(['node', '/home/u/.wmux/hooks/wmux-codex-notify.mjs'])).toBe(true);
    expect(isWmuxOwnedNotify(['notify-send', 'Codex'])).toBe(false);
    expect(isWmuxOwnedNotify(['node', '/some/other-script.mjs'])).toBe(false);
    expect(isWmuxOwnedNotify(['node'])).toBe(false);
    expect(isWmuxOwnedNotify(null)).toBe(false);
  });

  it('getNotify reads the root array; null when absent / non-array', () => {
    expect(getNotify(parseConfig('notify = ["a", "b"]\n', 'toml'))).toEqual(['a', 'b']);
    expect(getNotify(parseConfig('model = "x"\n', 'toml'))).toBeNull();
  });

  it('inserts notify as a root key BEFORE the first table (valid TOML)', () => {
    const input = `model = "gpt-5.5"\n[projects.'d:\\wmux']\ntrust_level = "trusted"\n`;
    const out = upsertNotifyToml(input, SCRIPT);
    // Re-parse: notify must be a ROOT key, and the project table must survive.
    const parsed = parseConfig(out, 'toml');
    expect(isWmuxOwnedNotify(getNotify(parsed))).toBe(true);
    expect((parsed['projects'] as Record<string, unknown>)['d:\\wmux']).toEqual({ trust_level: 'trusted' });
    // notify line sits before the table header in the text.
    expect(out.indexOf('notify =')).toBeLessThan(out.indexOf('[projects'));
  });

  it('replaces an existing wmux notify in place (idempotent path preserved order)', () => {
    const input = `model = "x"\nnotify = ["node", "OLD.mjs"]\n[t]\nk = 1\n`;
    const out = upsertNotifyToml(input, SCRIPT);
    expect(getNotify(parseConfig(out, 'toml'))![1]).toBe(SCRIPT);
    expect(out.split('notify =').length).toBe(2); // exactly one notify line
  });

  it('appends notify when there are no tables', () => {
    const out = upsertNotifyToml('model = "x"\n', SCRIPT);
    expect(isWmuxOwnedNotify(getNotify(parseConfig(out, 'toml')))).toBe(true);
  });

  it('preserves Windows literal-key project tables (no backslash corruption)', () => {
    const input = `[projects.'d:\\wmux']\ntrust_level = "trusted"\n`;
    const out = upsertNotifyToml(input, SCRIPT);
    expect(out).toContain(`[projects.'d:\\wmux']`);
    expect(parseConfig(out, 'toml')['projects']).toBeDefined();
  });

  it('removeNotifyToml removes ours, leaves a foreign notify untouched', () => {
    const ours = `notify = ["node", ${JSON.stringify(SCRIPT)}]\n[t]\nk = 1\n`;
    expect(getNotify(parseConfig(removeNotifyToml(ours), 'toml'))).toBeNull();
    const foreign = `notify = ["notify-send", "Codex"]\n`;
    expect(removeNotifyToml(foreign)).toBe(foreign); // untouched
  });

  it('throws on malformed TOML rather than appending to garbage', () => {
    expect(() => upsertNotifyToml('this is = = not toml [[', SCRIPT)).toThrow(ConfigParseError);
  });
});

// ── wmuxMcpEntry launch profile ─────────────────────────────────────────────

describe('wmuxMcpEntry', () => {
  it('omits the profile flag by default and appends --core only when asked', () => {
    // The default must stay byte-identical to the pre-profile entry: every
    // existing caller passes one argument and must keep the full surface.
    expect(wmuxMcpEntry('/opt/wmux/mcp.js')).toEqual({
      command: 'node',
      args: ['/opt/wmux/mcp.js'],
    });
    expect(wmuxMcpEntry('/opt/wmux/mcp.js', 'full')).toEqual({
      command: 'node',
      args: ['/opt/wmux/mcp.js'],
    });
    expect(wmuxMcpEntry('/opt/wmux/mcp.js', 'core')).toEqual({
      command: 'node',
      args: ['/opt/wmux/mcp.js', '--core'],
    });
  });

  it('defaults to the one profile constant every writer resolves through', () => {
    // Pin the product default so flipping it is a deliberate one-line change
    // that shows up here, not something a caller can drift into.
    expect(DEFAULT_HOST_PROFILE).toBe('full');
    expect(wmuxMcpEntry('/x.js').args).toEqual(wmuxMcpEntry('/x.js', DEFAULT_HOST_PROFILE).args);
  });
});

// ── Profile threading + preservation ────────────────────────────────────────

describe('wmuxEntryArgs / entryProfileFlags', () => {
  it('reads the profile flags back off an existing entry', () => {
    expect(entryProfileFlags(null)).toEqual([]);
    expect(entryProfileFlags({ command: 'node', args: ['/x.js'] })).toEqual([]);
    expect(entryProfileFlags({ command: 'node', args: ['/x.js', '--core'] })).toEqual(['--core']);
    expect(entryProfileFlags({ command: 'node', args: ['/x.js', '--commander'] })).toEqual(['--commander']);
    // A non-profile argv token is not mistaken for one.
    expect(entryProfileFlags({ command: 'node', args: ['/x.js', '--verbose'] })).toEqual([]);
  });

  it('an explicit profile wins; omitting one preserves the existing entry', () => {
    const core = { command: 'node', args: ['/old.js', '--core'] };
    // explicit core / full
    expect(wmuxEntryArgs('/x.js', 'core')).toEqual(['/x.js', '--core']);
    expect(wmuxEntryArgs('/x.js', 'full')).toEqual(['/x.js']);
    // explicit full walks a core entry back — the opt-in must be reversible
    expect(wmuxEntryArgs('/x.js', 'full', core)).toEqual(['/x.js']);
    // no opinion + existing core → preserved (this is the overwrite bug)
    expect(wmuxEntryArgs('/x.js', undefined, core)).toEqual(['/x.js', '--core']);
    // no opinion + no existing entry → the default
    expect(wmuxEntryArgs('/x.js', undefined, null)).toEqual(['/x.js']);
  });
});

describe('upsertMcpServer — launch profile', () => {
  it('writes the default (full) entry when no profile is given', () => {
    const json = JSON.parse(upsertMcpServer('', 'json', 'wmux', '/abs/index.js')) as
      { mcpServers: Record<string, { args: string[] }> };
    expect(json.mcpServers.wmux.args).toEqual(['/abs/index.js']);
    expect(upsertMcpServer('', 'toml', 'wmux', '/abs/index.js')).toContain('args = ["/abs/index.js"]');
  });

  it('writes --core when the caller opts in (json + toml)', () => {
    const json = JSON.parse(upsertMcpServer('', 'json', 'wmux', '/abs/index.js', 'core')) as
      { mcpServers: Record<string, { command: string; args: string[] }> };
    expect(json.mcpServers.wmux).toEqual({ command: 'node', args: ['/abs/index.js', '--core'] });
    expect(upsertMcpServer('', 'toml', 'wmux', '/abs/index.js', 'core'))
      .toContain('args = ["/abs/index.js", "--core"]');
  });

  it('PRESERVES a hand-edited --core across a profile-less rewrite (json)', () => {
    // The regression this locks: an automatic re-registration (new bundle path
    // on upgrade) used to rewrite the entry as `full`, silently undoing the
    // user's opt-in on the next app launch.
    const seeded = upsertMcpServer('', 'json', 'wmux', '/old/index.js', 'core');
    const refreshed = JSON.parse(upsertMcpServer(seeded, 'json', 'wmux', '/new/index.js')) as
      { mcpServers: Record<string, { args: string[] }> };
    expect(refreshed.mcpServers.wmux.args).toEqual(['/new/index.js', '--core']);
  });

  it('PRESERVES a hand-edited --core across a profile-less rewrite (toml)', () => {
    const seeded = upsertMcpServer(CODEX_CONFIG, 'toml', 'wmux', '/old/index.js', 'core');
    expect(seeded).toContain('"--core"');
    const refreshed = upsertMcpServer(seeded, 'toml', 'wmux', '/new/index.js');
    expect(refreshed).toContain('args = ["/new/index.js", "--core"]');
    // and the surgical-write guarantee still holds
    expect(refreshed).toContain("[projects.'d:\\wmux']");
  });

  it('PRESERVES --commander, which no host writer ever emits itself', () => {
    const seeded = JSON.stringify({
      mcpServers: { wmux: { command: 'node', args: ['/old.js', '--commander'] } },
    });
    const refreshed = JSON.parse(upsertMcpServer(seeded, 'json', 'wmux', '/new.js')) as
      { mcpServers: Record<string, { args: string[] }> };
    expect(refreshed.mcpServers.wmux.args).toEqual(['/new.js', '--commander']);
  });

  it('an explicit full profile walks a --core entry back', () => {
    const seeded = upsertMcpServer('', 'json', 'wmux', '/x.js', 'core');
    const back = JSON.parse(upsertMcpServer(seeded, 'json', 'wmux', '/x.js', 'full')) as
      { mcpServers: Record<string, { args: string[] }> };
    expect(back.mcpServers.wmux.args).toEqual(['/x.js']);
  });
});
