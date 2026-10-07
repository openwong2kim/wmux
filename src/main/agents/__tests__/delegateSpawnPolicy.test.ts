import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

let askMode: string | undefined;
let configThrows = false;
vi.mock('../../deck/deckHqStore', () => ({
  getMoaConfig: () => {
    if (configThrows) throw new Error('torn');
    return askMode === undefined ? {} : { askMode };
  },
}));

import {
  MOA_DELEGATE_MERGE_DENY,
  WORKER_ASK_DENY_REASON,
  buildWorkerDelegateSettings,
  isMoaDelegateOn,
  spliceSettingsFlag,
  withDelegateSpawnSettings,
  writeWorkerDelegateProfile,
} from '../delegateSpawnPolicy';
import { MODEL_ENV_MARKER } from '../../../shared/workerLaunch';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-delegate-'));
  askMode = undefined;
  configThrows = false;
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const writeSwitch = (enabled: unknown): void =>
  fs.writeFileSync(path.join(dir, 'moa-ask.json'), JSON.stringify({ enabled }));

describe('isMoaDelegateOn', () => {
  it('needs the switch file AND an ask mode other than off', () => {
    askMode = 'shadow';
    expect(isMoaDelegateOn(dir)).toBe(false); // no switch file
    writeSwitch('true');
    expect(isMoaDelegateOn(dir)).toBe(false); // not a literal true
    writeSwitch(true);
    expect(isMoaDelegateOn(dir)).toBe(true);
    askMode = 'off';
    expect(isMoaDelegateOn(dir)).toBe(false);
    askMode = undefined; // absent = off
    expect(isMoaDelegateOn(dir)).toBe(false);
  });

  it('reads an unreadable config as off', () => {
    writeSwitch(true);
    configThrows = true;
    expect(isMoaDelegateOn(dir)).toBe(false);
  });
});

describe('spliceSettingsFlag', () => {
  const p = '/data/.wmux/delegate/worker-settings.json';

  it('goes right after a claude launcher, before the prompt and the worker flags', () => {
    expect(spliceSettingsFlag(`claude "$(cat '/t/prompt.md')" --permission-mode auto`, p)).toBe(
      `claude --settings="${p}" "$(cat '/t/prompt.md')" --permission-mode auto`,
    );
  });

  it('keeps the model-env marker in front', () => {
    expect(spliceSettingsFlag(`${MODEL_ENV_MARKER}claude "go"`, p)).toBe(`${MODEL_ENV_MARKER}claude --settings="${p}" "go"`);
  });

  it('leaves other launchers, a line that sets its own --settings, and an unquotable path alone', () => {
    expect(spliceSettingsFlag('codex "go"', p)).toBe('codex "go"');
    expect(spliceSettingsFlag('claude --settings=/x.json "go"', p)).toBe('claude --settings=/x.json "go"');
    expect(spliceSettingsFlag('claude --settings /x.json "go"', p)).toBe('claude --settings /x.json "go"');
    expect(spliceSettingsFlag('claude "go"', '/a"b/s.json')).toBe('claude "go"');
  });

  it('does not mistake a quoted prompt mentioning --settings for the flag', () => {
    expect(spliceSettingsFlag('claude "--settings is fine"', p)).toBe(`claude --settings="${p}" "--settings is fine"`);
  });
});

describe('withDelegateSpawnSettings', () => {
  const fanout = { initialCommand: 'claude "go"', fanoutTaskOf: 'ws-owner', cwd: '/w' };

  it('off: the same object back, and nothing is written', () => {
    const writeProfile = vi.fn();
    const out = withDelegateSpawnSettings(fanout, { dir, isOn: () => false, writeProfile });
    expect(out).toBe(fanout);
    expect(writeProfile).not.toHaveBeenCalled();
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('off for real (no switch file): byte-identical command and no files', () => {
    const out = withDelegateSpawnSettings(fanout, { dir });
    expect(out).toBe(fanout);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('only fan-out task panes are touched; the switch is not even read for the rest', () => {
    const isOn = vi.fn(() => true);
    const plain = { initialCommand: 'claude "go"' };
    expect(withDelegateSpawnSettings(plain, { dir, isOn })).toBe(plain);
    const bare = { fanoutTaskOf: 'ws-owner' };
    expect(withDelegateSpawnSettings(bare, { dir, isOn })).toBe(bare);
    expect(withDelegateSpawnSettings(undefined, { dir, isOn })).toBeUndefined();
    expect(isOn).not.toHaveBeenCalled();
  });

  it('on: the worker launch gets the spawn-own --settings', () => {
    const out = withDelegateSpawnSettings(fanout, { dir, isOn: () => true });
    const settingsPath = path.join(dir, 'delegate', 'worker-settings.json');
    expect(out).toEqual({ ...fanout, initialCommand: `claude --settings="${settingsPath}" "go"` });
    expect(fs.existsSync(settingsPath)).toBe(true);
  });

  it('on, but the profile could not be written: unchanged', () => {
    expect(withDelegateSpawnSettings(fanout, { dir, isOn: () => true, writeProfile: () => null })).toBe(fanout);
  });
});

describe('the worker profile', () => {
  it('denies AskUserQuestion and gh merges, with a hook that names moa_ask', () => {
    const settingsPath = writeWorkerDelegateProfile(dir) as string;
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as {
      permissions: { deny: string[] };
      hooks: { PreToolUse: Array<{ matcher: string; hooks: Array<{ command: string }> }> };
    };
    expect(settings.permissions.deny).toEqual(['AskUserQuestion', ...MOA_DELEGATE_MERGE_DENY]);
    expect(settings.hooks.PreToolUse).toHaveLength(1);
    expect(settings.hooks.PreToolUse[0].matcher).toBe('AskUserQuestion');
    const scriptPath = path.join(dir, 'delegate', 'worker-deny-ask.js');
    expect(settings.hooks.PreToolUse[0].hooks[0].command).toBe(`node "${scriptPath}"`);
    expect((fs.statSync(settingsPath).mode & 0o777).toString(8)).toBe('600');

    // The script blocks (exit 2) and says why, on stderr.
    const run = spawnSync(process.execPath, [scriptPath], { encoding: 'utf8', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
    expect(run.status).toBe(2);
    expect(run.stderr).toContain('mcp__wmux__moa_ask');
    expect(run.stderr.trim()).toBe(WORKER_ASK_DENY_REASON);
  });

  it('without a deny script the deny rules still hold', () => {
    expect(buildWorkerDelegateSettings({ denyScriptPath: null })).toEqual({
      permissions: { deny: ['AskUserQuestion', 'Bash(gh pr merge*)', 'Bash(gh api*merge*)'] },
    });
  });

  it('is rewritten when it drifted and left alone when it did not', () => {
    const settingsPath = writeWorkerDelegateProfile(dir) as string;
    const first = fs.statSync(settingsPath).mtimeMs;
    writeWorkerDelegateProfile(dir);
    expect(fs.statSync(settingsPath).mtimeMs).toBe(first);
    fs.writeFileSync(settingsPath, '{"permissions":{"deny":[]}}');
    writeWorkerDelegateProfile(dir);
    expect(JSON.parse(fs.readFileSync(settingsPath, 'utf8')).permissions.deny).toContain('AskUserQuestion');
  });
});
