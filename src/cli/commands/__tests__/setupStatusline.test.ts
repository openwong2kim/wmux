import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  installStatusline,
  removeStatusline,
  refreshStatuslineScript,
  statusStatusline,
  readClaudeAccountTargets,
  classifyStatusLine,
  foreignStatusLineCommand,
  parseStatuslineArgs,
  WMUX_STATUSLINE_MARKER,
  type SetupStatuslinePaths,
} from '../setupStatusline';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-setup-statusline-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makePaths(targets: Array<{ label: string; settingsPath: string }>): SetupStatuslinePaths {
  const scriptSource = path.join(tmpDir, 'src', 'wmux-statusline.mjs');
  fs.mkdirSync(path.dirname(scriptSource), { recursive: true });
  fs.writeFileSync(scriptSource, '// statusline stub\n', 'utf8');
  return {
    targets,
    scriptDest: path.join(tmpDir, '.wmux', 'hooks', 'wmux-statusline.mjs'),
    scriptSource,
  };
}

function target(name: string): { label: string; settingsPath: string } {
  return { label: name, settingsPath: path.join(tmpDir, name, 'settings.json') };
}

function readSettings(t: { settingsPath: string }): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(t.settingsPath, 'utf8'));
}

describe('installStatusline', () => {
  it('copies the script and writes statusLine into a fresh settings.json', () => {
    const t = target('acc-a');
    const paths = makePaths([t]);
    const outcome = installStatusline(paths);
    expect(outcome.ok).toBe(true);
    expect(fs.existsSync(paths.scriptDest)).toBe(true);
    expect(outcome.targets[0].outcome).toBe('installed');
    const settings = readSettings(t);
    const sl = settings.statusLine as { type: string; command: string };
    expect(sl.type).toBe('command');
    expect(sl.command).toContain(WMUX_STATUSLINE_MARKER);
    expect(sl.command).toContain(paths.scriptDest);
  });

  it('preserves unrelated settings keys', () => {
    const t = target('acc-a');
    fs.mkdirSync(path.dirname(t.settingsPath), { recursive: true });
    fs.writeFileSync(t.settingsPath, JSON.stringify({ model: 'opus', hooks: { Stop: [] } }), 'utf8');
    installStatusline(makePaths([t]));
    const settings = readSettings(t);
    expect(settings.model).toBe('opus');
    expect(settings.hooks).toEqual({ Stop: [] });
    expect(settings.statusLine).toBeDefined();
  });

  it('never clobbers a FOREIGN statusLine', () => {
    const t = target('acc-a');
    fs.mkdirSync(path.dirname(t.settingsPath), { recursive: true });
    fs.writeFileSync(
      t.settingsPath,
      JSON.stringify({ statusLine: { type: 'command', command: 'node my-own-line.js' } }),
      'utf8',
    );
    const outcome = installStatusline(makePaths([t]));
    expect(outcome.targets[0].outcome).toBe('skipped-foreign');
    const sl = readSettings(t).statusLine as { command: string };
    expect(sl.command).toBe('node my-own-line.js');
  });

  it('replaces a FOREIGN statusLine only when force is asked for (#1102)', () => {
    const t = target('acc-a');
    fs.mkdirSync(path.dirname(t.settingsPath), { recursive: true });
    fs.writeFileSync(
      t.settingsPath,
      JSON.stringify({ model: 'opus', statusLine: { type: 'command', command: 'node my-own-line.js' } }),
      'utf8',
    );
    const outcome = installStatusline(makePaths([t]), { force: true });
    expect(outcome.targets[0].outcome).toBe('replaced');
    const settings = readSettings(t);
    expect((settings.statusLine as { command: string }).command).toContain('wmux-statusline.mjs');
    // The overwrite is scoped to statusLine — the rest of the file survives.
    expect(settings.model).toBe('opus');
  });

  it('force never touches a corrupt settings.json', () => {
    const t = target('acc-a');
    fs.mkdirSync(path.dirname(t.settingsPath), { recursive: true });
    fs.writeFileSync(t.settingsPath, '{not json', 'utf8');
    const outcome = installStatusline(makePaths([t]), { force: true });
    expect(outcome.targets[0].outcome).toBe('skipped-corrupt');
    expect(fs.readFileSync(t.settingsPath, 'utf8')).toBe('{not json');
  });

  it('handles multiple targets independently under force', () => {
    const a = target('acc-a');
    const b = target('acc-b');
    fs.mkdirSync(path.dirname(b.settingsPath), { recursive: true });
    fs.writeFileSync(
      b.settingsPath,
      JSON.stringify({ statusLine: { type: 'command', command: 'custom' } }),
      'utf8',
    );
    const outcome = installStatusline(makePaths([a, b]), { force: true });
    expect(outcome.targets.map((t) => t.outcome)).toEqual(['installed', 'replaced']);
  });

  it('refreshes an existing wmux statusLine (idempotent re-install)', () => {
    const t = target('acc-a');
    const paths = makePaths([t]);
    installStatusline(paths);
    const outcome = installStatusline(paths);
    expect(outcome.targets[0].outcome).toBe('installed');
  });

  it('skips (and does not overwrite) a corrupted settings.json', () => {
    const t = target('acc-a');
    fs.mkdirSync(path.dirname(t.settingsPath), { recursive: true });
    fs.writeFileSync(t.settingsPath, '{not json', 'utf8');
    const outcome = installStatusline(makePaths([t]));
    expect(outcome.targets[0].outcome).toBe('skipped-corrupt');
    expect(fs.readFileSync(t.settingsPath, 'utf8')).toBe('{not json');
  });

  it('fails when the bundled script cannot be located', () => {
    const paths = makePaths([target('acc-a')]);
    const outcome = installStatusline({ ...paths, scriptSource: null });
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toContain('wmux-statusline.mjs');
  });

  it('handles multiple targets independently', () => {
    const a = target('acc-a');
    const b = target('acc-b');
    fs.mkdirSync(path.dirname(b.settingsPath), { recursive: true });
    fs.writeFileSync(
      b.settingsPath,
      JSON.stringify({ statusLine: { type: 'command', command: 'custom' } }),
      'utf8',
    );
    const outcome = installStatusline(makePaths([a, b]));
    expect(outcome.targets.map((t) => t.outcome)).toEqual(['installed', 'skipped-foreign']);
  });
});

// A forced replace destroys the only copy of the user's own statusLine command.
// The ledger is what makes Replace a door you can walk back through (#1102).
describe('replaced-entry ledger', () => {
  it('restores the replaced statusLine on remove', () => {
    const t = target('acc-a');
    const paths = makePaths([t]);
    const mine = { type: 'command', command: 'node my-own-line.js', padding: 0 };
    fs.mkdirSync(path.dirname(t.settingsPath), { recursive: true });
    fs.writeFileSync(t.settingsPath, JSON.stringify({ model: 'opus', statusLine: mine }), 'utf8');

    expect(installStatusline(paths, { force: true }).targets[0].outcome).toBe('replaced');
    const removed = removeStatusline(paths);
    expect(removed.targets[0].outcome).toBe('restored');
    // Restored verbatim — including keys wmux never writes itself.
    expect(readSettings(t).statusLine).toEqual(mine);
    expect(readSettings(t).model).toBe('opus');
  });

  it('does not restore twice — the ledger entry is consumed', () => {
    const t = target('acc-a');
    const paths = makePaths([t]);
    fs.mkdirSync(path.dirname(t.settingsPath), { recursive: true });
    fs.writeFileSync(
      t.settingsPath,
      JSON.stringify({ statusLine: { type: 'command', command: 'mine' } }),
      'utf8',
    );
    installStatusline(paths, { force: true });
    removeStatusline(paths);
    // Clear the restored entry, then take the ordinary (unforced) install path:
    // the ledger has nothing left for this target, so remove leaves it empty.
    fs.writeFileSync(t.settingsPath, JSON.stringify({}), 'utf8');
    installStatusline(paths);
    expect(removeStatusline(paths).targets[0].outcome).toBe('removed');
    expect(readSettings(t).statusLine).toBeUndefined();
  });

  it('never restores over a statusLine the user has since changed by hand', () => {
    const t = target('acc-a');
    const paths = makePaths([t]);
    fs.mkdirSync(path.dirname(t.settingsPath), { recursive: true });
    fs.writeFileSync(
      t.settingsPath,
      JSON.stringify({ statusLine: { type: 'command', command: 'mine' } }),
      'utf8',
    );
    installStatusline(paths, { force: true });
    // User swaps in a third statusline after the replace.
    fs.writeFileSync(
      t.settingsPath,
      JSON.stringify({ statusLine: { type: 'command', command: 'newest' } }),
      'utf8',
    );
    expect(removeStatusline(paths).targets[0].outcome).toBe('nothing');
    expect((readSettings(t).statusLine as { command: string }).command).toBe('newest');
  });

  it('installs even when the ledger cannot be written', () => {
    const t = target('acc-a');
    const paths = makePaths([t]);
    fs.mkdirSync(path.dirname(t.settingsPath), { recursive: true });
    fs.writeFileSync(
      t.settingsPath,
      JSON.stringify({ statusLine: { type: 'command', command: 'mine' } }),
      'utf8',
    );
    // A directory where the ledger file belongs makes every write fail.
    fs.mkdirSync(path.join(path.dirname(paths.scriptDest), 'statusline-replaced.json'), {
      recursive: true,
    });
    expect(installStatusline(paths, { force: true }).targets[0].outcome).toBe('replaced');
    expect((readSettings(t).statusLine as { command: string }).command).toContain(
      WMUX_STATUSLINE_MARKER,
    );
  });
});

describe('removeStatusline', () => {
  it('removes only a wmux-owned statusLine', () => {
    const t = target('acc-a');
    const paths = makePaths([t]);
    installStatusline(paths);
    const outcome = removeStatusline(paths);
    expect(outcome.targets[0].outcome).toBe('removed');
    expect(readSettings(t).statusLine).toBeUndefined();
  });

  it('leaves a foreign statusLine untouched', () => {
    const t = target('acc-a');
    fs.mkdirSync(path.dirname(t.settingsPath), { recursive: true });
    fs.writeFileSync(
      t.settingsPath,
      JSON.stringify({ statusLine: { type: 'command', command: 'custom' } }),
      'utf8',
    );
    const outcome = removeStatusline(makePaths([t]));
    expect(outcome.targets[0].outcome).toBe('nothing');
    expect((readSettings(t).statusLine as { command: string }).command).toBe('custom');
  });

  it('reports nothing for a missing settings.json', () => {
    const outcome = removeStatusline(makePaths([target('acc-a')]));
    expect(outcome.targets[0].outcome).toBe('nothing');
  });
});

describe('refreshStatuslineScript', () => {
  /** Simulate an app update: the bundled script moved on, the installed copy didn't. */
  function bumpSource(paths: SetupStatuslinePaths): void {
    const source = paths.scriptSource;
    if (!source) throw new Error('test fixture always builds a script source');
    fs.writeFileSync(source, '// statusline stub v2\n', 'utf8');
  }

  it('replaces a stale installed script when a wmux statusLine is set', () => {
    const t = target('acc-a');
    const paths = makePaths([t]);
    installStatusline(paths);
    bumpSource(paths);
    expect(refreshStatuslineScript(paths)).toBe('refreshed');
    expect(fs.readFileSync(paths.scriptDest, 'utf8')).toBe('// statusline stub v2\n');
  });

  it('never touches settings.json — only the script file', () => {
    const t = target('acc-a');
    const paths = makePaths([t]);
    installStatusline(paths);
    const before = fs.readFileSync(t.settingsPath, 'utf8');
    bumpSource(paths);
    refreshStatuslineScript(paths);
    expect(fs.readFileSync(t.settingsPath, 'utf8')).toBe(before);
  });

  it('reports up-to-date without rewriting an identical script', () => {
    const paths = makePaths([target('acc-a')]);
    installStatusline(paths);
    const mtime = fs.statSync(paths.scriptDest).mtimeMs;
    expect(refreshStatuslineScript(paths)).toBe('up-to-date');
    expect(fs.statSync(paths.scriptDest).mtimeMs).toBe(mtime);
  });

  it('does NOT enroll a user who never installed the statusline', () => {
    const t = target('acc-a');
    const paths = makePaths([t]);
    expect(refreshStatuslineScript(paths)).toBe('not-installed');
    expect(fs.existsSync(paths.scriptDest)).toBe(false);
    expect(fs.existsSync(t.settingsPath)).toBe(false);
  });

  it('restores a referenced script that was deleted, without writing settings', () => {
    const t = target('acc-a');
    const paths = makePaths([t]);
    installStatusline(paths);
    const settingsBefore = fs.readFileSync(t.settingsPath, 'utf8');
    fs.rmSync(paths.scriptDest); // file gone, but settings still points at it
    expect(refreshStatuslineScript(paths)).toBe('refreshed');
    expect(fs.existsSync(paths.scriptDest)).toBe(true);
    expect(fs.readFileSync(t.settingsPath, 'utf8')).toBe(settingsBefore);
  });

  it('does NOT restore when no target references the script', () => {
    const t = target('acc-a');
    const paths = makePaths([t]);
    // settings.json exists but with no wmux statusLine; script absent.
    fs.mkdirSync(path.dirname(t.settingsPath), { recursive: true });
    fs.writeFileSync(t.settingsPath, JSON.stringify({ model: 'opus' }), 'utf8');
    expect(refreshStatuslineScript(paths)).toBe('not-installed');
    expect(fs.existsSync(paths.scriptDest)).toBe(false);
  });

  it('leaves the script alone when every target runs a FOREIGN statusLine', () => {
    const t = target('acc-a');
    const paths = makePaths([t]);
    // Script present (an old install), but the user has since switched to their
    // own statusLine — refreshing wmux's file would be pure surprise.
    fs.mkdirSync(path.dirname(paths.scriptDest), { recursive: true });
    fs.writeFileSync(paths.scriptDest, '// old\n', 'utf8');
    fs.mkdirSync(path.dirname(t.settingsPath), { recursive: true });
    fs.writeFileSync(
      t.settingsPath,
      JSON.stringify({ statusLine: { type: 'command', command: 'node my-own-line.js' } }),
      'utf8',
    );
    expect(refreshStatuslineScript(paths)).toBe('not-installed');
    expect(fs.readFileSync(paths.scriptDest, 'utf8')).toBe('// old\n');
  });

  it('reports no-source when the bundled script cannot be located', () => {
    const paths = makePaths([target('acc-a')]);
    installStatusline(paths);
    expect(refreshStatuslineScript({ ...paths, scriptSource: null })).toBe('no-source');
  });

  it('degrades to failed instead of throwing when the source is unreadable', () => {
    const paths = makePaths([target('acc-a')]);
    installStatusline(paths);
    expect(refreshStatuslineScript({ ...paths, scriptSource: path.join(tmpDir, 'gone.mjs') })).toBe(
      'failed',
    );
  });
});

describe('statusStatusline', () => {
  it('reports per-target states', () => {
    const a = target('acc-a');
    const b = target('acc-b');
    const c = target('acc-c');
    const paths = makePaths([a, b, c]);
    installStatusline({ ...paths, targets: [a] });
    fs.mkdirSync(path.dirname(b.settingsPath), { recursive: true });
    fs.writeFileSync(b.settingsPath, '{oops', 'utf8');
    const status = statusStatusline(paths);
    expect(status.targets.map((t) => t.state)).toEqual(['wmux', 'corrupt', 'missing']);
    expect(status.scriptExists).toBe(true);
  });
});

describe('readClaudeAccountTargets', () => {
  it('reads claude accounts from accounts.json, skipping codex and malformed rows', () => {
    const wmuxDir = path.join(tmpDir, '.wmux');
    fs.mkdirSync(wmuxDir, { recursive: true });
    fs.writeFileSync(
      path.join(wmuxDir, 'accounts.json'),
      JSON.stringify({
        version: 1,
        accounts: [
          { id: '1', name: 'work', vendor: 'claude', configDir: path.join(tmpDir, 'a') },
          { id: '2', name: 'gpt', vendor: 'codex', configDir: path.join(tmpDir, 'b') },
          { id: '3', name: 'broken', vendor: 'claude' },
        ],
        bindings: {},
      }),
      'utf8',
    );
    const targets = readClaudeAccountTargets(wmuxDir);
    expect(targets).toHaveLength(1);
    expect(targets[0].label).toBe('work');
    expect(targets[0].settingsPath).toBe(path.join(tmpDir, 'a', 'settings.json'));
  });

  it('returns empty on missing or corrupt accounts.json', () => {
    expect(readClaudeAccountTargets(path.join(tmpDir, 'nope'))).toEqual([]);
    const wmuxDir = path.join(tmpDir, '.wmux');
    fs.mkdirSync(wmuxDir, { recursive: true });
    fs.writeFileSync(path.join(wmuxDir, 'accounts.json'), 'garbage', 'utf8');
    expect(readClaudeAccountTargets(wmuxDir)).toEqual([]);
  });
});

describe('classifyStatusLine', () => {
  it('classifies none / wmux / foreign', () => {
    expect(classifyStatusLine({})).toBe('none');
    expect(classifyStatusLine({ statusLine: { type: 'command', command: `node "x/${WMUX_STATUSLINE_MARKER}"` } })).toBe('wmux');
    expect(classifyStatusLine({ statusLine: { type: 'command', command: 'other' } })).toBe('foreign');
    expect(classifyStatusLine({ statusLine: 'weird' })).toBe('foreign');
  });
});

describe('parseStatuslineArgs', () => {
  it('defaults to an unforced install', () => {
    expect(parseStatuslineArgs([])).toEqual({ action: 'install', force: false });
    expect(parseStatuslineArgs(['--force'])).toEqual({ action: 'install', force: true });
  });

  it('rejects --force on the read-only and undo actions', () => {
    expect(parseStatuslineArgs(['--force', '--remove']).action).toBe('error');
    expect(parseStatuslineArgs(['--force', '--status']).action).toBe('error');
    expect(parseStatuslineArgs(['--remove', '--status']).action).toBe('error');
  });

  it('rejects unknown flags rather than silently installing', () => {
    const parsed = parseStatuslineArgs(['--forse']);
    expect(parsed.action).toBe('error');
    expect(parsed.action === 'error' && parsed.message).toContain('--forse');
  });

  it('routes help, status, and remove', () => {
    expect(parseStatuslineArgs(['--help'])).toEqual({ action: 'help' });
    expect(parseStatuslineArgs(['--status'])).toEqual({ action: 'status' });
    expect(parseStatuslineArgs(['--remove'])).toEqual({ action: 'remove' });
  });
});

describe('foreignStatusLineCommand', () => {
  it('names the command a forced install would overwrite', () => {
    expect(foreignStatusLineCommand({ statusLine: { type: 'command', command: 'bunx ccusage' } }))
      .toBe('bunx ccusage');
  });

  it('is null for our own entry, for none, and for an unreadable shape', () => {
    expect(foreignStatusLineCommand({})).toBeNull();
    expect(foreignStatusLineCommand({ statusLine: { command: `node ${WMUX_STATUSLINE_MARKER}` } })).toBeNull();
    // Foreign but with no string command: still foreign, just nothing to show.
    expect(foreignStatusLineCommand({ statusLine: { type: 'command' } })).toBeNull();
  });

  it('rides along on the status probe so the UI can show it', () => {
    const t = target('acc-a');
    fs.mkdirSync(path.dirname(t.settingsPath), { recursive: true });
    fs.writeFileSync(
      t.settingsPath,
      JSON.stringify({ statusLine: { type: 'command', command: 'bunx ccusage' } }),
      'utf8',
    );
    const status = statusStatusline(makePaths([t]));
    expect(status.targets[0]).toMatchObject({ state: 'foreign', foreignCommand: 'bunx ccusage' });
  });
});
