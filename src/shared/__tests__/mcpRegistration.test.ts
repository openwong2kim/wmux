import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MCP_TARGETS, getMcpTarget } from '../mcpTargets';
import {
  readTargetStatus,
  registerTarget,
  unregisterTarget,
  registerCodexNotify,
  unregisterCodexNotify,
  readCodexNotifyStatus,
  registerCodexHooks,
  unregisterCodexHooks,
  readCodexHooksStatus,
} from '../mcpRegistration';
import { upsertCodexHooksToml } from '../configIO';

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
    expect(readTargetStatus(claudeTarget, home).wmux).toEqual({ registered: true, path: WMUX_SCRIPT, profile: 'full' });
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

describe('registerTarget — launch profile', () => {
  const argsOf = (): string[] => {
    const parsed = JSON.parse(fs.readFileSync(claudeTarget.configPath(home), 'utf8')) as
      { mcpServers: Record<string, { args: string[] }> };
    return parsed.mcpServers.wmux.args;
  };

  it('registers the full surface by default', () => {
    registerTarget(claudeTarget, home, WMUX_SCRIPT);
    expect(argsOf()).toEqual([WMUX_SCRIPT]);
  });

  it('registers --core when the caller opts in', () => {
    registerTarget(claudeTarget, home, WMUX_SCRIPT, undefined, 'core');
    expect(argsOf()).toEqual([WMUX_SCRIPT, '--core']);
  });

  it('a profile-less re-register PRESERVES an opted-in --core', () => {
    registerTarget(claudeTarget, home, WMUX_SCRIPT, undefined, 'core');
    const r = registerTarget(claudeTarget, home, WMUX_SCRIPT);
    expect(r.wrote).toEqual([]); // unchanged → still idempotent
    expect(argsOf()).toEqual([WMUX_SCRIPT, '--core']);
  });

  it('a profile-less PATH refresh keeps --core while updating the script', () => {
    registerTarget(claudeTarget, home, 'C:\\old\\index.js', undefined, 'core');
    const r = registerTarget(claudeTarget, home, WMUX_SCRIPT);
    expect(r.wrote).toContain('wmux');
    expect(argsOf()).toEqual([WMUX_SCRIPT, '--core']);
  });

  it('switching profile is a WRITE even when the script path is unchanged', () => {
    // args[0] alone would call this "already up to date" and drop the change.
    registerTarget(claudeTarget, home, WMUX_SCRIPT, undefined, 'core');
    const r = registerTarget(claudeTarget, home, WMUX_SCRIPT, undefined, 'full');
    expect(r.wrote).toEqual(['wmux']);
    expect(argsOf()).toEqual([WMUX_SCRIPT]);
  });

  it('reports the profile in the register result and in readTargetStatus', () => {
    const r = registerTarget(claudeTarget, home, WMUX_SCRIPT, undefined, 'core');
    expect(r.profile).toBe('core');
    expect(readTargetStatus(claudeTarget, home).wmux.profile).toBe('core');
    // a profile-less re-register still reports what is actually on disk
    expect(registerTarget(claudeTarget, home, WMUX_SCRIPT).profile).toBe('core');
  });

  it('PRESERVES a custom argv token across a profile-less re-register, and stays idempotent', () => {
    // The whole-array comparison must not turn "an arg we do not recognize"
    // into "rewrite the entry without it" on every app boot.
    const p = claudeTarget.configPath(home);
    fs.writeFileSync(p, JSON.stringify({
      mcpServers: { wmux: { command: 'node', args: [WMUX_SCRIPT, '--core', '--verbose'] } },
    }), 'utf8');

    const first = registerTarget(claudeTarget, home, WMUX_SCRIPT);
    expect(first.wrote).toEqual([]); // nothing to change → no write at all
    expect(argsOf()).toEqual([WMUX_SCRIPT, '--core', '--verbose']);

    const second = registerTarget(claudeTarget, home, WMUX_SCRIPT);
    expect(second.wrote).toEqual([]); // and it does not oscillate
    expect(argsOf()).toEqual([WMUX_SCRIPT, '--core', '--verbose']);
  });

  it('keeps a custom argv token when a PATH refresh rewrites the entry', () => {
    const p = claudeTarget.configPath(home);
    fs.writeFileSync(p, JSON.stringify({
      mcpServers: { wmux: { command: 'node', args: ['C:\\\\old\\\\index.js', '--verbose'] } },
    }), 'utf8');
    registerTarget(claudeTarget, home, WMUX_SCRIPT);
    expect(argsOf()).toEqual([WMUX_SCRIPT, '--verbose']);
  });

  it('an explicit --profile full drops only --core, never a custom token', () => {
    const p = claudeTarget.configPath(home);
    fs.writeFileSync(p, JSON.stringify({
      mcpServers: { wmux: { command: 'node', args: [WMUX_SCRIPT, '--core', '--verbose'] } },
    }), 'utf8');
    const r = registerTarget(claudeTarget, home, WMUX_SCRIPT, undefined, 'full');
    expect(r.wrote).toEqual(['wmux']);
    expect(argsOf()).toEqual([WMUX_SCRIPT, '--verbose']);
  });
});

describe('registerTarget — launch profile on the TOML (Codex) target', () => {
  const tomlArgs = (): string[] => {
    const text = fs.readFileSync(codexTarget.configPath(home), 'utf8');
    const m = text.match(/^args = \[(.*)\]$/m);
    return m ? (JSON.parse(`[${m[1]}]`) as string[]) : [];
  };

  beforeEach(() => {
    fs.mkdirSync(path.dirname(codexTarget.configPath(home)), { recursive: true });
    fs.writeFileSync(codexTarget.configPath(home), 'model = "gpt-5.5"\n', 'utf8');
  });

  it('registers --core when the caller opts in', () => {
    registerTarget(codexTarget, home, WMUX_SCRIPT, undefined, 'core');
    expect(tomlArgs()).toEqual([WMUX_SCRIPT, '--core']);
  });

  it('a profile-less PATH refresh PRESERVES --core in the surgical TOML rewrite', () => {
    registerTarget(codexTarget, home, 'C:\\old\\index.js', undefined, 'core');
    registerTarget(codexTarget, home, WMUX_SCRIPT);
    expect(tomlArgs()).toEqual([WMUX_SCRIPT, '--core']);
    // the surrounding config is still byte-preserved
    expect(fs.readFileSync(codexTarget.configPath(home), 'utf8')).toContain('model = "gpt-5.5"');
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
    expect(readTargetStatus(codexTarget, home).wmux).toEqual({ registered: true, path: WMUX_SCRIPT, profile: 'full' });
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

describe('registerCodexNotify — resume-capture notify (skip-if-foreign)', () => {
  const NOTIFY = 'C:\\Users\\u\\.wmux\\hooks\\wmux-codex-notify.mjs';
  const writeCodex = (text: string): string => {
    const p = codexTarget.configPath(home);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, text, 'utf8');
    return p;
  };

  it('SKIPS when ~/.codex/config.toml does not exist (never created)', () => {
    const r = registerCodexNotify(home, NOTIFY);
    expect(r.skipped).toBe('absent');
    expect(r.wrote).toBe(false);
    expect(fs.existsSync(codexTarget.configPath(home))).toBe(false);
  });

  it('writes notify into an existing config, preserving foreign tables/comments', () => {
    const p = writeCodex(`# hand-written\nmodel = "gpt-5.5"\n\n[projects.'d:\\wmux']\ntrust_level = "trusted"\n`);
    const r = registerCodexNotify(home, NOTIFY);
    expect(r.skipped).toBeNull();
    expect(r.wrote).toBe(true);
    const after = fs.readFileSync(p, 'utf8');
    expect(after).toContain('# hand-written');
    expect(after).toContain(`[projects.'d:\\wmux']`);
    expect(readCodexNotifyStatus(home)).toMatchObject({ state: 'wmux', path: NOTIFY });
  });

  it('is idempotent — re-register writes nothing the second time', () => {
    writeCodex('model = "x"\n');
    registerCodexNotify(home, NOTIFY);
    const r2 = registerCodexNotify(home, NOTIFY);
    expect(r2.wrote).toBe(false);
    expect(r2.skipped).toBeNull();
  });

  it('updates a stale path written by a prior session', () => {
    writeCodex('model = "x"\n');
    registerCodexNotify(home, 'C:\\old\\wmux-codex-notify.mjs');
    const r = registerCodexNotify(home, NOTIFY);
    expect(r.wrote).toBe(true);
    expect(readCodexNotifyStatus(home).path).toBe(NOTIFY);
  });

  it('SKIPS a foreign notify — never clobbers the user’s program', () => {
    const p = writeCodex('model = "x"\nnotify = ["notify-send", "Codex"]\n');
    const r = registerCodexNotify(home, NOTIFY);
    expect(r.skipped).toBe('foreign');
    expect(r.wrote).toBe(false);
    expect(fs.readFileSync(p, 'utf8')).toContain('notify-send'); // untouched
    expect(readCodexNotifyStatus(home).state).toBe('foreign');
  });

  it('leaves a malformed config.toml untouched (never clobbers)', () => {
    const p = writeCodex('this = = broken [[');
    const r = registerCodexNotify(home, NOTIFY);
    expect(r.skipped).toBe('malformed');
    expect(fs.readFileSync(p, 'utf8')).toBe('this = = broken [[');
  });

  it('unregisterCodexNotify removes ours, reports removed', () => {
    writeCodex('model = "x"\n');
    registerCodexNotify(home, NOTIFY);
    const r = unregisterCodexNotify(home);
    expect(r.removed).toBe(true);
    expect(readCodexNotifyStatus(home).state).toBe('none');
  });

  it('readCodexNotifyStatus reports none when no notify / config absent', () => {
    expect(readCodexNotifyStatus(home).state).toBe('none');
    writeCodex('model = "x"\n');
    expect(readCodexNotifyStatus(home).state).toBe('none');
  });

  // Regression: a non-array `notify` (e.g. a bare string) used to slip past the
  // foreign guard (getNotify returned null for non-arrays) and be OVERWRITTEN.
  // inspectNotifySlot now treats any present, non-string-array slot as a conflict.
  it('NEVER clobbers a non-array (string) notify — reports foreign, untouched', () => {
    const original = 'model = "x"\nnotify = "some-program"\n';
    const p = writeCodex(original);
    const r = registerCodexNotify(home, NOTIFY);
    expect(r.skipped).toBe('foreign');
    expect(r.wrote).toBe(false);
    expect(fs.readFileSync(p, 'utf8')).toBe(original); // byte-stable
    expect(readCodexNotifyStatus(home).state).toBe('foreign');
  });

  it('NEVER clobbers a notify array containing non-string elements', () => {
    const original = 'model = "x"\nnotify = ["node", 123]\n';
    const p = writeCodex(original);
    const r = registerCodexNotify(home, NOTIFY);
    expect(r.skipped).toBe('foreign');
    expect(r.wrote).toBe(false);
    expect(fs.readFileSync(p, 'utf8')).toBe(original);
  });

  it('claims an explicit empty notify array (a no-op slot)', () => {
    writeCodex('model = "x"\nnotify = []\n');
    const r = registerCodexNotify(home, NOTIFY);
    expect(r.skipped).toBeNull();
    expect(r.wrote).toBe(true);
    expect(readCodexNotifyStatus(home).state).toBe('wmux');
  });

  it('readCodexNotifyStatus reports malformed (not none) when config exists but is unparseable', () => {
    writeCodex('this = = broken [[');
    expect(readCodexNotifyStatus(home).state).toBe('malformed');
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

// ── Codex [[hooks.*]] lifecycle bridge — approve-then-verify lane (#1107) ─────
//
// The contract under test is the honesty one: writing the block is NEVER
// "installed", because Codex silently refuses to run an untrusted hook. The
// install stamp (`codex-hooks-install.json`) + the bridge log
// (`codex-hooks.log`) are what turn 'written' into 'active'.

describe('registerCodexHooks — the hooks lane (#1107)', () => {
  const BRIDGE = '/home/u/.wmux/hooks/wmux-codex-hooks-bridge.mjs';
  const VERSION_OK = 'codex-cli 0.151.0';
  let wmuxHome = '';
  let prevUserProfile: string | undefined;

  const writeCodex = (text: string): string => {
    const p = codexTarget.configPath(home);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, text, 'utf8');
    return p;
  };
  const stamp = (): string => (
    JSON.parse(fs.readFileSync(path.join(wmuxHome, 'codex-hooks-install.json'), 'utf8')) as { installedAt: string }
  ).installedAt;
  const logFiring = (iso: string): void => {
    fs.mkdirSync(wmuxHome, { recursive: true });
    fs.appendFileSync(path.join(wmuxHome, 'codex-hooks.log'), `${JSON.stringify({ ts: iso, outcome: 'ok' })}\n`);
  };

  beforeEach(() => {
    // Route getWmuxHomeDir() (USERPROFILE-first) at the temp home so the
    // stamp/log never touch the real ~/.wmux.
    prevUserProfile = process.env.USERPROFILE;
    process.env.USERPROFILE = home;
    wmuxHome = path.join(home, '.wmux');
  });
  afterEach(() => {
    if (prevUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = prevUserProfile;
  });

  it('SKIPS when ~/.codex/config.toml does not exist (never created)', () => {
    const r = registerCodexHooks(home, BRIDGE, VERSION_OK);
    expect(r.skipped).toBe('absent');
    expect(fs.existsSync(codexTarget.configPath(home))).toBe(false);
  });

  it('refuses when the version could not be probed (fail closed)', () => {
    writeCodex('model = "x"\n');
    const r = registerCodexHooks(home, BRIDGE, null);
    expect(r.skipped).toBe('version-unknown');
    expect(fs.readFileSync(codexTarget.configPath(home), 'utf8')).toBe('model = "x"\n');
  });

  it('refuses codex-cli below the bisected 0.141.0 floor and writes nothing', () => {
    // 0.140.0 parses the block, advertises `hooks stable true`, fires nothing.
    writeCodex('model = "x"\n');
    const r = registerCodexHooks(home, BRIDGE, 'codex-cli 0.140.0');
    expect(r.skipped).toBe('unsupported-version');
    expect(fs.readFileSync(codexTarget.configPath(home), 'utf8')).toBe('model = "x"\n');
  });

  it('writes the marker-bracketed block and stamps the install time', () => {
    const p = writeCodex('# hand-written\nmodel = "x"\n');
    const r = registerCodexHooks(home, BRIDGE, VERSION_OK);
    expect(r.skipped).toBeNull();
    expect(r.wrote).toBe(true);
    const after = fs.readFileSync(p, 'utf8');
    expect(after).toContain('# hand-written');
    expect(after).toContain('[[hooks.Stop]]');
    expect(stamp()).toBeTruthy();
  });

  it('is idempotent — and a re-run does NOT move the stamp past firing evidence', () => {
    writeCodex('model = "x"\n');
    registerCodexHooks(home, BRIDGE, VERSION_OK);
    const stampAtInstall = stamp();
    // The operator approves; the bridge fires AFTER the stamp.
    logFiring('2999-01-01T00:00:00.000Z');
    const r2 = registerCodexHooks(home, BRIDGE, VERSION_OK);
    expect(r2.wrote).toBe(false);
    expect(stamp()).toBe(stampAtInstall);
    expect(readCodexHooksStatus(home, BRIDGE).state).toBe('active');
  });

  it('preserves Codex trust annotations inside the region on an idempotent re-run', () => {
    writeCodex('model = "x"\n');
    registerCodexHooks(home, BRIDGE, VERSION_OK);
    const p = codexTarget.configPath(home);
    // Codex marks the hook trusted in place.
    const annotated = fs.readFileSync(p, 'utf8').replace('async = false', 'async = false\nenabled = true\ntrusted_hash = "abc"');
    fs.writeFileSync(p, annotated, 'utf8');
    const r2 = registerCodexHooks(home, BRIDGE, VERSION_OK);
    expect(r2.wrote).toBe(false); // structurally current → no rewrite
    expect(fs.readFileSync(p, 'utf8')).toContain('trusted_hash = "abc"');
  });

  it('refreshes when the bridge path changed (annotation loss is honest — re-approval)', () => {
    writeCodex('model = "x"\n');
    registerCodexHooks(home, BRIDGE, VERSION_OK);
    const moved = BRIDGE.replace('wmux-codex-hooks-bridge', 'moved');
    const r2 = registerCodexHooks(home, moved, VERSION_OK);
    expect(r2.wrote).toBe(true);
    expect(readCodexHooksStatus(home, moved).path).toBe(moved);
  });

  it('SKIPS a foreign [[hooks]] table — never sits beside the user’s own hooks', () => {
    const p = writeCodex('[[hooks.Stop]]\nmatcher = "*"\ncommand = "user-own"\n');
    const r = registerCodexHooks(home, BRIDGE, VERSION_OK);
    expect(r.skipped).toBe('foreign');
    expect(fs.readFileSync(p, 'utf8')).toBe('[[hooks.Stop]]\nmatcher = "*"\ncommand = "user-own"\n');
    expect(readCodexHooksStatus(home, BRIDGE).state).toBe('foreign');
  });

  it('SKIPS a hand-pasted marker block with no end marker (manual)', () => {
    writeCodex('model = "x"\n# wmux-managed: codex-hooks-bridge\n[[hooks.Stop]]\nmatcher = "*"\n');
    const r = registerCodexHooks(home, BRIDGE, VERSION_OK);
    expect(r.skipped).toBe('manual');
  });

  it('leaves a malformed config.toml untouched', () => {
    const p = writeCodex('this = = broken [[');
    const r = registerCodexHooks(home, BRIDGE, VERSION_OK);
    expect(r.skipped).toBe('malformed');
    expect(fs.readFileSync(p, 'utf8')).toBe('this = = broken [[');
  });

  it('status: WRITTEN, not active, until the bridge fires after the stamp', () => {
    writeCodex('model = "x"\n');
    registerCodexHooks(home, BRIDGE, VERSION_OK);
    // No firing at all → written.
    expect(readCodexHooksStatus(home, BRIDGE).state).toBe('written');
    // Firing BEFORE the install stamp (a log left over from an older block)
    // still does not count — evidence must postdate the write.
    logFiring('2000-01-01T00:00:00.000Z');
    expect(readCodexHooksStatus(home, BRIDGE).state).toBe('written');
    // Post-stamp firing flips it.
    logFiring(new Date(Date.now() + 1000).toISOString());
    const status = readCodexHooksStatus(home, BRIDGE);
    expect(status.state).toBe('active');
    expect(status.lastFiredAt).toBeTruthy();
  });

  it('status: a manual block with no stamp is active on ANY firing (honest floor)', () => {
    // The manual flow (README) writes the block without an install stamp;
    // any firing at all proves the operator approved it.
    const block = upsertCodexHooksToml('model = "x"\n', BRIDGE).replace('model = "x"\n', '');
    writeCodex(`model = "x"\n${block}`);
    expect(readCodexHooksStatus(home, BRIDGE).state).toBe('written');
    logFiring('2000-01-01T00:00:00.000Z');
    expect(readCodexHooksStatus(home, BRIDGE).state).toBe('active');
  });

  it('status: stale when the block names a different bridge path', () => {
    writeCodex('model = "x"\n');
    registerCodexHooks(home, BRIDGE, VERSION_OK);
    expect(readCodexHooksStatus(home, '/elsewhere/bridge.mjs').state).toBe('stale');
  });

  it('status: none when config absent; malformed config → malformed', () => {
    expect(readCodexHooksStatus(home, BRIDGE).state).toBe('none');
    writeCodex('broken = = [[');
    expect(readCodexHooksStatus(home, BRIDGE).state).toBe('malformed');
  });

  it('unregisterCodexHooks removes our block, leaves foreign hooks alone', () => {
    writeCodex('model = "x"\n');
    registerCodexHooks(home, BRIDGE, VERSION_OK);
    const r = unregisterCodexHooks(home);
    expect(r.removed).toBe(true);
    expect(readCodexHooksStatus(home, BRIDGE).state).toBe('none');
    expect(fs.readFileSync(codexTarget.configPath(home), 'utf8')).toBe('model = "x"\n');

    const foreign = '[[hooks.Stop]]\nmatcher = "*"\ncommand = "user-own"\n';
    writeCodex(foreign);
    expect(unregisterCodexHooks(home).removed).toBe(false);
    expect(fs.readFileSync(codexTarget.configPath(home), 'utf8')).toBe(foreign);
  });
});
