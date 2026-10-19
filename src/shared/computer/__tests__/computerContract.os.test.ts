import { describe, expect, it } from 'vitest';
import {
  COMPUTER_ERROR_CODES,
  COMPUTER_ERROR_NEXT_STEPS,
  encodeComputerErrorMessage,
  formatComputerError,
  parseComputerErrorMessage,
} from '../errors';
import { computeScreenshotScale, scaledSize, screenshotPointToWindow } from '../scale';
import { COMPUTER_ACTIONS, isControlAction, isKey, normalizeKey, normalizeModifier, parseHelperLine, parseHotkey } from '../protocol';
import { blockReasonFor, osChordRefusal, selectorBlockReasonFor } from '../blocklist';

describe('computer errors', () => {
  it('gives every code at least one next step', () => {
    for (const code of COMPUTER_ERROR_CODES) {
      expect(COMPUTER_ERROR_NEXT_STEPS[code].length).toBeGreaterThan(0);
    }
  });

  it('round-trips a code through the RPC message string', () => {
    const encoded = encodeComputerErrorMessage({ code: 'element_stale', message: 'index 4 changed' });
    expect(parseComputerErrorMessage(encoded)).toEqual({ code: 'element_stale', message: 'index 4 changed' });
  });

  it('maps an unknown or missing code to internal', () => {
    expect(parseComputerErrorMessage('[not_a_code] boom')).toEqual({ code: 'internal', message: '[not_a_code] boom' });
    expect(parseComputerErrorMessage('plain failure').code).toBe('internal');
  });

  it('formats the code, message and next steps for the agent', () => {
    const text = formatComputerError({ code: 'app_blocked', message: 'KeePassXC is blocked' });
    expect(text).toContain('[app_blocked]');
    expect(text).toContain('KeePassXC is blocked');
    expect(text).toContain('Do not retry');
  });
});

describe('screenshot scale', () => {
  it('never upscales a small window', () => {
    expect(computeScreenshotScale(800, 600)).toBe(1);
  });

  it('caps the long edge at 1280', () => {
    const scale = computeScreenshotScale(2560, 400);
    expect(scaledSize(2560, 400, scale).width).toBe(1280);
  });

  it('caps the pixel budget for a large window', () => {
    const scale = computeScreenshotScale(1280, 1280);
    const size = scaledSize(1280, 1280, scale);
    expect(size.width * size.height).toBeLessThanOrEqual(1_150_000 + 2 * 1280);
  });

  it('treats degenerate sizes as unscaled', () => {
    expect(computeScreenshotScale(0, 100)).toBe(1);
    expect(computeScreenshotScale(Number.NaN, 100)).toBe(1);
  });

  it('converts screenshot pixels back to window points', () => {
    expect(screenshotPointToWindow(640, 100, { width: 1280, height: 720, scale: 0.5 })).toEqual({ x: 1280, y: 200 });
  });

  it('refuses points outside the screenshot', () => {
    const image = { width: 1280, height: 720, scale: 0.5 };
    expect(screenshotPointToWindow(1280, 10, image)).toBeNull();
    expect(screenshotPointToWindow(-1, 10, image)).toBeNull();
    expect(screenshotPointToWindow(Number.NaN, 10, image)).toBeNull();
  });
});

describe('helper protocol', () => {
  it('splits observe and control actions', () => {
    expect(isControlAction('click')).toBe(true);
    expect(isControlAction('getAppState')).toBe(false);
    expect(new Set(COMPUTER_ACTIONS).size).toBe(COMPUTER_ACTIONS.length);
  });

  it('parses a hello line', () => {
    const line = JSON.stringify({
      type: 'hello',
      protocolVersion: 2,
      os: 'win32',
      helperVersion: '0.1.0',
      capabilities: { actions: ['click'], modes: ['ax'], permissions: { accessibility: true, screenRecording: true } },
    });
    const parsed = parseHelperLine(line);
    expect(parsed.kind).toBe('hello');
  });

  it('rejects a hello with the wrong shape', () => {
    expect(parseHelperLine('{"type":"hello","protocolVersion":1}').kind).toBe('invalid');
  });

  it('parses success and error responses', () => {
    expect(parseHelperLine('{"id":3,"ok":true,"result":{"a":1}}')).toEqual({
      kind: 'response',
      response: { id: 3, ok: true, result: { a: 1 } },
    });
    expect(parseHelperLine('{"id":4,"ok":false,"error":{"code":"element_stale","message":"x"}}')).toEqual({
      kind: 'response',
      response: { id: 4, ok: false, error: { code: 'element_stale', message: 'x' } },
    });
  });

  it('downgrades an unknown helper error code to internal', () => {
    const parsed = parseHelperLine('{"id":4,"ok":false,"error":{"code":"weird","message":"x"}}');
    expect(parsed.kind === 'response' && !parsed.response.ok && parsed.response.error.code).toBe('internal');
  });

  it('marks garbage as invalid instead of throwing', () => {
    expect(parseHelperLine('not json').kind).toBe('invalid');
    expect(parseHelperLine('[1,2]').kind).toBe('invalid');
    expect(parseHelperLine('{"ok":true}').kind).toBe('invalid');
    expect(parseHelperLine('{"id":1.5,"ok":true}').kind).toBe('invalid');
  });
});

describe('blocklist', () => {
  const app = (path: string, bundleId?: string, pid = 100) => ({ path, bundleId, pid });

  it('blocks password managers by exe and bundle id', () => {
    expect(blockReasonFor(app('C:\\Program Files\\KeePassXC\\KeePassXC.exe'))).toBe('password-manager');
    expect(blockReasonFor(app('/Applications/1Password.app', 'com.1password.1password'))).toBe('password-manager');
  });

  it('allows terminals and agent apps (owner decision 2026-10-08)', () => {
    expect(blockReasonFor(app('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'))).toBeNull();
    expect(blockReasonFor(app('/Applications/iTerm.app', 'com.googlecode.iterm2'))).toBeNull();
    expect(blockReasonFor(app('/System/Applications/Utilities/Terminal.app', 'com.apple.Terminal'))).toBeNull();
    expect(blockReasonFor(app('/Applications/Claude.app', 'com.anthropic.claudefordesktop'))).toBeNull();
  });

  it('blocks wmux by pid and by its own exe path', () => {
    expect(blockReasonFor(app('C:\\x\\notepad.exe', undefined, 42), { selfPids: new Set([42]) })).toBe('wmux');
    expect(blockReasonFor(app('C:\\Apps\\Renamed.exe'), { selfExePath: 'c:\\apps\\renamed.exe' })).toBe('wmux');
  });

  it('blocks UAC and credential prompts', () => {
    expect(blockReasonFor(app('C:\\Windows\\System32\\consent.exe'))).toBe('credential-prompt');
    expect(blockReasonFor(app('/System/Library/Frameworks/Security.framework/SecurityAgent.app', 'com.apple.SecurityAgent'))).toBe('credential-prompt');
  });

  it('allows ordinary apps', () => {
    expect(blockReasonFor(app('C:\\Windows\\System32\\notepad.exe'))).toBeNull();
    expect(blockReasonFor(app('/System/Applications/TextEdit.app', 'com.apple.TextEdit'))).toBeNull();
  });
});

describe('key vocabulary', () => {
  it('normalizes case and aliases to the canonical spelling', () => {
    expect(normalizeKey('enter')).toBe('Enter');
    expect(normalizeKey('Return')).toBe('Enter');
    expect(normalizeKey('esc')).toBe('Escape');
    expect(normalizeKey('PGDN')).toBe('PageDown');
    expect(normalizeKey('f12')).toBe('F12');
    expect(normalizeKey('A')).toBe('a');
    expect(normalizeKey('7')).toBe('7');
    expect(normalizeKey(' ')).toBe('Space');
  });

  it('refuses names outside the vocabulary', () => {
    for (const bad of ['F13', 'PrintScreen', 'é', 'ab', '', 'ctrl', '/', 'Insert']) {
      expect(normalizeKey(bad)).toBeNull();
    }
    // Prototype names never resolve through the alias tables.
    for (const proto of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
      expect(normalizeKey(proto), proto).toBeNull();
      expect(normalizeModifier(proto), proto).toBeNull();
    }
    expect(isKey('Enter')).toBe(true);
    expect(isKey('enter')).toBe(false);
  });

  it('maps OS modifier names onto the four wire modifiers', () => {
    expect(normalizeModifier('Cmd')).toBe('meta');
    expect(normalizeModifier('win')).toBe('meta');
    expect(normalizeModifier('option')).toBe('alt');
    expect(normalizeModifier('Control')).toBe('ctrl');
    expect(normalizeModifier('hyper')).toBeNull();
  });

  it('parses a hotkey into ordered modifiers and exactly one key', () => {
    expect(parseHotkey(['S', 'shift', 'cmd'])).toEqual({ modifiers: ['shift', 'meta'], key: 's' });
    expect(parseHotkey(['ctrl', 'ctrl', 'Tab'])).toEqual({ modifiers: ['ctrl'], key: 'Tab' });
    expect(parseHotkey(['ctrl', 'shift'])).toHaveProperty('error');
    expect(parseHotkey(['a', 'b'])).toHaveProperty('error');
    expect(parseHotkey(['ctrl', 'PrintScreen'])).toHaveProperty('error');
    expect(parseHotkey(['ctrl', 3])).toHaveProperty('error');
  });
});

describe('blocklist after the 2026-10-08 trim', () => {
  const app = (path: string, bundleId?: string) => ({ pid: 99, path, ...(bundleId && { bundleId }) });

  it('allows system settings, script runners and process managers on both OSes', () => {
    for (const exe of ['C:\\Windows\\System32\\Taskmgr.exe', 'C:\\Windows\\regedit.exe', 'C:\\Windows\\ImmersiveControlPanel\\SystemSettings.exe', 'C:\\Windows\\explorer.exe']) {
      expect(blockReasonFor(app(exe)), exe).toBeNull();
    }
    for (const id of ['com.apple.systempreferences', 'com.apple.ScriptEditor2', 'com.apple.Automator', 'com.apple.shortcuts', 'com.apple.ActivityMonitor', 'com.apple.dt.Xcode']) {
      expect(blockReasonFor(app(`/Applications/${id}.app`, id)), id).toBeNull();
    }
  });

  it('still blocks password managers, wmux and credential prompts', () => {
    expect(blockReasonFor(app('/System/Applications/Passwords.app', 'com.apple.Passwords'))).toBe('password-manager');
    expect(blockReasonFor(app('/Applications/wmux.app', 'com.electron.wmux'))).toBe('wmux');
    expect(blockReasonFor(app('C:\\Windows\\System32\\LogonUI.exe'))).toBe('credential-prompt');
  });
});

describe('openApp selector check', () => {
  it('refuses a blocked app by name, bundle id, listApps id or path before launch', () => {
    for (const selector of ['1Password', 'bitwarden', 'Keychain Access', 'Passwords', 'com.1password.1password', 'COM.BITWARDEN.DESKTOP', '/Applications/1Password.app', '/Applications/1Password.app/', 'C:\\Program Files\\KeePassXC\\KeePassXC.exe']) {
      expect(selectorBlockReasonFor(selector), selector).toBe('password-manager');
    }
    expect(selectorBlockReasonFor('wmux')).toBe('wmux');
    expect(selectorBlockReasonFor('com.electron.wmux')).toBe('wmux');
    expect(selectorBlockReasonFor('/apps/renamed.app', { selfExePath: '/apps/renamed.app' })).toBe('wmux');
    expect(selectorBlockReasonFor('pid:42', { selfPids: new Set([42]) })).toBe('wmux');
  });

  it('lets other selectors through', () => {
    for (const selector of ['Terminal', 'System Settings', 'com.apple.systempreferences', 'Xcode', '/Applications/Safari.app', 'pid:7', '']) {
      expect(selectorBlockReasonFor(selector), selector).toBeNull();
    }
  });
});

describe('OS-wide chord refusal', () => {
  it('lets ordinary bare keys through', () => {
    for (const key of ['Escape', 'Tab', 'Enter', 'F3', 'F4', 'F5', 'F11', 'F12', 'a']) {
      expect(osChordRefusal('win32', [], key)).toBeNull();
      expect(osChordRefusal('darwin', [], key)).toBeNull();
    }
  });

  it('allows app switching, Start / Spotlight and Mission Control', () => {
    for (const [mods, key] of [[['meta'], 'Tab'], [['meta'], 'Space'], [['ctrl'], 'Space'], [['ctrl'], 'ArrowUp'], [['ctrl'], 'F2'], [['meta', 'shift'], '4'], [['meta', 'alt'], 'd']] as const) {
      expect(osChordRefusal('darwin', mods, key), [...mods, key].join('+')).toBeNull();
    }
    for (const [mods, key] of [[['alt'], 'Tab'], [['meta'], 'r'], [['meta'], 'd'], [['ctrl'], 'Escape'], [['alt'], 'Escape'], [['alt'], 'Space'], [['meta'], 'Tab']] as const) {
      expect(osChordRefusal('win32', mods, key), [...mods, key].join('+')).toBeNull();
    }
  });

  it('refuses lock screen, log out and force quit', () => {
    for (const [mods, key] of [[['meta', 'ctrl'], 'q'], [['meta', 'shift'], 'q'], [['meta', 'alt', 'shift'], 'q'], [['meta', 'alt'], 'Escape']] as const) {
      expect(osChordRefusal('darwin', mods, key), [...mods, key].join('+')).not.toBeNull();
    }
    for (const [mods, key] of [[['meta'], 'l'], [['meta'], 'x'], [['ctrl', 'alt'], 'Delete'], [['ctrl', 'shift'], 'Escape']] as const) {
      expect(osChordRefusal('win32', mods, key), [...mods, key].join('+')).not.toBeNull();
    }
    // Cmd+Q quits only the target app.
    expect(osChordRefusal('darwin', ['meta'], 'q')).toBeNull();
  });

  it('refuses the stop key on every platform', () => {
    expect(osChordRefusal('linux', ['ctrl', 'alt', 'shift'], 'Escape')).not.toBeNull();
  });
});
