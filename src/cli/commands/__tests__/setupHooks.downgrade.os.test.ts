// A downgrade: the last release's own CLI (scripts/fetch-last-release-cli.mjs)
// meets the native entries this build writes. It must read them as its own,
// replace them with its node form on `setup-hooks`, and remove them on
// `--remove`, leaving the user's entries. Runs only when WMUX_LAST_RELEASE_CLI
// names that CLI's index.js (the native-hooks workflow sets it); never against
// a real home: HOME is a temp directory, and PATH holds node alone, so no
// agent CLI it might probe is found.
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installHooks, type SetupHooksPaths } from '../setupHooks';
import { claudeHookCopyPath } from '../../../shared/hooks/claudeNativeHook';

const LAST_RELEASE_CLI = process.env.WMUX_LAST_RELEASE_CLI;
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');

let home = '';
let paths: SetupHooksPaths;

type Settings = { hooks?: Record<string, Array<{ matcher?: string; hooks: Array<{ command: string }> }>>; model?: string };
const settings = (): Settings => JSON.parse(fs.readFileSync(paths.settingsPath, 'utf8'));
const commands = () => Object.values(settings().hooks ?? {}).flat().flatMap((g) => g.hooks.map((h) => h.command));

/** The last release's `wmux setup-hooks <args>` in the temp home. */
function lastRelease(args: string[]): string {
  return execFileSync(process.execPath, [LAST_RELEASE_CLI as string, 'setup-hooks', ...args], {
    cwd: home,
    encoding: 'utf8',
    env: { HOME: home, USERPROFILE: home, PATH: path.dirname(process.execPath), WMUX_DATA_SUFFIX: '' },
    timeout: 60_000,
  });
}

/** This build's native entries, plus one of the user's beside them. */
function writeNative(): string {
  const copy = claudeHookCopyPath(paths.bridgeDest);
  const outcome = installHooks(paths, undefined, { binary: copy, reason: null });
  expect(outcome.ok).toBe(true);
  const raw = settings();
  raw.model = 'theirs';
  raw.hooks?.Stop.unshift({ matcher: '', hooks: [{ command: 'echo their own Stop hook' }] });
  fs.writeFileSync(paths.settingsPath, JSON.stringify(raw, null, 2));
  for (const command of commands().filter((c) => c.includes('wmux-bridge.mjs'))) expect(command.startsWith(`"${copy}" `)).toBe(true);
  return copy;
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-downgrade-'));
  fs.mkdirSync(path.join(home, '.claude'));
  paths = {
    settingsPath: path.join(home, '.claude', 'settings.json'),
    bridgeDest: path.join(home, '.wmux', 'hooks', 'wmux-bridge.mjs'),
    bridgeSource: path.join(REPO_ROOT, 'integrations', 'claude', 'bin', 'wmux-bridge.mjs'),
  };
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

describe.skipIf(!LAST_RELEASE_CLI)('the last release against native entries', () => {
  it('is the CLI it names', () => {
    // Set but missing fails here, rather than skipping the cases below.
    expect(fs.existsSync(LAST_RELEASE_CLI as string)).toBe(true);
  });

  // A release that writes the native form itself reads entries whose copy is
  // not there as outdated, each hook (Update puts them back on node), with
  // every feature on: still its own.
  it('--status reads them as its own, every hook present', () => {
    writeNative();
    const status = JSON.parse(lastRelease(['--status', '--json'])) as {
      installedEvents: string[];
      features: Record<string, { state: string }>;
      hooks?: Array<{ label: string; state: string }>;
    };
    expect(status.installedEvents).toEqual(expect.arrayContaining(['Stop', 'StopFailure', 'SubagentStop', 'SessionStart', 'SessionEnd', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PermissionRequest', 'Notification']));
    for (const [name, feature] of Object.entries(status.features)) expect(feature.state, name).toBe('ok');
    // Never missing: installedEvents above lists them, so none is foreign.
    for (const hook of status.hooks ?? []) expect(['ok', 'outdated'], hook.label).toContain(hook.state);
  });

  it('setup-hooks replaces them with its node form and keeps the user\'s entries', () => {
    const copy = writeNative();
    lastRelease([]);
    const wmux = commands().filter((c) => c.includes('wmux-bridge.mjs'));
    expect(wmux.length).toBeGreaterThan(0);
    for (const command of wmux) expect(command.startsWith('node "')).toBe(true);
    expect(commands().some((c) => c.includes(copy))).toBe(false);
    expect(commands()).toContain('echo their own Stop hook');
    expect(settings().model).toBe('theirs');
    // Still the full profile: the gate came back on node.
    expect(wmux).toContain(`node "${paths.bridgeDest}" PreToolUse --permission-gate`);
  });

  it('--remove takes them out and keeps the user\'s entries', () => {
    writeNative();
    lastRelease(['--remove']);
    expect(commands().filter((c) => c.includes('wmux-bridge.mjs'))).toEqual([]);
    expect(commands()).toEqual(['echo their own Stop hook']);
    expect(settings().model).toBe('theirs');
  });
});
