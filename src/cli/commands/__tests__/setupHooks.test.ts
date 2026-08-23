import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  installHooks,
  removeHooks,
  refreshHookBridge,
  statusHooks,
  findBridgeSourceFrom,
  detectProfile,
  isPermissionGateInstalled,
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

/** Build a wmux-owned hook group without invoking the installer. */
function wmuxHookGroup(event: string, matcher?: string): {
  matcher?: string;
  hooks: { type: string; command: string }[];
} {
  return {
    ...(matcher === undefined ? {} : { matcher }),
    hooks: [{ type: 'command', command: `node "${bridgeDest}" ${event}` }],
  };
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
      ['PostToolUse', 'PreToolUse', 'PreToolUse', 'SessionStart', 'Stop', 'SubagentStop'],
    );
    expect(fs.existsSync(bridgeDest)).toBe(true);
    expect(fs.readFileSync(bridgeDest, 'utf8')).toBe('BRIDGE_CONTENT_V1\n');

    const s = readSettings();
    const hooks = s.hooks as Record<string, unknown[]>;
    // Event KEYS (PreToolUse carries two groups: the gate + AskUserQuestion).
    expect(Object.keys(hooks).sort()).toEqual(
      ['PostToolUse', 'PreToolUse', 'SessionStart', 'Stop', 'SubagentStop'],
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
    // Foreign PreToolUse (matcher '') is preserved AND the wmux PreToolUse
    // (matcher AskUserQuestion) is appended — both coexist on the same event.
    // Foreign + the two wmux groups (AskUserQuestion card + the wide gate).
    const pre = hooks.PreToolUse as { matcher: string; hooks: { command: string }[] }[];
    expect(pre).toHaveLength(3);
    expect(pre.some((g) => g.matcher === '' && g.hooks[0].command === 'echo foreign-pre')).toBe(true);
    expect(
      pre.some((g) => g.matcher === 'AskUserQuestion' && g.hooks[0].command.includes('wmux-bridge.mjs')),
    ).toBe(true);
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
    for (const event of ['Stop', 'SubagentStop', 'SessionStart', 'PreToolUse', 'PostToolUse']) {
      const wmuxGroups = (hooks[event] as { hooks: { command: string }[] }[]).filter((g) =>
        g.hooks.some((h) => h.command.includes('wmux-bridge.mjs')),
      );
      // PreToolUse owns two wmux groups (the AskUserQuestion approval card and
      // the wide permission gate); every other event owns exactly one.
      expect(wmuxGroups).toHaveLength(event === 'PreToolUse' ? 2 : 1);
    }
  });

  it('keeps a foreign leaf the user added inside a wmux group across a re-install', () => {
    installHooks(paths());
    // Claude Code's schema allows several command leaves under one matcher, so
    // the user hand-adds theirs to the group wmux wrote for Stop.
    const seeded = readSettings();
    const stopGroups = (seeded.hooks as Record<string, { matcher?: string; hooks: unknown[] }[]>).Stop;
    const seededMatcher = stopGroups[0].matcher;
    stopGroups[0].hooks.push({ type: 'command', command: 'echo mine' });
    fs.writeFileSync(settingsPath, JSON.stringify(seeded), 'utf8');

    installHooks(paths()); // clear-then-add — the strip runs over that group

    expect(allHookCommands()).toContain('echo mine');
    const stop = (readSettings().hooks as Record<
      string,
      { matcher?: string; hooks: { command: string }[] }[]
    >).Stop;
    // The user's leaf keeps its group (and its matcher); wmux's own hook is
    // re-added beside it, exactly once, in a group of its own.
    const mine = stop.filter((g) => g.hooks.some((h) => h.command === 'echo mine'));
    expect(mine).toHaveLength(1);
    // Asserted explicitly: the group is handed back whole, so a strip that
    // rebuilt it and dropped the matcher would otherwise pass here.
    expect(mine[0].matcher).toBe(seededMatcher);
    expect(
      stop.filter((g) => g.hooks.some((h) => h.command === `node "${bridgeDest}" Stop`)),
    ).toHaveLength(1);
    expect(stop.every((g) => g.hooks.length === 1)).toBe(true);
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
    // Push (not replace) so the wmux PreToolUse coexists with the foreign one —
    // plugin-mode stripWmuxHooks then removes all 5 wmux groups and keeps this.
    (s0.hooks as Record<string, unknown[]>).PreToolUse.push({
      matcher: '',
      hooks: [{ type: 'command', command: 'echo foreign-pre' }],
    });
    fs.writeFileSync(settingsPath, JSON.stringify(s0), 'utf8');

    // Now the marketplace plugin appears.
    writePluginManifest(
      JSON.stringify({ 'wmux-claude-integration@wmux-marketplace': { version: '1.0.0' } }),
    );

    const outcome = installHooks(paths());
    expect(outcome.ok).toBe(true);
    expect(outcome.pluginDetected).toBe(true);
    expect(outcome.removedForPlugin).toBe(6);
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
    expect(outcome.events.sort()).toEqual(['PostToolUse', 'PreToolUse', 'PreToolUse', 'SessionStart', 'Stop', 'SubagentStop']);
    const hooks = readSettings().hooks as Record<string, unknown[]>;
    expect(Object.keys(hooks).sort()).toEqual(
      ['PostToolUse', 'PreToolUse', 'SessionStart', 'Stop', 'SubagentStop'],
    );
  });

  it('treats a malformed installed_plugins.json as plugin-absent (normal install)', () => {
    writePluginManifest('{ this is not json');
    const outcome = installHooks(paths());
    expect(outcome.ok).toBe(true);
    expect(outcome.pluginDetected).toBe(false);
    expect(outcome.events.sort()).toEqual(['PostToolUse', 'PreToolUse', 'PreToolUse', 'SessionStart', 'Stop', 'SubagentStop']);
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
    expect(outcome.events.sort()).toEqual(['PostToolUse', 'PreToolUse', 'PreToolUse', 'SessionStart', 'Stop', 'SubagentStop']);
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
    expect(outcome.removed).toBe(6);

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

  it('removes only the wmux leaf from a group it shares with a foreign hook', () => {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({
        hooks: {
          PreToolUse: [
            {
              matcher: 'AskUserQuestion',
              hooks: [
                { type: 'command', command: `node "${bridgeDest}" PreToolUse` },
                { type: 'command', command: 'echo mine' },
              ],
            },
          ],
        },
      }),
      'utf8',
    );

    const outcome = removeHooks(paths());
    expect(outcome.ok).toBe(true);
    expect(outcome.removed).toBe(1);
    // The group survives, carrying the user's leaf and its matcher unchanged.
    expect((readSettings().hooks as Record<string, unknown[]>).PreToolUse).toEqual([
      { matcher: 'AskUserQuestion', hooks: [{ type: 'command', command: 'echo mine' }] },
    ]);
  });

  it('counts the wmux leaves it removes, not the groups they sat in', () => {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({
        hooks: {
          // Two wmux leaves in one group: the current install plus a stale copy
          // from an older bridge path the user merged in by hand.
          Stop: [
            {
              matcher: '',
              hooks: [
                { type: 'command', command: `node "${bridgeDest}" Stop` },
                { type: 'command', command: 'node "/old/.wmux/hooks/wmux-bridge.mjs" Stop' },
              ],
            },
          ],
        },
      }),
      'utf8',
    );

    expect(removeHooks(paths()).removed).toBe(2);
    // Nothing foreign was in that group, so it goes, and the empty map with it.
    expect(readSettings().hooks).toBeUndefined();
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
    // installedEvents is a deduped event list, so PreToolUse appears once even
    // though it carries two wmux groups.
    expect(s.installedEvents.sort()).toEqual(
      ['PostToolUse', 'PreToolUse', 'SessionStart', 'Stop', 'SubagentStop'],
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

  it('does not count unscoped approval hooks as AskUserQuestion-scoped', () => {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({
        hooks: {
          PreToolUse: [wmuxHookGroup('PreToolUse', '')],
          PostToolUse: [wmuxHookGroup('PostToolUse', '')],
        },
      }),
      'utf8',
    );

    const s = statusHooks(paths());
    expect(s.installedEvents).toEqual([]);
    expect(s.features.approvalCard.state).toBe('off');
    expect(s.features.permissionGate.state).toBe('off');
  });

  it('reports correctly scoped manual approval hooks as healthy', () => {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({
        hooks: {
          PreToolUse: [wmuxHookGroup('PreToolUse', 'AskUserQuestion')],
          PostToolUse: [wmuxHookGroup('PostToolUse', 'AskUserQuestion')],
        },
      }),
      'utf8',
    );

    const s = statusHooks(paths());
    expect(s.installedEvents.sort()).toEqual(['PostToolUse', 'PreToolUse']);
    expect(s.features.approvalCard.state).toBe('ok');
    expect(s.features.permissionGate.state).toBe('off');
  });

  it('does not let the wide permission-gate hook stand in for the approval card', () => {
    // #783 put a second spec on PreToolUse. An event-level check would report
    // the approval card healthy off the gate hook alone — the exact bug #787
    // fixed, reintroduced by the merge. Features resolve per SPEC, so the gate
    // is ok here and the card stays off.
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({
        hooks: {
          PreToolUse: [
            {
              matcher: '',
              hooks: [{ type: 'command', command: `node "${bridgeDest}" PreToolUse --permission-gate` }],
            },
          ],
          PostToolUse: [wmuxHookGroup('PostToolUse', 'AskUserQuestion')],
        },
      }),
      'utf8',
    );

    const s = statusHooks(paths());
    expect(s.features.permissionGate.state).toBe('ok');
    expect(s.features.approvalCard.state).toBe('off');
  });

  it('uses effective match-all semantics for turn-boundary hooks', () => {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({
        hooks: {
          SessionStart: [wmuxHookGroup('SessionStart')],
          Stop: [wmuxHookGroup('Stop', 'ignored-by-Claude-Code')],
          SubagentStop: [wmuxHookGroup('SubagentStop', '*')],
        },
      }),
      'utf8',
    );

    const s = statusHooks(paths());
    expect(s.features.conversationRead.state).toBe('ok');
    expect(s.features.turnEnd.state).toBe('ok');
    expect(s.features.approvalCard.state).toBe('off');
    expect(s.features.permissionGate.state).toBe('off');
  });

  it('reports an active plugin-only installation as plugin-managed', () => {
    writePluginManifest(
      JSON.stringify({ 'wmux-claude-integration@wmux-marketplace': { version: '1.0.0' } }),
    );

    const s = statusHooks(paths());
    expect(s.installedEvents).toEqual([]);
    expect(s.features.conversationRead.state).toBe('ok');
    expect(s.features.conversationRead.detail).toContain('plugin-managed');
    expect(s.features.approvalCard.state).toBe('ok');
    expect(s.features.approvalCard.detail).toContain('plugin-managed');
    expect(s.features.turnEnd.state).toBe('ok');
    expect(s.features.turnEnd.detail).toContain('plugin-managed');
    // The plugin's hooks.json ships the wide permission-gate hook too (#783).
    expect(s.features.permissionGate.state).toBe('ok');
    expect(s.features.permissionGate.detail).toContain('plugin-managed');
  });

  it('does not count an explicitly disabled plugin without manual hooks', () => {
    writePluginManifest(
      JSON.stringify({ 'wmux-claude-integration@wmux-marketplace': { version: '1.0.0' } }),
    );
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({ enabledPlugins: { 'wmux-claude-integration@wmux-marketplace': false } }),
      'utf8',
    );

    const s = statusHooks(paths());
    expect(s.installedEvents).toEqual([]);
    expect(s.features.conversationRead.state).toBe('off');
    expect(s.features.approvalCard.state).toBe('off');
    expect(s.features.turnEnd.state).toBe('off');
    expect(s.features.permissionGate.state).toBe('off');
  });

  it('reports approvalCard OFF before install and OK after (#781)', () => {
    // Fresh: no hooks → features are 'off' with a fix command on the same line.
    const before = statusHooks(paths());
    expect(before.features.approvalCard.state).toBe('off');
    expect(before.features.approvalCard.detail).toContain('wmux setup-hooks');
    expect(before.features.conversationRead.state).toBe('off');
    expect(before.features.turnEnd.state).toBe('off');
    // #783 shipped the gate as a real hook, so it reports like the others:
    // off before install, with the fix command that actually installs it.
    expect(before.features.permissionGate.state).toBe('off');
    expect(before.features.permissionGate.detail).toContain('wmux setup-hooks');

    installHooks(paths());
    const after = statusHooks(paths());
    expect(after.features.conversationRead.state).toBe('ok');
    expect(after.features.approvalCard.state).toBe('ok');
    expect(after.features.turnEnd.state).toBe('ok');
    expect(after.features.permissionGate.state).toBe('ok'); // #783 installs it
  });

  it('installs PreToolUse/PostToolUse scoped to AskUserQuestion (not matcher "")', () => {
    installHooks(paths());
    const hooks = readSettings().hooks as Record<string, { matcher: string }[]>;
    expect(hooks.PreToolUse).toBeDefined();
    expect(hooks.PostToolUse).toBeDefined();
    // The approval-card pair is scoped to AskUserQuestion so it fires once per
    // question, not on every tool call (the 2026-07-13 PostToolUse removal was
    // about a matcher:'' per-tool cost). Turn-boundary hooks stay matcher:''.
    expect(hooks.PreToolUse.some((g) => g.matcher === 'AskUserQuestion')).toBe(true);
    expect(hooks.PostToolUse.some((g) => g.matcher === 'AskUserQuestion')).toBe(true);
    expect(hooks.Stop[0].matcher).toBe('');
  });
});

describe('refreshHookBridge', () => {
  /** An install whose settings.json references the stable bridge, then a bundle
   *  that has since moved on — the exact post-app-update stale state. */
  function installThenBumpSource(): void {
    installHooks(paths());
    fs.writeFileSync(bridgeSource, 'BRIDGE_CONTENT_V2\n', 'utf8');
  }

  it('replaces a stale bridge when settings.json references it', () => {
    installThenBumpSource();
    expect(refreshHookBridge(paths())).toBe('refreshed');
    expect(fs.readFileSync(bridgeDest, 'utf8')).toBe('BRIDGE_CONTENT_V2\n');
  });

  it('never writes settings.json — only the bridge file', () => {
    installThenBumpSource();
    const before = fs.readFileSync(settingsPath, 'utf8');
    refreshHookBridge(paths());
    expect(fs.readFileSync(settingsPath, 'utf8')).toBe(before);
  });

  it('reports up-to-date without rewriting an identical bridge', () => {
    installHooks(paths());
    const mtime = fs.statSync(bridgeDest).mtimeMs;
    expect(refreshHookBridge(paths())).toBe('up-to-date');
    expect(fs.statSync(bridgeDest).mtimeMs).toBe(mtime);
  });

  it('does NOT enroll a user who never installed the hooks', () => {
    expect(refreshHookBridge(paths())).toBe('not-installed');
    expect(fs.existsSync(bridgeDest)).toBe(false);
    expect(fs.existsSync(settingsPath)).toBe(false);
  });

  it('restores a referenced bridge that was deleted, without writing settings', () => {
    installHooks(paths());
    const settingsBefore = fs.readFileSync(settingsPath, 'utf8');
    fs.rmSync(bridgeDest); // file gone, but settings hooks still reference it
    expect(refreshHookBridge(paths())).toBe('refreshed');
    expect(fs.existsSync(bridgeDest)).toBe(true);
    expect(fs.readFileSync(settingsPath, 'utf8')).toBe(settingsBefore);
  });

  it('does NOT restore when settings has no wmux hooks referencing the bridge', () => {
    // settings.json present with only foreign hooks; bridge absent.
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({ hooks: { Stop: [{ matcher: '', hooks: [{ type: 'command', command: 'node other.js' }] }] } }),
      'utf8',
    );
    expect(refreshHookBridge(paths())).toBe('not-installed');
    expect(fs.existsSync(bridgeDest)).toBe(false);
  });

  it('leaves the bridge alone when settings.json no longer references it', () => {
    // A leftover bridge file, but the user has since removed the hooks — the
    // plugin now owns the signals, and refreshing this orphan is pure surprise.
    installHooks(paths());
    removeHooks(paths());
    fs.writeFileSync(bridgeSource, 'BRIDGE_CONTENT_V2\n', 'utf8');
    expect(refreshHookBridge(paths())).toBe('not-installed');
    expect(fs.readFileSync(bridgeDest, 'utf8')).toBe('BRIDGE_CONTENT_V1\n');
  });

  it('does not resurrect a bridge for a FOREIGN-only hooks map', () => {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({ hooks: { Stop: [{ matcher: '', hooks: [{ type: 'command', command: 'node my-own.js' }] }] } }),
      'utf8',
    );
    fs.mkdirSync(path.dirname(bridgeDest), { recursive: true });
    fs.writeFileSync(bridgeDest, 'BRIDGE_CONTENT_V1\n', 'utf8');
    fs.writeFileSync(bridgeSource, 'BRIDGE_CONTENT_V2\n', 'utf8');
    expect(refreshHookBridge(paths())).toBe('not-installed');
    expect(fs.readFileSync(bridgeDest, 'utf8')).toBe('BRIDGE_CONTENT_V1\n');
  });

  it('reports no-source when the bundled bridge cannot be located', () => {
    installHooks(paths());
    expect(refreshHookBridge(paths({ bridgeSource: null }))).toBe('no-source');
  });

  it('degrades to failed instead of throwing on an unreadable source', () => {
    installHooks(paths());
    expect(refreshHookBridge(paths({ bridgeSource: path.join(tmpDir, 'gone.mjs') }))).toBe('failed');
  });

  it('does not refresh through a corrupted settings.json', () => {
    installHooks(paths());
    fs.writeFileSync(settingsPath, '{not json', 'utf8');
    fs.writeFileSync(bridgeSource, 'BRIDGE_CONTENT_V2\n', 'utf8');
    expect(refreshHookBridge(paths())).toBe('not-installed');
    expect(fs.readFileSync(bridgeDest, 'utf8')).toBe('BRIDGE_CONTENT_V1\n');
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

/**
 * #970 — the hook profile. The wide PreToolUse gate costs a node spawn on every
 * tool call (~85 ms of it before the bridge reads a byte), and both things it
 * does — resolving permission gates and feeding agent.tool_started liveness —
 * are useless without a web surface. `--signals-only` lets a terminal-only
 * operator not pay for it; the profile is DERIVED from settings.json so it
 * cannot drift, and an absent gate then reads as a configuration, not a defect.
 */
describe('hook profile (#970)', () => {
  const GATE = '--permission-gate';

  it('--signals-only installs no per-tool-call hook', () => {
    const outcome = installHooks(paths(), 'signals-only');
    expect(outcome.ok).toBe(true);
    expect(outcome.profile).toBe('signals-only');
    expect(allHookCommands().some((c) => c.includes(GATE))).toBe(false);
  });

  it('keeps the approval card and every turn-boundary signal under --signals-only', () => {
    installHooks(paths(), 'signals-only');
    const s = statusHooks(paths());
    expect(s.features.approvalCard.state).toBe('ok');
    expect(s.features.turnEnd.state).toBe('ok');
    expect(s.features.conversationRead.state).toBe('ok');
    const pre = allHookCommands().filter((c) => c.includes('PreToolUse'));
    expect(pre).toHaveLength(1);
    expect(pre[0]).not.toContain(GATE);
  });

  it('defaults a fresh install to the full profile, gate included', () => {
    const outcome = installHooks(paths());
    expect(outcome.profile).toBe('full');
    expect(allHookCommands().some((c) => c.includes(GATE))).toBe(true);
  });

  it('★ a bare re-run KEEPS signals-only — a refresh must not re-add the gate', () => {
    installHooks(paths(), 'signals-only');
    const again = installHooks(paths());
    expect(again.profile).toBe('signals-only');
    expect(allHookCommands().some((c) => c.includes(GATE))).toBe(false);
  });

  it('--with-gate is the way back from signals-only', () => {
    installHooks(paths(), 'signals-only');
    const outcome = installHooks(paths(), 'full');
    expect(outcome.profile).toBe('full');
    expect(allHookCommands().filter((c) => c.includes(GATE))).toHaveLength(1);
  });

  it('--signals-only strips a gate that is already installed', () => {
    installHooks(paths());
    expect(allHookCommands().some((c) => c.includes(GATE))).toBe(true);
    installHooks(paths(), 'signals-only');
    expect(allHookCommands().some((c) => c.includes(GATE))).toBe(false);
  });

  it('treats a PARTIAL install as broken-full and repairs it, gate included', () => {
    installHooks(paths(), 'signals-only');
    const settings = readSettings();
    delete (settings.hooks as Record<string, unknown>)['SubagentStop'];
    fs.writeFileSync(settingsPath, JSON.stringify(settings), 'utf8');
    expect(detectProfile(readSettings())).toBe('full');
    installHooks(paths());
    expect(allHookCommands().some((c) => c.includes(GATE))).toBe(true);
  });

  it('reads a settings.json with no wmux hooks as the full default', () => {
    expect(detectProfile({})).toBe('full');
    const foreign = { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'other.mjs' }] }] } };
    expect(detectProfile(foreign)).toBe('full');
  });

  it('reports signals-only as a configuration, not a missing hook', () => {
    installHooks(paths(), 'signals-only');
    const s = statusHooks(paths());
    expect(s.profile).toBe('signals-only');
    expect(s.features.permissionGate.state).toBe('off');
    expect(s.features.permissionGate.detail).toContain('signals-only');
    expect(s.features.permissionGate.detail).toContain('--with-gate');
    expect(s.features.permissionGate.detail).not.toContain('missing');
  });

  it('still reports a genuinely missing gate as something to fix', () => {
    const s = statusHooks(paths());
    expect(s.profile).toBe('full');
    expect(s.features.permissionGate.state).toBe('off');
    expect(s.features.permissionGate.detail).toContain('missing');
  });

  it('reports the full profile with the gate healthy after a default install', () => {
    installHooks(paths());
    const s = statusHooks(paths());
    expect(s.profile).toBe('full');
    expect(s.features.permissionGate.state).toBe('ok');
  });

  it('reports the full default for a corrupted settings.json', () => {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, '{ not json', 'utf8');
    const s = statusHooks(paths());
    expect(s.settingsCorrupted).toBe(true);
    expect(s.profile).toBe('full');
  });

  it('refuses --signals-only when the plugin owns the hooks, instead of faking it', () => {
    writePluginManifest(JSON.stringify({ plugins: ['wmux-claude-integration@wmux'] }));
    const outcome = installHooks(paths(), 'signals-only');
    expect(outcome.ok).toBe(true);
    expect(outcome.pluginDetected).toBe(true);
    expect(outcome.profile).toBe('full');
    expect(outcome.warning).toContain('--signals-only had no effect');
  });
});

/**
 * #970 — the guard on the silent half. `wmux web --allow-input` is the only
 * thing that arms the gate, so it is the only place that can notice the hook is
 * not installed; without this check the phone simply never rings and nothing
 * anywhere reports it.
 */
describe('isPermissionGateInstalled (#970)', () => {
  it('is false on the signals-only profile', () => {
    installHooks(paths(), 'signals-only');
    expect(isPermissionGateInstalled(settingsPath)).toBe(false);
  });

  it('is true on the full profile', () => {
    installHooks(paths());
    expect(isPermissionGateInstalled(settingsPath)).toBe(true);
  });

  it('is false before anything is installed', () => {
    expect(isPermissionGateInstalled(settingsPath)).toBe(false);
  });

  it('is true when an active marketplace plugin supplies the gate', () => {
    writePluginManifest(JSON.stringify({ plugins: ['wmux-claude-integration@wmux'] }));
    expect(isPermissionGateInstalled(settingsPath)).toBe(true);
  });

  it('is false when the plugin is installed but explicitly disabled', () => {
    writePluginManifest(JSON.stringify({ plugins: ['wmux-claude-integration@wmux'] }));
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    const disabled = { enabledPlugins: { 'wmux-claude-integration@wmux': false } };
    fs.writeFileSync(settingsPath, JSON.stringify(disabled), 'utf8');
    expect(isPermissionGateInstalled(settingsPath)).toBe(false);
  });

  it('fails CLOSED on a corrupted settings.json rather than claiming armed', () => {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, '{ not json', 'utf8');
    expect(isPermissionGateInstalled(settingsPath)).toBe(false);
  });

  it('does not count the AskUserQuestion PreToolUse as the gate', () => {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    const only = { hooks: { PreToolUse: [wmuxHookGroup('PreToolUse', 'AskUserQuestion')] } };
    fs.writeFileSync(settingsPath, JSON.stringify(only), 'utf8');
    expect(isPermissionGateInstalled(settingsPath)).toBe(false);
  });
});
