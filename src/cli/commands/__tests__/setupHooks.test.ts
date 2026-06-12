import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  installHooks,
  removeHooks,
  statusHooks,
  type SetupHooksPaths,
} from '../setupHooks';

/**
 * All tests run against an isolated temp HOME-equivalent dir via the injectable
 * SetupHooksPaths object. The real ~/.claude/settings.json is never touched.
 */

let tmpDir: string;
let settingsPath: string;
let bridgeDest: string;
let bridgeSource: string;

function paths(overrides: Partial<SetupHooksPaths> = {}): SetupHooksPaths {
  return { settingsPath, bridgeDest, bridgeSource, ...overrides };
}

function readSettings(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-setup-hooks-'));
  settingsPath = path.join(tmpDir, '.claude', 'settings.json');
  bridgeDest = path.join(tmpDir, '.wmux', 'hooks', 'wmux-bridge.mjs');
  bridgeSource = path.join(tmpDir, 'src-bridge.mjs');
  fs.writeFileSync(bridgeSource, 'BRIDGE_CONTENT_V1\n', 'utf8');
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('installHooks', () => {
  it('creates settings.json and copies the bridge on a fresh install', () => {
    expect(fs.existsSync(settingsPath)).toBe(false);
    const outcome = installHooks(paths());

    expect(outcome.ok).toBe(true);
    expect(outcome.error).toBeNull();
    expect(outcome.events.sort()).toEqual(
      ['PostToolUse', 'SessionStart', 'Stop', 'SubagentStop'],
    );
    expect(fs.existsSync(bridgeDest)).toBe(true);
    expect(fs.readFileSync(bridgeDest, 'utf8')).toBe('BRIDGE_CONTENT_V1\n');

    const s = readSettings();
    const hooks = s.hooks as Record<string, unknown[]>;
    expect(Object.keys(hooks).sort()).toEqual(
      ['PostToolUse', 'SessionStart', 'Stop', 'SubagentStop'],
    );
    // Each entry references the stable dest path, NOT the source/install dir.
    const stop = hooks.Stop[0] as { hooks: { command: string }[] };
    expect(stop.hooks[0].command).toContain(bridgeDest);
    expect(stop.hooks[0].command).toContain('Stop');
    expect(stop.hooks[0].command).not.toContain('src-bridge.mjs');
  });

  it('writes a trailing newline and 2-space pretty JSON', () => {
    installHooks(paths());
    const raw = fs.readFileSync(settingsPath, 'utf8');
    expect(raw.endsWith('\n')).toBe(true);
    expect(raw).toContain('\n  "hooks"');
  });

  it('preserves foreign hooks and other settings keys', () => {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({
        model: 'opus',
        permissions: { allow: ['Bash'] },
        hooks: {
          Stop: [
            { matcher: '', hooks: [{ type: 'command', command: 'echo foreign-stop' }] },
          ],
          PreToolUse: [
            { matcher: '', hooks: [{ type: 'command', command: 'echo foreign-pre' }] },
          ],
        },
      }),
      'utf8',
    );

    const outcome = installHooks(paths());
    expect(outcome.ok).toBe(true);

    const s = readSettings();
    expect(s.model).toBe('opus');
    expect(s.permissions).toEqual({ allow: ['Bash'] });

    const hooks = s.hooks as Record<string, unknown[]>;
    // Foreign PreToolUse untouched.
    expect(hooks.PreToolUse).toEqual([
      { matcher: '', hooks: [{ type: 'command', command: 'echo foreign-pre' }] },
    ]);
    // Stop keeps the foreign entry AND gains the wmux entry.
    const stopCmds = (hooks.Stop as { hooks: { command: string }[] }[]).map(
      (g) => g.hooks[0].command,
    );
    expect(stopCmds).toContain('echo foreign-stop');
    expect(stopCmds.some((c) => c.includes('wmux-bridge.mjs'))).toBe(true);
  });

  it('is idempotent — re-install does not duplicate wmux entries', () => {
    installHooks(paths());
    installHooks(paths());
    installHooks(paths());

    const hooks = readSettings().hooks as Record<string, unknown[]>;
    for (const event of ['Stop', 'SubagentStop', 'SessionStart', 'PostToolUse']) {
      const wmuxGroups = (hooks[event] as { hooks: { command: string }[] }[]).filter((g) =>
        g.hooks.some((h) => h.command.includes('wmux-bridge.mjs')),
      );
      expect(wmuxGroups).toHaveLength(1);
    }
  });

  it('aborts without writing when settings.json is corrupted', () => {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    const corrupt = '{ this is not json';
    fs.writeFileSync(settingsPath, corrupt, 'utf8');

    const outcome = installHooks(paths());
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toContain('not valid JSON');
    // File is left exactly as-is.
    expect(fs.readFileSync(settingsPath, 'utf8')).toBe(corrupt);
  });

  it('fails when the bridge source cannot be located', () => {
    const outcome = installHooks(paths({ bridgeSource: null }));
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toContain('Could not locate');
    expect(fs.existsSync(settingsPath)).toBe(false);
  });

  it('refreshes a stale bridge copy on re-install', () => {
    installHooks(paths());
    expect(fs.readFileSync(bridgeDest, 'utf8')).toBe('BRIDGE_CONTENT_V1\n');
    // Simulate an app update changing the bundled bridge.
    fs.writeFileSync(bridgeSource, 'BRIDGE_CONTENT_V2\n', 'utf8');
    installHooks(paths());
    expect(fs.readFileSync(bridgeDest, 'utf8')).toBe('BRIDGE_CONTENT_V2\n');
  });
});

describe('removeHooks', () => {
  it('removes only wmux entries and preserves foreign hooks', () => {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({
        model: 'opus',
        hooks: {
          Stop: [
            { matcher: '', hooks: [{ type: 'command', command: 'echo foreign-stop' }] },
          ],
        },
      }),
      'utf8',
    );
    installHooks(paths());

    const outcome = removeHooks(paths());
    expect(outcome.ok).toBe(true);
    expect(outcome.removed).toBe(4);

    const s = readSettings();
    expect(s.model).toBe('opus');
    const hooks = s.hooks as Record<string, unknown[]>;
    // Foreign Stop entry survives; wmux events with no foreign content are gone.
    expect(hooks.Stop).toEqual([
      { matcher: '', hooks: [{ type: 'command', command: 'echo foreign-stop' }] },
    ]);
    expect(hooks.SubagentStop).toBeUndefined();
    expect(hooks.PostToolUse).toBeUndefined();
  });

  it('drops the empty hooks object when nothing foreign remains', () => {
    installHooks(paths());
    removeHooks(paths());
    const s = readSettings();
    expect(s.hooks).toBeUndefined();
  });

  it('is a no-op when settings.json is absent', () => {
    const outcome = removeHooks(paths());
    expect(outcome.ok).toBe(true);
    expect(outcome.settingsExisted).toBe(false);
    expect(outcome.removed).toBe(0);
    expect(fs.existsSync(settingsPath)).toBe(false);
  });

  it('reports no removal when no wmux hooks present', () => {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify({ model: 'opus' }), 'utf8');
    const outcome = removeHooks(paths());
    expect(outcome.ok).toBe(true);
    expect(outcome.removed).toBe(0);
  });

  it('aborts on corrupted settings.json without writing', () => {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    const corrupt = 'nope';
    fs.writeFileSync(settingsPath, corrupt, 'utf8');
    const outcome = removeHooks(paths());
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toContain('not valid JSON');
    expect(fs.readFileSync(settingsPath, 'utf8')).toBe(corrupt);
  });
});

describe('statusHooks', () => {
  it('reports not-installed for a fresh environment', () => {
    const s = statusHooks(paths());
    expect(s.settingsExists).toBe(false);
    expect(s.installedEvents).toEqual([]);
    expect(s.bridgeExists).toBe(false);
    expect(s.bridgeStale).toBe(false);
    expect(s.pluginAlsoInstalled).toBe(false);
  });

  it('reports installed events and up-to-date bridge after install', () => {
    installHooks(paths());
    const s = statusHooks(paths());
    expect(s.settingsExists).toBe(true);
    expect(s.installedEvents.sort()).toEqual(
      ['PostToolUse', 'SessionStart', 'Stop', 'SubagentStop'],
    );
    expect(s.bridgeExists).toBe(true);
    expect(s.bridgeStale).toBe(false);
  });

  it('flags a stale bridge when the copy differs from source', () => {
    installHooks(paths());
    fs.writeFileSync(bridgeSource, 'BRIDGE_CONTENT_V2\n', 'utf8');
    const s = statusHooks(paths());
    expect(s.bridgeStale).toBe(true);
  });

  it('flags settings corruption', () => {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, '{bad', 'utf8');
    const s = statusHooks(paths());
    expect(s.settingsCorrupted).toBe(true);
    expect(s.installedEvents).toEqual([]);
  });

  it('detects a co-installed marketplace plugin (double-signal risk)', () => {
    installHooks(paths());
    const pluginDir = path.join(
      path.dirname(settingsPath),
      'plugins',
      'repos',
      'wmux-claude-integration',
    );
    fs.mkdirSync(pluginDir, { recursive: true });
    const s = statusHooks(paths());
    expect(s.pluginAlsoInstalled).toBe(true);
  });
});
