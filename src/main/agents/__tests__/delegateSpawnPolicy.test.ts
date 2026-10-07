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
  MOA_DELEGATE_WORKER_ALLOW,
  MOA_DELEGATE_WORKER_ENV,
  WORKER_ASK_DENY_REASON,
  isQuotable,
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

describe('isQuotable', () => {
  it('refuses every character a POSIX, PowerShell or cmd double-quoted word would rewrite', () => {
    expect(isQuotable('/Users/me/.wmux/delegate/worker-settings.json')).toBe(true);
    expect(isQuotable('C:\\Users\\me\\.wmux\\delegate\\worker-settings.json')).toBe(true);
    for (const bad of ['/a"b', "/a'b", '/a`b', '/a$b', '/a%TEMP%/b', '/a!b', 'C:\\\\server\\share']) {
      expect(isQuotable(bad)).toBe(false);
    }
  });

  it('a refused path leaves the launch unchanged and warns once', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(spliceSettingsFlag('claude "go"', '/a%b/s.json')).toBe('claude "go"');
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
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
  it('keeps AskUserQuestion listed and refuses it in the hook, which names moa_ask', () => {
    const settingsPath = writeWorkerDelegateProfile(dir) as string;
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as {
      permissions: { allow: string[]; deny: string[] };
      env: Record<string, string>;
      hooks: { PreToolUse: Array<{ matcher: string; hooks: Array<{ command: string }> }> };
    };
    // A deny rule would drop the tool from the model's list, and the hook
    // carrying the redirect would never run.
    expect(settings.permissions.deny).toEqual([...MOA_DELEGATE_MERGE_DENY]);
    expect(settings.permissions.deny).not.toContain('AskUserQuestion');
    // moa_ask is never left to an auto-mode classifier.
    expect(settings.permissions.allow).toEqual(['mcp__wmux__moa_ask', 'mcp__wmux__moa_ask_status']);
    expect(MOA_DELEGATE_WORKER_ALLOW).toEqual(settings.permissions.allow);
    // The plugin's bridge skips its own report for the refused call.
    expect(settings.env).toEqual({ [MOA_DELEGATE_WORKER_ENV]: '1' });
    expect(settings.hooks.PreToolUse).toHaveLength(1);
    expect(settings.hooks.PreToolUse[0].matcher).toBe('AskUserQuestion');
    const scriptPath = path.join(dir, 'delegate', 'worker-deny-ask.js');
    expect(settings.hooks.PreToolUse[0].hooks[0].command).toBe(`node "${scriptPath}"`);
    // POSIX modes only: Windows reports 0666 for any writable file.
    if (process.platform !== 'win32') expect((fs.statSync(settingsPath).mode & 0o777).toString(8)).toBe('600');

    // The script blocks (exit 2) and says why, on stderr: ask moa_ask, poll
    // moa_ask_status, and on an escalation end the turn without restating it.
    const run = spawnSync(process.execPath, [scriptPath], { encoding: 'utf8', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
    expect(run.status).toBe(2);
    expect(run.stderr).toContain('mcp__wmux__moa_ask ');
    expect(run.stderr).toContain('mcp__wmux__moa_ask_status');
    expect(run.stderr).toContain('without restating the question');
    expect(run.stderr.trim()).toBe(WORKER_ASK_DENY_REASON);
  });

  it('without a deny script it falls back to the deny rule (no hook, no env)', () => {
    expect(buildWorkerDelegateSettings({ denyScriptPath: null })).toEqual({
      permissions: {
        allow: ['mcp__wmux__moa_ask', 'mcp__wmux__moa_ask_status'],
        deny: ['AskUserQuestion', 'Bash(gh pr merge*)', 'Bash(gh api*merge*)'],
      },
    });
  });

  it('is rewritten when it drifted and left alone when it did not', () => {
    const settingsPath = writeWorkerDelegateProfile(dir) as string;
    const first = fs.statSync(settingsPath).mtimeMs;
    writeWorkerDelegateProfile(dir);
    expect(fs.statSync(settingsPath).mtimeMs).toBe(first);
    fs.writeFileSync(settingsPath, '{"permissions":{"deny":[]}}');
    writeWorkerDelegateProfile(dir);
    expect(JSON.parse(fs.readFileSync(settingsPath, 'utf8')).permissions.allow).toContain('mcp__wmux__moa_ask');
  });
});
