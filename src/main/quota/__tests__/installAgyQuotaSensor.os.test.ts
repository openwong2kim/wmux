import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as safeWrite from '../../surfaces/safeWrite';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import {
  installAgyQuotaSensor,
  classifyAgyStatusLine,
  extractExistingCommand,
  encodeChainedCommand,
  decodeChainedCommand,
  extractChainedB64,
  refreshInstalledAgyQuotaSink,
} from '../installAgyQuotaSensor';

describe('installAgyQuotaSensor', () => {
  let tmpHome: string;
  let mockSinkSource: string;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-agy-sensor-test-'));
    // Create a mock source script
    mockSinkSource = path.join(tmpHome, 'source', 'quota-sink.js');
    fs.mkdirSync(path.dirname(mockSinkSource), { recursive: true });
    fs.writeFileSync(mockSinkSource, '// mock quota-sink\n', 'utf8');
  });

  afterEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  function settingsFilePath(): string {
    return path.join(tmpHome, '.gemini', 'antigravity-cli', 'settings.json');
  }

  function readSettings(): Record<string, unknown> {
    return JSON.parse(fs.readFileSync(settingsFilePath(), 'utf8'));
  }

  it('Case 1: Fresh install with bare node default and exact unquoted command string', () => {
    const outcome = installAgyQuotaSensor(tmpHome, {
      sourceScriptPath: mockSinkSource,
    });

    expect(outcome.ok).toBe(true);
    expect(outcome.action).toBe('installed');
    expect(outcome.backupPath).toBeUndefined();

    // Destination script must have been copied
    const installedSink = path.join(tmpHome, '.wmux', 'bin', 'quota-sink.js');
    expect(fs.existsSync(installedSink)).toBe(true);
    expect(fs.readFileSync(installedSink, 'utf8')).toBe('// mock quota-sink\n');

    // settings.json must be created with statusLine
    expect(fs.existsSync(settingsFilePath())).toBe(true);
    const settings = readSettings();
    const sl = settings.statusLine as {
      type: string;
      command: string;
      enabled: boolean;
      stack_with_default: boolean;
    };

    expect(sl.type).toBe('command');
    // Must be EXACTLY unquoted: `node <sinkScriptPath> agy`
    expect(sl.command).toBe(`node ${installedSink} agy`);
    expect(sl.command).not.toContain('"');
    expect(sl.enabled).toBe(true);
    expect(sl.stack_with_default).toBe(true);
  });

  it('Case 1b: Fresh install when settings.json exists without statusLine, preserving other keys', () => {
    const settingsPath = settingsFilePath();
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    const initialConfig = {
      theme: 'dracula',
      permissions: { allow: ['command(ls)'] },
      user_preference: 42,
    };
    fs.writeFileSync(settingsPath, JSON.stringify(initialConfig, null, 2), 'utf8');

    const outcome = installAgyQuotaSensor(tmpHome, {
      sourceScriptPath: mockSinkSource,
    });

    expect(outcome.ok).toBe(true);
    expect(outcome.action).toBe('installed');
    expect(outcome.backupPath).toBeUndefined();

    const settings = readSettings();
    // Pre-existing keys must be completely preserved
    expect(settings.theme).toBe('dracula');
    expect(settings.permissions).toEqual({ allow: ['command(ls)'] });
    expect(settings.user_preference).toBe(42);

    // statusLine is merged in
    expect(settings.statusLine).toBeDefined();
    const sl = settings.statusLine as { type: string; command: string; enabled: boolean };
    expect(sl.type).toBe('command');
    const installedSink = path.join(tmpHome, '.wmux', 'bin', 'quota-sink.js');
    expect(sl.command).toBe(`node ${installedSink} agy`);
    expect(sl.enabled).toBe(true);
  });

  it('Case 1c: Fresh install when settings.json contains empty placeholder statusLine, preserving other keys and creating no backup', () => {
    const settingsPath = settingsFilePath();
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    const initialConfig = {
      theme: 'dracula',
      statusLine: { type: '', command: '', enabled: false },
      user_preference: 42,
    };
    fs.writeFileSync(settingsPath, JSON.stringify(initialConfig, null, 2), 'utf8');

    const outcome = installAgyQuotaSensor(tmpHome, {
      sourceScriptPath: mockSinkSource,
    });

    expect(outcome.ok).toBe(true);
    expect(outcome.action).toBe('installed');
    expect(outcome.backupPath).toBeUndefined();

    // No backup file created in the dir
    const geminiDir = path.dirname(settingsPath);
    const backups = fs.readdirSync(geminiDir).filter((f) => f.includes('.bak-wmux-'));
    expect(backups).toHaveLength(0);

    const settings = readSettings();
    expect(settings.theme).toBe('dracula');
    expect(settings.user_preference).toBe(42);

    const installedSink = path.join(tmpHome, '.wmux', 'bin', 'quota-sink.js');
    expect(settings.statusLine).toEqual({
      type: 'command',
      command: `node ${installedSink} agy`,
      enabled: true,
      stack_with_default: true,
    });
  });

  it('Case 1d: Fresh install when settings.json contains whitespace command in statusLine, preserving other keys and creating no backup', () => {
    const settingsPath = settingsFilePath();
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    const initialConfig = {
      theme: 'solarized',
      statusLine: { type: 'command', command: '   ', enabled: false },
      user_preference: 100,
    };
    fs.writeFileSync(settingsPath, JSON.stringify(initialConfig, null, 2), 'utf8');

    const outcome = installAgyQuotaSensor(tmpHome, {
      sourceScriptPath: mockSinkSource,
    });

    expect(outcome.ok).toBe(true);
    expect(outcome.action).toBe('installed');
    expect(outcome.backupPath).toBeUndefined();

    const geminiDir = path.dirname(settingsPath);
    const backups = fs.readdirSync(geminiDir).filter((f) => f.includes('.bak-wmux-'));
    expect(backups).toHaveLength(0);

    const settings = readSettings();
    expect(settings.theme).toBe('solarized');
    expect(settings.user_preference).toBe(100);

    const installedSink = path.join(tmpHome, '.wmux', 'bin', 'quota-sink.js');
    expect(settings.statusLine).toEqual({
      type: 'command',
      command: `node ${installedSink} agy`,
      enabled: true,
      stack_with_default: true,
    });
  });

  describe('Safety guard: allowlist path validation', () => {
    const REJECTED_CHARS: Array<{ label: string; char: string }> = [
      { label: 'space', char: ' ' },
      { label: 'double quote', char: '"' },
      { label: 'single quote', char: "'" },
      { label: 'backtick', char: '`' },
      { label: 'ampersand', char: '&' },
      { label: 'pipe', char: '|' },
      { label: 'less than', char: '<' },
      { label: 'greater than', char: '>' },
      { label: 'caret', char: '^' },
      { label: 'percent', char: '%' },
      { label: 'open parenthesis', char: '(' },
      { label: 'close parenthesis', char: ')' },
      { label: 'exclamation mark', char: '!' },
      { label: 'semicolon', char: ';' },
      { label: 'comma', char: ',' },
      { label: 'equals', char: '=' },
      { label: 'dollar sign', char: '$' },
      { label: 'at sign', char: '@' },
      { label: 'plus sign', char: '+' },
      { label: 'hash', char: '#' },
    ];

    it.each(REJECTED_CHARS)(
      'rejects nodePath containing $label ("$char") without touching settings.json or creating backup',
      ({ char }) => {
        const settingsPath = settingsFilePath();
        fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
        fs.writeFileSync(settingsPath, JSON.stringify({ sentinel: 'preserve-me' }), 'utf8');

        const outcome = installAgyQuotaSensor(tmpHome, {
          sourceScriptPath: mockSinkSource,
          nodePath: `node${char}test`,
        });

        expect(outcome.ok).toBe(false);
        expect(outcome.action).toBe('noop');
        expect(outcome.error).toBe('Install path must not contain spaces or special characters');

        // settings.json must NOT be touched
        expect(JSON.parse(fs.readFileSync(settingsPath, 'utf8'))).toEqual({ sentinel: 'preserve-me' });
        // No backup created
        const geminiDir = path.dirname(settingsPath);
        const backups = fs.readdirSync(geminiDir).filter((f) => f.includes('.bak-wmux-'));
        expect(backups).toHaveLength(0);
      },
    );

    it.each(REJECTED_CHARS)(
      'rejects sinkScriptPath containing $label ("$char") without touching settings.json, creating backup, or copying script',
      ({ char }) => {
        const settingsPath = settingsFilePath();
        fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
        fs.writeFileSync(settingsPath, JSON.stringify({ sentinel: 'preserve-me' }), 'utf8');

        const specialDir = path.join(tmpHome, `dir${char}special`);
        const specialSink = path.join(specialDir, 'quota-sink.js');

        const outcome = installAgyQuotaSensor(tmpHome, {
          sourceScriptPath: mockSinkSource,
          sinkScriptPath: specialSink,
        });

        expect(outcome.ok).toBe(false);
        expect(outcome.action).toBe('noop');
        expect(outcome.error).toBe('Install path must not contain spaces or special characters');

        expect(JSON.parse(fs.readFileSync(settingsPath, 'utf8'))).toEqual({ sentinel: 'preserve-me' });
        const backups = fs.readdirSync(path.dirname(settingsPath)).filter((f) => f.includes('.bak-wmux-'));
        expect(backups).toHaveLength(0);
        expect(fs.existsSync(specialSink)).toBe(false);
      },
    );

    it('accepts accented path (e.g. C:\\Users\\João\\.wmux\\bin\\quota-sink.js) and installs cleanly', () => {
      const accentedSink = path.join(tmpHome, 'Users', 'João', '.wmux', 'bin', 'quota-sink.js');
      const outcome = installAgyQuotaSensor(tmpHome, {
        sourceScriptPath: mockSinkSource,
        sinkScriptPath: accentedSink,
        nodePath: 'node',
      });

      expect(outcome.ok).toBe(true);
      expect(outcome.action).toBe('installed');
      expect(outcome.backupPath).toBeUndefined();
      expect(fs.existsSync(accentedSink)).toBe(true);
      expect(outcome.commandWritten).toBe(`node ${accentedSink} agy`);

      const settings = readSettings();
      expect((settings.statusLine as { command: string }).command).toBe(`node ${accentedSink} agy`);
    });

    it('accepts bare node command and installs cleanly', () => {
      const outcome = installAgyQuotaSensor(tmpHome, {
        sourceScriptPath: mockSinkSource,
        nodePath: 'node',
      });

      expect(outcome.ok).toBe(true);
      expect(outcome.action).toBe('installed');
      const installedSink = path.join(tmpHome, '.wmux', 'bin', 'quota-sink.js');
      expect(outcome.commandWritten).toBe(`node ${installedSink} agy`);
    });
  });

  describe('Chaining foreign statusLine with base64url', () => {
    it('chains foreign statusLine via --chain-b64 and backs up settings.json', () => {
      const settingsPath = settingsFilePath();
      fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
      const initialConfig = {
        theme: 'solarized',
        statusLine: {
          type: 'command',
          command: 'my-custom-status --format=json',
          enabled: true,
          padding: 2,
        },
      };
      fs.writeFileSync(settingsPath, JSON.stringify(initialConfig, null, 2), 'utf8');

      const outcome = installAgyQuotaSensor(tmpHome, {
        sourceScriptPath: mockSinkSource,
      });

      expect(outcome.ok).toBe(true);
      expect(outcome.action).toBe('chained');
      expect(outcome.backupPath).toBeDefined();

      // Verify backup exists and contains original contents
      expect(fs.existsSync(outcome.backupPath!)).toBe(true);
      const backupContent = JSON.parse(fs.readFileSync(outcome.backupPath!, 'utf8'));
      expect(backupContent).toEqual(initialConfig);

      const settings = readSettings();
      expect(settings.theme).toBe('solarized');

      const sl = settings.statusLine as {
        type: string;
        command: string;
        enabled: boolean;
        padding: number;
        stack_with_default?: boolean;
      };
      expect(sl.type).toBe('command');
      expect(sl.enabled).toBe(true);
      // The user's other fields are kept and nothing they did not set is added.
      expect(sl.padding).toBe(2);
      expect(sl.stack_with_default).toBeUndefined();

      const installedSink = path.join(tmpHome, '.wmux', 'bin', 'quota-sink.js');
      const expectedB64 = Buffer.from('my-custom-status --format=json', 'utf8').toString('base64url');
      expect(sl.command).toBe(`node ${installedSink} agy --chain-b64 ${expectedB64}`);
      // Base64url alphabet contains no quotes, no spaces, no padding =
      expect(sl.command).not.toContain('"');
      expect(expectedB64).not.toContain('=');

      // Verify it decodes back to original
      expect(decodeChainedCommand(expectedB64)).toBe('my-custom-status --format=json');
    });

    it('chains foreign command containing quotes and spaces cleanly via --chain-b64', () => {
      const settingsPath = settingsFilePath();
      fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
      const foreignCommand = '"C:\\Program Files\\foo.exe" --flag "arg with space"';
      fs.writeFileSync(
        settingsPath,
        JSON.stringify({ statusLine: { type: 'command', command: foreignCommand } }, null, 2),
        'utf8',
      );

      const outcome = installAgyQuotaSensor(tmpHome, {
        sourceScriptPath: mockSinkSource,
      });

      expect(outcome.ok).toBe(true);
      expect(outcome.action).toBe('chained');

      const settings = readSettings();
      const sl = settings.statusLine as { type: string; command: string };
      const installedSink = path.join(tmpHome, '.wmux', 'bin', 'quota-sink.js');

      const expectedB64 = Buffer.from(foreignCommand, 'utf8').toString('base64url');
      expect(sl.command).toBe(`node ${installedSink} agy --chain-b64 ${expectedB64}`);
      expect(sl.command).not.toContain('"');

      // Decodes exactly to the original command with quotes and spaces
      expect(decodeChainedCommand(expectedB64)).toBe(foreignCommand);
      expect(extractChainedB64(sl.command)).toBe(foreignCommand);
    });

    it('does not chain a statusLine the user turned off, and leaves settings.json untouched', () => {
      const settingsPath = settingsFilePath();
      fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
      const original = JSON.stringify(
        { statusLine: { type: 'command', command: 'disabled-cmd --quiet', enabled: false } },
        null,
        2,
      );
      fs.writeFileSync(settingsPath, original, 'utf8');

      const outcome = installAgyQuotaSensor(tmpHome, {
        sourceScriptPath: mockSinkSource,
      });

      expect(outcome.ok).toBe(false);
      expect(outcome.action).toBe('noop');
      expect(outcome.error).toMatch(/turned off/);
      expect(fs.readFileSync(settingsPath, 'utf8')).toBe(original);
      const backups = fs.readdirSync(path.dirname(settingsPath)).filter((f) => f.includes('.bak-wmux-'));
      expect(backups).toEqual([]);
    });
  });

  describe('a save agy makes while installing', () => {
    it('is not overwritten: the install stops and says so', () => {
      const settingsPath = settingsFilePath();
      fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
      const original = JSON.stringify({ statusLine: { type: 'command', command: 'my-status' } });
      fs.writeFileSync(settingsPath, original, 'utf8');
      const spy = vi.spyOn(safeWrite, 'applyConfigEdit').mockImplementation(() => {
        throw new safeWrite.ConfigChangedError(settingsPath, 'modified');
      });
      try {
        const outcome = installAgyQuotaSensor(tmpHome, { sourceScriptPath: mockSinkSource });
        expect(outcome.ok).toBe(false);
        expect(outcome.error).toMatch(/changed settings.json/);
        expect(fs.readFileSync(settingsPath, 'utf8')).toBe(original);
      } finally {
        spy.mockRestore();
      }
    });
  });

  describe('Idempotence and rewriting agy-sink', () => {
    it('Case 3: Idempotent re-run on already-installed fresh sink is a no-op (no rewrite, no backup)', () => {
      const first = installAgyQuotaSensor(tmpHome, {
        sourceScriptPath: mockSinkSource,
      });
      expect(first.action).toBe('installed');

      const statBefore = fs.statSync(settingsFilePath());
      const contentBefore = fs.readFileSync(settingsFilePath(), 'utf8');

      const geminiDir = path.dirname(settingsFilePath());
      const backupsBefore = fs.readdirSync(geminiDir).filter((f) => f.includes('.bak-wmux-'));
      expect(backupsBefore).toHaveLength(0);

      // Re-run installer
      const second = installAgyQuotaSensor(tmpHome, {
        sourceScriptPath: mockSinkSource,
      });

      expect(second.ok).toBe(true);
      expect(second.action).toBe('noop');
      expect(second.backupPath).toBeUndefined();

      const statAfter = fs.statSync(settingsFilePath());
      const contentAfter = fs.readFileSync(settingsFilePath(), 'utf8');
      expect(contentAfter).toBe(contentBefore);
      expect(statAfter.mtimeMs).toBe(statBefore.mtimeMs);

      const backupsAfter = fs.readdirSync(geminiDir).filter((f) => f.includes('.bak-wmux-'));
      expect(backupsAfter).toHaveLength(0);
    });

    it('Case 3b: Idempotent re-run on chained sink is also a no-op', () => {
      const settingsPath = settingsFilePath();
      fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
      fs.writeFileSync(
        settingsPath,
        JSON.stringify({ statusLine: { type: 'command', command: 'prev-cmd' } }),
        'utf8',
      );

      const first = installAgyQuotaSensor(tmpHome, {
        sourceScriptPath: mockSinkSource,
      });
      expect(first.action).toBe('chained');
      expect(first.backupPath).toBeDefined();

      const geminiDir = path.dirname(settingsPath);
      const backupsAfterFirst = fs.readdirSync(geminiDir).filter((f) => f.includes('.bak-wmux-'));
      expect(backupsAfterFirst).toHaveLength(1);

      const second = installAgyQuotaSensor(tmpHome, {
        sourceScriptPath: mockSinkSource,
      });
      expect(second.ok).toBe(true);
      expect(second.action).toBe('noop');
      expect(second.backupPath).toBeUndefined();

      const backupsAfterSecond = fs.readdirSync(geminiDir).filter((f) => f.includes('.bak-wmux-'));
      expect(backupsAfterSecond).toHaveLength(1);
    });

    it('rewrites agy-sink when command differs (moved path) with backup and preserves chain', () => {
      const settingsPath = settingsFilePath();
      fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
      const origCmd = 'custom-bar --format=json';
      const origB64 = encodeChainedCommand(origCmd);
      const oldCmd = `node C:\\old-home\\.wmux\\bin\\quota-sink.js agy --chain-b64 ${origB64}`;
      fs.writeFileSync(
        settingsPath,
        JSON.stringify({ statusLine: { type: 'command', command: oldCmd } }, null, 2),
        'utf8',
      );

      const outcome = installAgyQuotaSensor(tmpHome, {
        sourceScriptPath: mockSinkSource,
      });

      expect(outcome.ok).toBe(true);
      expect(outcome.action).toBe('chained');
      expect(outcome.backupPath).toBeDefined();

      // Verify backup contains the previous statusLine
      const backupContent = JSON.parse(fs.readFileSync(outcome.backupPath!, 'utf8'));
      expect(backupContent.statusLine.command).toBe(oldCmd);

      // Verify rewritten settings points to the new sink path and keeps the chain
      const settings = readSettings();
      const installedSink = path.join(tmpHome, '.wmux', 'bin', 'quota-sink.js');
      const expectedNewCmd = `node ${installedSink} agy --chain-b64 ${origB64}`;
      // Only the command moves; fields the entry did not have are not added.
      expect(settings.statusLine).toEqual({
        type: 'command',
        command: expectedNewCmd,
      });
      expect(extractChainedB64((settings.statusLine as { command: string }).command)).toBe(origCmd);
    });

    it('rewrites agy-sink with old quoted format with a backup', () => {
      const settingsPath = settingsFilePath();
      fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
      const installedSink = path.join(tmpHome, '.wmux', 'bin', 'quota-sink.js');
      const oldQuotedCmd = `"node" "${installedSink}" agy`;
      fs.writeFileSync(
        settingsPath,
        JSON.stringify({ statusLine: { type: 'command', command: oldQuotedCmd } }, null, 2),
        'utf8',
      );

      const outcome = installAgyQuotaSensor(tmpHome, {
        sourceScriptPath: mockSinkSource,
      });

      expect(outcome.ok).toBe(true);
      expect(outcome.action).toBe('installed');
      expect(outcome.backupPath).toBeDefined();

      const settings = readSettings();
      expect((settings.statusLine as { command: string }).command).toBe(`node ${installedSink} agy`);
    });
  });

  describe('Error handling', () => {
    it('handles corrupted settings.json cleanly without crashing', () => {
      const settingsPath = settingsFilePath();
      fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
      fs.writeFileSync(settingsPath, 'INVALID JSON {[[', 'utf8');

      const outcome = installAgyQuotaSensor(tmpHome, {
        sourceScriptPath: mockSinkSource,
      });

      expect(outcome.ok).toBe(false);
      expect(outcome.action).toBe('noop');
      expect(outcome.error).toBe('settings.json is not valid JSON; fix or remove it and try again');
    });

    it('never echoes secret or file fragments in error message when settings.json is corrupted', () => {
      const settingsPath = settingsFilePath();
      fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
      const secret = 'super-secret-api-key-xyz-12345';
      fs.writeFileSync(settingsPath, `{"apiKey": "${secret}", broken json...`, 'utf8');

      const outcome = installAgyQuotaSensor(tmpHome, {
        sourceScriptPath: mockSinkSource,
      });

      expect(outcome.ok).toBe(false);
      expect(outcome.action).toBe('noop');
      expect(outcome.error).toBe('settings.json is not valid JSON; fix or remove it and try again');
      expect(outcome.error).not.toContain(secret);
      expect(outcome.error).not.toContain('super-secret');
      expect(outcome.error).not.toContain('apiKey');
    });

    it('fails and does not write settings.json when quota-sink source script is missing', () => {
      const missingSource = path.join(tmpHome, 'nonexistent', 'quota-sink.js');
      const outcome = installAgyQuotaSensor(tmpHome, {
        sourceScriptPath: missingSource,
      });

      expect(outcome.ok).toBe(false);
      expect(outcome.action).toBe('noop');
      expect(outcome.error).toContain('Source quota-sink.js script not found');
      expect(outcome.error).toContain(missingSource);

      expect(fs.existsSync(settingsFilePath())).toBe(false);
      const installedSink = path.join(tmpHome, '.wmux', 'bin', 'quota-sink.js');
      expect(fs.existsSync(installedSink)).toBe(false);
    });
  });
});

describe('classifyAgyStatusLine & extractExistingCommand helper', () => {
  it('classifies none correctly', () => {
    expect(classifyAgyStatusLine({})).toBe('none');
    expect(classifyAgyStatusLine({ statusLine: undefined })).toBe('none');
    expect(classifyAgyStatusLine({ statusLine: null })).toBe('none');
    expect(classifyAgyStatusLine({ statusLine: '' })).toBe('none');
    expect(classifyAgyStatusLine({ statusLine: '   ' })).toBe('none');
    expect(classifyAgyStatusLine({ statusLine: '\t\r\n ' })).toBe('none');

    // Fresh Antigravity CLI placeholder object: { type: "", command: "", enabled: false }
    expect(
      classifyAgyStatusLine({
        statusLine: { type: '', command: '', enabled: false },
      }),
    ).toBe('none');

    expect(classifyAgyStatusLine({ statusLine: {} })).toBe('none');
    expect(classifyAgyStatusLine({ statusLine: { type: 'command' } })).toBe('none');
    expect(classifyAgyStatusLine({ statusLine: { enabled: true } })).toBe('none');

    expect(classifyAgyStatusLine({ statusLine: { command: 123 } })).toBe('none');
    expect(classifyAgyStatusLine({ statusLine: { command: null } })).toBe('none');
    expect(classifyAgyStatusLine({ statusLine: { command: true } })).toBe('none');
    expect(classifyAgyStatusLine({ statusLine: { command: {} } })).toBe('none');
    expect(classifyAgyStatusLine({ statusLine: { command: [] } })).toBe('none');

    expect(classifyAgyStatusLine({ statusLine: { command: '' } })).toBe('none');
    expect(classifyAgyStatusLine({ statusLine: { command: '   ' } })).toBe('none');
    expect(
      classifyAgyStatusLine({
        statusLine: { type: 'command', command: '   ', enabled: false },
      }),
    ).toBe('none');
    expect(
      classifyAgyStatusLine({
        statusLine: { type: 'command', command: ' \r\n\t ', enabled: true },
      }),
    ).toBe('none');
  });

  it('classifies agy-sink correctly', () => {
    expect(
      classifyAgyStatusLine({
        statusLine: { command: 'node C:\\Users\\u\\.wmux\\bin\\quota-sink.js agy' },
      }),
    ).toBe('agy-sink');

    // A user's own script that happens to be named quota-sink.js is not wmux's.
    expect(
      classifyAgyStatusLine({
        statusLine: { command: 'node C:\\path\\quota-sink.js agy' },
      }),
    ).toBe('foreign');

    expect(
      classifyAgyStatusLine({
        statusLine: { command: 'node C:\\custom\\sink.js agy' },
      }, 'C:\\custom\\sink.js'),
    ).toBe('agy-sink');

    expect(
      classifyAgyStatusLine({
        statusLine: { command: 'node quota-sink.js', enabled: false },
      }),
    ).toBe('foreign');

    expect(
      classifyAgyStatusLine({
        statusLine: 'node "C:\\Users\\u\\.wmux-dev\\bin\\quota-sink.js"',
      }),
    ).toBe('agy-sink');
  });

  it('classifies foreign correctly', () => {
    expect(
      classifyAgyStatusLine({
        statusLine: { command: 'node other-script.js' },
      }),
    ).toBe('foreign');

    expect(
      classifyAgyStatusLine({
        statusLine: { command: 'node other-script.js', enabled: false },
      }),
    ).toBe('foreign');

    expect(
      classifyAgyStatusLine({
        statusLine: { command: 'my-custom-command --flag', enabled: true },
      }),
    ).toBe('foreign');

    expect(
      classifyAgyStatusLine({
        statusLine: 'custom-string-command',
      }),
    ).toBe('foreign');
  });

  it('extractExistingCommand extracts string from object or string value', () => {
    expect(extractExistingCommand({ command: 'my-cmd --arg' })).toBe('my-cmd --arg');
    expect(extractExistingCommand('bare-cmd')).toBe('bare-cmd');
    expect(extractExistingCommand(null)).toBe('');
    expect(extractExistingCommand(undefined)).toBe('');
  });
});

describe('encodeChainedCommand, decodeChainedCommand, and extractChainedB64 helpers', () => {
  it('round-trips complex commands with quotes, slashes, and spaces through base64url', () => {
    const commands = [
      '"C:\\Program Files\\app.exe" --flag "with space"',
      'node -e "console.log(\\"hello\\")"',
      'simple-command',
      '/usr/local/bin/my-status --json',
    ];

    for (const cmd of commands) {
      const b64 = encodeChainedCommand(cmd);
      expect(b64).not.toContain('+');
      expect(b64).not.toContain('/');
      expect(b64).not.toContain('=');
      expect(b64).not.toContain('"');
      expect(b64).not.toContain(' ');
      expect(decodeChainedCommand(b64)).toBe(cmd);
    }
  });

  it('extractChainedB64 extracts and decodes chained argument from statusLine command', () => {
    const origCmd = '"C:\\My App\\tool.exe" --json';
    const b64 = encodeChainedCommand(origCmd);
    const statusLineCmd = `node C:\\path\\quota-sink.js agy --chain-b64 ${b64}`;

    expect(extractChainedB64(statusLineCmd)).toBe(origCmd);
  });

  it('extractChainedB64 returns null if no --chain-b64 argument is present', () => {
    expect(extractChainedB64('node quota-sink.js agy')).toBeNull();
  });
});

describe('End-to-end chaining roundtrip with quote-free command line', () => {
  it('executes chained command line through shell without quote corruption', () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-e2e-chain-'));
    try {
      const helperScript = path.join(tmpHome, 'echo-helper.js');
      fs.writeFileSync(
        helperScript,
        'process.stdout.write("ARG:" + process.argv.slice(2).join(","));',
        'utf8',
      );

      // Foreign command that itself contains quotes
      const foreignCmd = `node "${helperScript}" "hello world"`;
      const settingsDir = path.join(tmpHome, '.gemini', 'antigravity-cli');
      fs.mkdirSync(settingsDir, { recursive: true });
      fs.writeFileSync(
        path.join(settingsDir, 'settings.json'),
        JSON.stringify({ statusLine: { type: 'command', command: foreignCmd } }),
        'utf8',
      );

      const outcome = installAgyQuotaSensor(tmpHome, {
        sourceScriptPath: path.resolve(__dirname, '../../../../integrations/agy/bin/quota-sink.js'),
        nodePath: 'node',
      });

      expect(outcome.ok).toBe(true);
      expect(outcome.action).toBe('chained');
      expect(outcome.commandWritten).toBeDefined();

      // The statusLine command must have NO quotes around node or sink
      const tokens = outcome.commandWritten!.split(' ');
      expect(tokens[0]).toBe('node');
      expect(tokens[2]).toBe('agy');
      expect(tokens[3]).toBe('--chain-b64');

      // Execute statusLine.command via shell (as agy does)
      const res = spawnSync(outcome.commandWritten!, {
        shell: true,
        input: JSON.stringify({ quota: { remaining: 1 } }),
        encoding: 'utf8',
        env: {
          ...process.env,
          WMUX_QUOTA_SINK_HOME: tmpHome,
        },
      });

      expect(res.status).toBe(0);
      expect(res.stdout).toBe('ARG:hello world');
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });
});

describe('refreshInstalledAgyQuotaSink', () => {
  it('updates only an installed, outdated sink', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-sink-refresh-'));
    const src = path.join(home, 'src-sink.js');
    fs.writeFileSync(src, 'v2');
    try {
      expect(refreshInstalledAgyQuotaSink(home, src)).toBe('absent');
      const dest = path.join(home, '.wmux', 'bin', 'quota-sink.js');
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, 'v1');
      expect(refreshInstalledAgyQuotaSink(home, src)).toBe('updated');
      expect(fs.readFileSync(dest, 'utf8')).toBe('v2');
      expect(refreshInstalledAgyQuotaSink(home, src)).toBe('current');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
