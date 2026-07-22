import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  installHooks,
  removeHooks,
  statusHooks,
  findBridgeSourceFrom,
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

/** Write Claude Code's installed-plugins manifest next to settings.json. */
function writePluginManifest(raw: string): void {
  const manifestPath = path.join(path.dirname(settingsPath), 'plugins', 'installed_plugins.json');
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.writeFileSync(manifestPath, raw, 'utf8');
}

/** Flatten every hook command string across all events in settings.json. */
function allHookCommands(): string[] {
  const hooks = (readSettings().hooks ?? {}) as Record<string, unknown[]>;
  return Object.values(hooks).flatMap((groups) =>
    (groups as { hooks: { command: string }[] }[]).flatMap((g) =>
      g.hooks.map((h) => h.command),
    ),
  );
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
      ['SessionStart', 'Stop', 'SubagentStop'],
    );
    expect(fs.existsSync(bridgeDest)).toBe(true);
    expect(fs.readFileSync(bridgeDest, 'utf8')).toBe('BRIDGE_CONTENT_V1\n');

    const s = readSettings();
    const hooks = s.hooks as Record<string, unknown[]>;
    expect(Object.keys(hooks).sort()).toEqual(
      ['SessionStart', 'Stop', 'SubagentStop'],
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
    for (const event of ['Stop', 'SubagentStop', 'SessionStart']) {
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

describe('installHooks — plugin-aware', () => {
  it('strips duplicate wmux entries, does not re-add, and preserves foreign hooks', () => {
    // Seed a prior plugin-LESS install so settings.json carries wmux entries.
    installHooks(paths());
    // Add foreign hooks alongside the wmux ones.
    const s0 = readSettings();
    (s0.hooks as Record<string, unknown[]>).Stop.push({
      matcher: '',
      hooks: [{ type: 'command', command: 'echo foreign-stop' }],
    });
    (s0.hooks as Record<string, unknown[]>).PreToolUse = [
      { matcher: '', hooks: [{ type: 'command', command: 'echo foreign-pre' }] },
    ];
    fs.writeFileSync(settingsPath, JSON.stringify(s0), 'utf8');

    // Now the marketplace plugin appears.
    writePluginManifest(
      JSON.stringify({ 'wmux-claude-integration@wmux-marketplace': { version: '1.0.0' } }),
    );

    const outcome = installHooks(paths());
    expect(outcome.ok).toBe(true);
    expect(outcome.pluginDetected).toBe(true);
    expect(outcome.removedForPlugin).toBe(3);
    expect(outcome.events).toEqual([]);

    // No wmux command remains; both foreign hooks are preserved.
    expect(allHookCommands().some((c) => c.includes('wmux-bridge.mjs'))).toBe(false);
    expect(allHookCommands()).toContain('echo foreign-stop');
    expect(allHookCommands()).toContain('echo foreign-pre');

    // Idempotent: a second plugin-mode run removes nothing and never re-adds.
    const again = installHooks(paths());
    expect(again.pluginDetected).toBe(true);
    expect(again.removedForPlugin).toBe(0);
    expect(allHookCommands().some((c) => c.includes('wmux-bridge.mjs'))).toBe(false);
  });

  it('installs normally when the manifest exists but lacks the wmux plugin key', () => {
    writePluginManifest(JSON.stringify({ 'some-other-plugin@market': {} }));
    const outcome = installHooks(paths());
    expect(outcome.ok).toBe(true);
    expect(outcome.pluginDetected).toBe(false);
    expect(outcome.events.sort()).toEqual(['SessionStart', 'Stop', 'SubagentStop']);
    const hooks = readSettings().hooks as Record<string, unknown[]>;
    expect(Object.keys(hooks).sort()).toEqual(['SessionStart', 'Stop', 'SubagentStop']);
  });

  it('treats a malformed installed_plugins.json as plugin-absent (normal install)', () => {
    writePluginManifest('{ this is not json');
    const outcome = installHooks(paths());
    expect(outcome.ok).toBe(true);
    expect(outcome.pluginDetected).toBe(false);
    expect(outcome.events.sort()).toEqual(['SessionStart', 'Stop', 'SubagentStop']);
    expect(allHookCommands().some((c) => c.includes('wmux-bridge.mjs'))).toBe(true);
  });

  it('detects the plugin when referenced as an array value, not just a key', () => {
    writePluginManifest(JSON.stringify({ 'wmux-marketplace': ['wmux-claude-integration'] }));
    const outcome = installHooks(paths());
    expect(outcome.pluginDetected).toBe(true);
    expect(outcome.events).toEqual([]);
  });

  // Codex review: installed_plugins.json keeps listing a plugin the user
  // disabled via settings `enabledPlugins` — its hooks.json is NOT loaded, so
  // the settings.json entries are the only live installation and must not be
  // stripped (that would leave zero wmux hooks).
  it('installs normally when the plugin is installed but explicitly disabled', () => {
    writePluginManifest(
      JSON.stringify({ 'wmux-claude-integration@wmux-marketplace': { version: '1.0.0' } }),
    );
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({ enabledPlugins: { 'wmux-claude-integration@wmux-marketplace': false } }),
      'utf8',
    );

    const outcome = installHooks(paths());
    expect(outcome.ok).toBe(true);
    expect(outcome.pluginDetected).toBe(false);
    expect(outcome.events.sort()).toEqual(['SessionStart', 'Stop', 'SubagentStop']);
    expect(allHookCommands().some((c) => c.includes('wmux-bridge.mjs'))).toBe(true);
    // The user's enabledPlugins map is preserved untouched.
    expect((readSettings().enabledPlugins as Record<string, unknown>)[
      'wmux-claude-integration@wmux-marketplace'
    ]).toBe(false);
  });

  it('still short-circuits when enabledPlugins lists the plugin as true', () => {
    writePluginManifest(
      JSON.stringify({ 'wmux-claude-integration@wmux-marketplace': { version: '1.0.0' } }),
    );
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({ enabledPlugins: { 'wmux-claude-integration@wmux-marketplace': true } }),
      'utf8',
    );

    const outcome = installHooks(paths());
    expect(outcome.pluginDetected).toBe(true);
    expect(outcome.events).toEqual([]);
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
    expect(outcome.removed).toBe(3);

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
      ['SessionStart', 'Stop', 'SubagentStop'],
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

describe('findBridgeSourceFrom', () => {
  // 패키징 앱의 메인 프로세스 레이아웃 재현: __dirname이 app.asar/.vite/build일 때
  // walk-up으로 Resources/cli-bundle/wmux-bridge.mjs를 찾아야 한다 (인앱 "hook 설치"
  // 버튼이 이 경로로 호출됨 — cli-bundle/ 후보 누락 시 설치가 항상 실패하던 회귀 방지).
  it('resolves Resources/cli-bundle from the packaged main bundle dir', () => {
    const resources = path.join(tmpDir, 'Resources');
    const mainDir = path.join(resources, 'app.asar', '.vite', 'build');
    fs.mkdirSync(mainDir, { recursive: true });
    const bundled = path.join(resources, 'cli-bundle', 'wmux-bridge.mjs');
    fs.mkdirSync(path.dirname(bundled), { recursive: true });
    fs.writeFileSync(bundled, 'BRIDGE\n', 'utf8');
    expect(findBridgeSourceFrom(mainDir)).toBe(bundled);
  });

  it('resolves the bridge sitting next to the CLI bundle', () => {
    const cliDir = path.join(tmpDir, 'cli-bundle');
    fs.mkdirSync(cliDir, { recursive: true });
    const bundled = path.join(cliDir, 'wmux-bridge.mjs');
    fs.writeFileSync(bundled, 'BRIDGE\n', 'utf8');
    expect(findBridgeSourceFrom(cliDir)).toBe(bundled);
  });

  it('returns null when nothing is found within the walk budget', () => {
    const deep = path.join(tmpDir, 'a', 'b', 'c');
    fs.mkdirSync(deep, { recursive: true });
    expect(findBridgeSourceFrom(deep)).toBeNull();
  });
});
