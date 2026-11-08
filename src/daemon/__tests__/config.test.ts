// @wmux-lane unit — 'win32' here is a stubbed process.platform; the locked-file reads are mocked fs calls.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  createDefaultConfig,
  loadConfig,
  saveConfig,
  saveConfigOrThrow,
  getWmuxDir,
  readNotifySinks,
  resetNotifySinksCache,
  readPushPresenceSuppression,
  resetGateMigrationSaveFailure,
  resetUnusableConfigWarning,
  isFailClosedConfig,
  CONFIG_READ_ATTEMPTS,
  setConfigReadSleepForTest,
  resetConfigReadStreaks,
} from '../config';
import {
  DESKTOP_PRESENCE_STALE_AFTER_MS,
  DESKTOP_PRESENCE_STALE_CAP_MS,
} from '../push/presence';
import type { DaemonConfig } from '../types';
import { GATE_POWERSHELL_MIGRATION } from '../approvals/gateConfig';
import { handleGate } from '../../cli/commands/gate';

/** Use a temp directory instead of the real ~/.wmux */
let originalHomedir: typeof os.homedir;
let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-config-test-'));
  originalHomedir = os.homedir;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (os as any).homedir = () => tmpDir;
});

afterEach(() => {
  resetUnusableConfigWarning();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (os as any).homedir = originalHomedir;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('createDefaultConfig', () => {
  it('returns a valid DaemonConfig with expected defaults', () => {
    const config = createDefaultConfig();
    expect(config.version).toBe(1);
    expect(config.daemon.logLevel).toBe('info');
    expect(config.daemon.autoStart).toBe(true);
    expect(typeof config.daemon.pipeName).toBe('string');
    expect(config.session.defaultCols).toBe(120);
    expect(config.session.defaultRows).toBe(30);
    expect(config.session.bufferSizeMb).toBe(8);
    expect(config.session.bufferMaxMb).toBe(64);
    expect(config.session.deadSessionTtlHours).toBe(24);
    expect(config.session.deadSessionDumpBuffer).toBe(true);
    expect(typeof config.session.defaultShell).toBe('string');
  });
});

describe('loadConfig', () => {
  it('creates ~/.wmux directory and default config when nothing exists', () => {
    const wmuxDir = getWmuxDir();
    expect(fs.existsSync(wmuxDir)).toBe(false);

    const config = loadConfig();
    expect(fs.existsSync(wmuxDir)).toBe(true);
    expect(fs.existsSync(path.join(wmuxDir, 'config.json'))).toBe(true);
    expect(config.version).toBe(1);
  });

  it('loads an existing valid config from disk', () => {
    const wmuxDir = getWmuxDir();
    fs.mkdirSync(wmuxDir, { recursive: true });

    const custom: DaemonConfig = {
      ...createDefaultConfig(),
      daemon: {
        ...createDefaultConfig().daemon,
        logLevel: 'debug',
      },
    };
    fs.writeFileSync(
      path.join(wmuxDir, 'config.json'),
      JSON.stringify(custom, null, 2),
      'utf-8',
    );

    const loaded = loadConfig();
    expect(loaded.daemon.logLevel).toBe('debug');
  });

  it('reads a config.json that starts with a UTF-8 BOM (Windows PowerShell 5.1 writes one)', () => {
    const wmuxDir = getWmuxDir();
    fs.mkdirSync(wmuxDir, { recursive: true });
    const custom = {
      ...createDefaultConfig(),
      daemon: { ...createDefaultConfig().daemon, logLevel: 'debug' },
      browser: { cdp: { enabled: false } },
      phoneDecisions: { native: true, stepwise: true },
    };
    const configPath = path.join(wmuxDir, 'config.json');
    fs.writeFileSync(configPath, '\uFEFF' + JSON.stringify(custom, null, 2), 'utf-8');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const config = loadConfig();
      // The file's own values, not the defaults a failed parse would give.
      expect(config.daemon.logLevel).toBe('debug');
      expect(config.browser?.cdp.enabled).toBe(false);
      expect(config.phoneDecisions).toEqual({ native: true, stepwise: true });
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  describe('a config.json that cannot be used', () => {
    const cases: Array<[string, string]> = [
      ['invalid JSON', '{{not json}}'],
      ['the wrong structure', JSON.stringify({ version: 1, daemon: 'wrong', browser: { cdp: { enabled: true } } })],
    ];
    for (const [what, content] of cases) {
      it(`${what}: left byte-identical, CDP off, one warning naming the file`, () => {
        const wmuxDir = getWmuxDir();
        fs.mkdirSync(wmuxDir, { recursive: true });
        const configPath = path.join(wmuxDir, 'config.json');
        fs.writeFileSync(configPath, content, 'utf-8');
        const before = fs.readFileSync(configPath);
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        try {
          const config = loadConfig();
          // The daemon loads on every hook signal: still one warning.
          loadConfig();
          expect(config.browser?.cdp.enabled).toBe(false);
          expect(warn).toHaveBeenCalledTimes(1);
          expect(String(warn.mock.calls[0][0])).toContain(configPath);
          expect(isFailClosedConfig(config)).toBe(true);
        } finally {
          warn.mockRestore();
        }
        expect(fs.readFileSync(configPath).equals(before)).toBe(true);
        expect(fs.existsSync(configPath + '.tmp')).toBe(false);
      });
    }

    describe('a config.json Windows reports as locked', () => {
      const realPlatform = process.platform;
      const setPlatform = (p: string): void => { Object.defineProperty(process, 'platform', { value: p }); };
      const waits: number[] = [];
      beforeEach(() => {
        waits.length = 0;
        setConfigReadSleepForTest((ms) => { waits.push(ms); });
      });
      afterEach(() => {
        setPlatform(realPlatform);
        setConfigReadSleepForTest();
        resetConfigReadStreaks();
        vi.restoreAllMocks();
      });
      function writeGood(): string {
        const wmuxDir = getWmuxDir();
        fs.mkdirSync(wmuxDir, { recursive: true });
        const configPath = path.join(wmuxDir, 'config.json');
        fs.writeFileSync(configPath, JSON.stringify({ ...createDefaultConfig(), browser: { cdp: { enabled: false } } }), 'utf-8');
        return configPath;
      }
      function lockFor(configPath: string, times: number, code = 'EBUSY') {
        const real = fs.readFileSync;
        let left = times;
        return vi.spyOn(fs, 'readFileSync').mockImplementation(((file: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
          if (file === configPath && left > 0) {
            left--;
            throw Object.assign(new Error(`${code}: resource busy or locked, open '${configPath}'`), { code });
          }
          return (real as (...a: unknown[]) => unknown)(file, ...rest);
        }) as typeof fs.readFileSync);
      }
      const readsOf = (spy: ReturnType<typeof lockFor>, configPath: string): number =>
        spy.mock.calls.filter((c) => c[0] === configPath).length;

      it('on Windows, a brief EBUSY is read again and the file is used', () => {
        setPlatform('win32');
        const configPath = writeGood();
        const spy = lockFor(configPath, 2);
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const config = loadConfig();
        expect(isFailClosedConfig(config)).toBe(false);
        expect(config.browser?.cdp.enabled).toBe(false); // the file's own value
        expect(warn).not.toHaveBeenCalled();
        expect(readsOf(spy, configPath)).toBe(3);
        expect(waits).toEqual([100, 100]);
      });

      it('on Windows, a lock that outlasts every try gives the stand-in, and later loads try once', () => {
        setPlatform('win32');
        const configPath = writeGood();
        const spy = lockFor(configPath, 100, 'EPERM');
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        expect(isFailClosedConfig(loadConfig())).toBe(true);
        expect(readsOf(spy, configPath)).toBe(CONFIG_READ_ATTEMPTS);
        expect(String(warn.mock.calls[0][0])).toContain('EPERM');
        // A lock that doesn't clear (a deny-read ACL reads as EPERM too) must not
        // cost every hook signal the full wait: the streak reads once per load.
        spy.mockClear();
        waits.length = 0;
        loadConfig();
        loadConfig();
        expect(readsOf(spy, configPath)).toBe(2);
        expect(waits).toEqual([]);
      });

      it('a file that is locked and then gone is being replaced: no defaults are written over it', () => {
        setPlatform('win32');
        const configPath = writeGood();
        const real = fs.readFileSync;
        let n = 0;
        vi.spyOn(fs, 'readFileSync').mockImplementation(((file: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
          if (file === configPath) {
            n++;
            const code = n === 1 ? 'EPERM' : 'ENOENT';
            throw Object.assign(new Error(`${code}: open '${configPath}'`), { code });
          }
          return (real as (...a: unknown[]) => unknown)(file, ...rest);
        }) as typeof fs.readFileSync);
        const before = real(configPath);
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const config = loadConfig();
        expect(isFailClosedConfig(config)).toBe(true);
        expect(String(warn.mock.calls[0][0])).toContain('being replaced');
        expect(real(configPath).equals(before)).toBe(true);
      });

      it('a file that is locked, gone, then back (delete and recreate) is read', () => {
        setPlatform('win32');
        const configPath = writeGood();
        const real = fs.readFileSync;
        let n = 0;
        vi.spyOn(fs, 'readFileSync').mockImplementation(((file: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
          if (file === configPath && ++n <= 2) {
            const code = n === 1 ? 'EPERM' : 'ENOENT';
            throw Object.assign(new Error(`${code}: open '${configPath}'`), { code });
          }
          return (real as (...a: unknown[]) => unknown)(file, ...rest);
        }) as typeof fs.readFileSync);
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const config = loadConfig();
        expect(isFailClosedConfig(config)).toBe(false);
        expect(config.browser?.cdp.enabled).toBe(false);
        expect(warn).not.toHaveBeenCalled();
      });

      it('on Windows, a config.json that is simply missing is still created with the defaults', () => {
        setPlatform('win32');
        const configPath = path.join(getWmuxDir(), 'config.json');
        const config = loadConfig();
        expect(isFailClosedConfig(config)).toBe(false);
        expect(fs.existsSync(configPath)).toBe(true);
        expect(waits).toEqual([]);
      });

      it('after a locked streak, a missing file is "being replaced" once, then created with the defaults', () => {
        setPlatform('win32');
        const configPath = writeGood();
        const spy = lockFor(configPath, CONFIG_READ_ATTEMPTS, 'EPERM');
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        expect(isFailClosedConfig(loadConfig())).toBe(true); // the streak starts
        spy.mockRestore();
        fs.rmSync(configPath);
        expect(isFailClosedConfig(loadConfig())).toBe(true); // gone right after a lock
        expect(fs.existsSync(configPath)).toBe(false);
        expect(String(warn.mock.calls.at(-1)?.[0])).toContain('being replaced');
        expect(isFailClosedConfig(loadConfig())).toBe(false); // really missing
        expect(fs.existsSync(configPath)).toBe(true);
      });

      it('a save during a locked streak reads once, with no wait', () => {
        setPlatform('win32');
        const configPath = writeGood();
        const good = loadConfig();
        const spy = lockFor(configPath, 100, 'EPERM');
        vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        loadConfig(); // the streak starts
        spy.mockClear();
        waits.length = 0;
        expect(() => saveConfigOrThrow(good)).toThrow('EPERM');
        expect(readsOf(spy, configPath)).toBe(1);
        expect(waits).toEqual([]);
      });

      it('a save waits out a brief lock instead of refusing', () => {
        setPlatform('win32');
        const configPath = writeGood();
        const good = loadConfig();
        lockFor(configPath, 2);
        good.daemon.logLevel = 'debug';
        expect(() => saveConfigOrThrow(good)).not.toThrow();
        vi.restoreAllMocks();
        expect(loadConfig().daemon.logLevel).toBe('debug');
      });

      it('elsewhere, and for a parse failure, there is no second read', () => {
        setPlatform('linux');
        const configPath = writeGood();
        const spy = lockFor(configPath, 1);
        vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        expect(isFailClosedConfig(loadConfig())).toBe(true);
        expect(readsOf(spy, configPath)).toBe(1);

        setPlatform('win32');
        fs.writeFileSync(configPath, '{ not json', 'utf-8');
        spy.mockClear();
        expect(isFailClosedConfig(loadConfig())).toBe(true);
        expect(readsOf(spy, configPath)).toBe(1);
      });
    });

    function writeGarbage(): string {
      const wmuxDir = getWmuxDir();
      fs.mkdirSync(wmuxDir, { recursive: true });
      const configPath = path.join(wmuxDir, 'config.json');
      fs.writeFileSync(configPath, '{ "browser": { "cdp": { "enabled": false } }', 'utf-8');
      return configPath;
    }

    it('names the parse error in the warning', () => {
      writeGarbage();
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      try {
        loadConfig();
        let parseError = '';
        try {
          JSON.parse('{ "browser": { "cdp": { "enabled": false } }');
        } catch (err) {
          parseError = (err as Error).message;
        }
        expect(String(warn.mock.calls[0][0])).toContain(parseError);
      } finally {
        warn.mockRestore();
      }
    });

    it('closes every setting whose default is the open side, and keeps the closed ones closed', () => {
      writeGarbage();
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      try {
        const config = loadConfig();
        const defaults = createDefaultConfig();
        expect(config.browser?.cdp.enabled).toBe(false);
        expect(config.phoneDecisions).toEqual({ native: false, stepwise: false });
        expect(config.channels?.trashTtlHours).toBe(0);
        // The live reapers keep detached and suspended sessions for a year.
        expect(config.session.detachedTtlHours).toBe(24 * 365);
        expect(config.session.suspendedTtlHours).toBe(24 * 365);
        // Stamped into each new session at create time, so left at the default.
        expect(config.session.deadSessionTtlHours).toBe(defaults.session.deadSessionTtlHours);
        expect(config.lanlink?.enabled).toBe(false);
        expect(config.a2aRemote).toEqual(defaults.a2aRemote);
        expect(config.notifySinks).toEqual([]);
        expect(config.gate).toEqual(defaults.gate);
      } finally {
        warn.mockRestore();
      }
    });

    it('names the wrong field when the structure is invalid', () => {
      const wmuxDir = getWmuxDir();
      fs.mkdirSync(wmuxDir, { recursive: true });
      const bad = { ...createDefaultConfig(), session: { ...createDefaultConfig().session, defaultCols: '120' } };
      fs.writeFileSync(path.join(wmuxDir, 'config.json'), JSON.stringify(bad), 'utf-8');
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      try {
        loadConfig();
        expect(String(warn.mock.calls[0][0])).toContain('session.defaultCols is missing or is not a number');
      } finally {
        warn.mockRestore();
      }
    });

    it('refuses to save the stand-in, through either saver, so it never lands on disk', () => {
      const configPath = writeGarbage();
      const before = fs.readFileSync(configPath);
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      try {
        const config = loadConfig();
        expect(() => saveConfigOrThrow(config)).toThrow(configPath);
        // The best-effort saver (LanLink) throws too: a stand-in is not a write failure to log.
        expect(() => saveConfig(config)).toThrow(configPath);
        // A2A saves a spread copy; the copy is still the stand-in.
        expect(() => saveConfigOrThrow({ ...config, a2aRemote: config.a2aRemote })).toThrow(configPath);
      } finally {
        warn.mockRestore();
      }
      expect(fs.readFileSync(configPath).equals(before)).toBe(true);
    });

    it('a stand-in loaded before the file was fixed still cannot overwrite the fixed file', () => {
      const configPath = writeGarbage();
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      let bootConfig: DaemonConfig;
      try {
        bootConfig = loadConfig();
      } finally {
        warn.mockRestore();
      }
      const fixed = { ...createDefaultConfig(), browser: { cdp: { enabled: false } } };
      fs.writeFileSync(configPath, JSON.stringify(fixed), 'utf-8');
      expect(isFailClosedConfig(loadConfig())).toBe(false); // a later load succeeds
      const onDisk = fs.readFileSync(configPath);
      expect(() => saveConfigOrThrow(bootConfig)).toThrow(configPath);
      expect(fs.readFileSync(configPath).equals(onDisk)).toBe(true);
    });

    it('a config loaded while the file was good does not write over it while it is broken, and does once it is fixed', () => {
      const wmuxDir = getWmuxDir();
      fs.mkdirSync(wmuxDir, { recursive: true });
      const configPath = path.join(wmuxDir, 'config.json');
      fs.writeFileSync(configPath, JSON.stringify(createDefaultConfig()), 'utf-8');
      const good = loadConfig();
      fs.writeFileSync(configPath, '{ half-written', 'utf-8');
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      try {
        loadConfig();
      } finally {
        warn.mockRestore();
      }
      good.daemon.logLevel = 'debug';
      // The broken file may be an edit in progress: both savers refuse.
      expect(() => saveConfigOrThrow(good)).toThrow(configPath);
      expect(() => saveConfig(good)).toThrow(configPath);
      expect(fs.readFileSync(configPath, 'utf-8')).toBe('{ half-written');
      // Not sticky: once the file is usable again the same object saves.
      fs.writeFileSync(configPath, JSON.stringify(createDefaultConfig()), 'utf-8');
      expect(() => saveConfigOrThrow(good)).not.toThrow();
      expect(loadConfig().daemon.logLevel).toBe('debug');
    });

    it('wmux gate refuses every action, --list included, and exits non-zero', () => {
      const configPath = writeGarbage();
      const before = fs.readFileSync(configPath);
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
      const exitCode = process.exitCode;
      try {
        // Bash is in the stand-in's default list: no "already there" from it.
        for (const [action, args] of [['--add', ['Bash']], ['--remove', ['Bash']], ['--list', []]] as const) {
          log.mockClear();
          process.exitCode = 0;
          handleGate(action, [...args], true);
          const reply = JSON.parse(String(log.mock.calls[0][0]));
          expect(reply.ok).toBe(false);
          expect(reply.error).toContain(`${configPath} could not be used`);
          expect(reply.enforcedGatedTools).toEqual(createDefaultConfig().gate?.gatedTools);
          expect(process.exitCode).toBe(1);
        }
      } finally {
        process.exitCode = exitCode;
        warn.mockRestore();
        log.mockRestore();
      }
      expect(fs.readFileSync(configPath).equals(before)).toBe(true);
    });

    it('a fixed file is used again on the next load, and saves work again', () => {
      const configPath = writeGarbage();
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      try {
        loadConfig();
      } finally {
        warn.mockRestore();
      }
      fs.writeFileSync(configPath, JSON.stringify(createDefaultConfig(), null, 2), 'utf-8');
      const config = loadConfig();
      expect(config.browser?.cdp.enabled).toBe(true);
      config.daemon.logLevel = 'debug';
      expect(() => saveConfigOrThrow(config)).not.toThrow();
      expect(loadConfig().daemon.logLevel).toBe('debug');
    });
  });
});

describe('loadConfig — a partial config.json (absent is not garbage)', () => {
  const write = (obj: unknown): string => {
    const dir = getWmuxDir();
    fs.mkdirSync(dir, { recursive: true });
    const configPath = path.join(dir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify(obj), 'utf-8');
    return configPath;
  };

  it('only browser.cdp.enabled = false (as SECURITY.md says): CDP stays off, the rest is the defaults, no stand-in', () => {
    const configPath = write({ browser: { cdp: { enabled: false } } });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const config = loadConfig();
      expect(isFailClosedConfig(config)).toBe(false);
      expect(warn).not.toHaveBeenCalled();
      expect(config.browser?.cdp.enabled).toBe(false);
      const defaults = createDefaultConfig();
      expect(config.daemon).toEqual(defaults.daemon);
      expect(config.session).toMatchObject({ defaultShell: defaults.session.defaultShell, bufferSizeMb: defaults.session.bufferSizeMb });
      expect(config.phoneDecisions).toEqual(defaults.phoneDecisions);
    } finally {
      warn.mockRestore();
    }
    // A later save (the gate migration) keeps the user's own key.
    expect(JSON.parse(fs.readFileSync(configPath, 'utf-8')).browser).toEqual({ cdp: { enabled: false } });
  });

  it('a file with only another slice ({ mcp: { mode } }): CDP stays on, no stand-in', () => {
    write({ mcp: { mode: 'enforce' } });
    const config = loadConfig();
    expect(isFailClosedConfig(config)).toBe(false);
    expect(config.browser?.cdp.enabled).toBe(true);
  });

  it('a partial daemon section keeps its own keys and gets the missing ones', () => {
    write({ daemon: { logLevel: 'debug' } });
    const config = loadConfig();
    expect(isFailClosedConfig(config)).toBe(false);
    expect(config.daemon.logLevel).toBe('debug');
    expect(config.daemon.pipeName).toBe(createDefaultConfig().daemon.pipeName);
  });

  for (const [what, content] of [
    ['a wrong-typed daemon.pipeName', { version: 1, daemon: { pipeName: 5 } }],
    ['a daemon section that is not an object', { daemon: null }],
    ['a wrong-typed session field', { session: { defaultCols: 'eighty' } }],
  ] as const) {
    it(`${what}: still fail-closed, file untouched`, () => {
      const configPath = write(content);
      const before = fs.readFileSync(configPath);
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      try {
        const config = loadConfig();
        expect(isFailClosedConfig(config)).toBe(true);
        expect(config.browser?.cdp.enabled).toBe(false);
      } finally {
        warn.mockRestore();
      }
      expect(fs.readFileSync(configPath).equals(before)).toBe(true);
    });
  }
});

describe('saveConfig', () => {
  it('writes config atomically (no .tmp residue)', () => {
    const wmuxDir = getWmuxDir();
    fs.mkdirSync(wmuxDir, { recursive: true });

    const config = createDefaultConfig();
    saveConfig(config);

    const configPath = path.join(wmuxDir, 'config.json');
    const tmpPath = configPath + '.tmp';
    expect(fs.existsSync(configPath)).toBe(true);
    expect(fs.existsSync(tmpPath)).toBe(false);

    const loaded = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    expect(loaded.version).toBe(1);
  });
});

// ── Substrate 3.0 lifecycle knobs ──────────────────────────────────────
// maxSessions / suspendedTtlHours / memWarnMb / memReapMb / memBlockMb:
// per-field backfill + clamp, never a whole-file reset on a single bad
// field. See the clamp contract in config.ts (loadConfig).

/** Write a raw (possibly partial / malformed) config object to disk. */
function writeRawConfig(obj: unknown): void {
  const wmuxDir = getWmuxDir();
  fs.mkdirSync(wmuxDir, { recursive: true });
  fs.writeFileSync(path.join(wmuxDir, 'config.json'), JSON.stringify(obj), 'utf-8');
}

describe('createDefaultConfig — lifecycle knobs', () => {
  it('includes the substrate 3.0 lifecycle defaults', () => {
    const c = createDefaultConfig();
    expect(c.session.maxSessions).toBe(200);
    expect(c.session.suspendedTtlHours).toBe(7 * 24);
    expect(c.session.detachedTtlHours).toBe(8);
    expect(c.daemon.memWarnMb).toBe(500);
    expect(c.daemon.memReapMb).toBe(750);
    expect(c.daemon.memBlockMb).toBe(1024);
  });
});

describe('loadConfig — lifecycle backfill + clamp', () => {
  it('REGRESSION #1: old config.json (no lifecycle fields) → defaults backfilled, existing fields + idleShutdownMinutes preserved', () => {
    // A v1 config from before substrate 3.0: structurally valid, no new
    // knobs, plus a customised idleShutdownMinutes/logLevel/TTL the user
    // must keep. This is the highest-priority regression.
    writeRawConfig({
      version: 1,
      daemon: { pipeName: '\\\\.\\pipe\\custom', logLevel: 'debug', autoStart: false, idleShutdownMinutes: 12 },
      session: {
        defaultShell: '/bin/zsh', defaultCols: 100, defaultRows: 40,
        bufferSizeMb: 8, bufferMaxMb: 64, deadSessionTtlHours: 48, deadSessionDumpBuffer: false,
      },
    });
    const c = loadConfig();
    // Existing fields preserved verbatim
    expect(c.daemon.pipeName).toBe('\\\\.\\pipe\\custom');
    expect(c.daemon.logLevel).toBe('debug');
    expect(c.daemon.autoStart).toBe(false);
    expect(c.daemon.idleShutdownMinutes).toBe(12);
    expect(c.session.defaultShell).toBe('/bin/zsh');
    expect(c.session.deadSessionTtlHours).toBe(48);
    expect(c.session.deadSessionDumpBuffer).toBe(false);
    // New fields backfilled to defaults
    expect(c.session.maxSessions).toBe(200);
    expect(c.session.suspendedTtlHours).toBe(7 * 24);
    expect(c.session.detachedTtlHours).toBe(8);
    expect(c.daemon.memWarnMb).toBe(500);
    expect(c.daemon.memReapMb).toBe(750);
    expect(c.daemon.memBlockMb).toBe(1024);
  });

  it('preserves valid lifecycle values (passthrough)', () => {
    const c0 = createDefaultConfig();
    writeRawConfig({
      ...c0,
      session: { ...c0.session, maxSessions: 50, suspendedTtlHours: 48, detachedTtlHours: 12 },
      daemon: { ...c0.daemon, memWarnMb: 300, memReapMb: 400, memBlockMb: 600 },
    });
    const c = loadConfig();
    expect(c.session.maxSessions).toBe(50);
    expect(c.session.suspendedTtlHours).toBe(48);
    expect(c.session.detachedTtlHours).toBe(12);
    expect(c.daemon.memWarnMb).toBe(300);
    expect(c.daemon.memReapMb).toBe(400);
    expect(c.daemon.memBlockMb).toBe(600);
  });

  it('garbage in one lifecycle field backfills ONLY that field — no whole-file reset', () => {
    const c0 = createDefaultConfig();
    writeRawConfig({
      ...c0,
      daemon: { ...c0.daemon, pipeName: '\\\\.\\pipe\\keepme' },
      session: { ...c0.session, maxSessions: 'abc' as unknown as number, suspendedTtlHours: 99, detachedTtlHours: 24 },
    });
    const c = loadConfig();
    expect(c.daemon.pipeName).toBe('\\\\.\\pipe\\keepme'); // NOT reset to default
    expect(c.session.maxSessions).toBe(200);               // garbage → backfilled
    expect(c.session.suspendedTtlHours).toBe(99);          // sibling preserved
    expect(c.session.detachedTtlHours).toBe(24);           // sibling preserved
  });

  it('clamps ≤0 / negative to the floor (no "off" for floors)', () => {
    const c0 = createDefaultConfig();
    writeRawConfig({ ...c0, session: { ...c0.session, maxSessions: 0, suspendedTtlHours: -5, detachedTtlHours: -1 } });
    const c = loadConfig();
    expect(c.session.maxSessions).toBe(1);        // MAX_SESSIONS_FLOOR
    expect(c.session.suspendedTtlHours).toBe(1);  // SUSPENDED_TTL_FLOOR_HOURS
    expect(c.session.detachedTtlHours).toBe(1);   // DETACHED_TTL_FLOOR_HOURS
  });

  it('clamps over-cap values to the cap', () => {
    const c0 = createDefaultConfig();
    writeRawConfig({ ...c0, session: { ...c0.session, maxSessions: 999999, suspendedTtlHours: 99999999, detachedTtlHours: 99999999 } });
    const c = loadConfig();
    expect(c.session.maxSessions).toBe(10_000);          // MAX_SESSIONS_CAP
    expect(c.session.suspendedTtlHours).toBe(24 * 365);  // SUSPENDED_TTL_CAP_HOURS
    expect(c.session.detachedTtlHours).toBe(24 * 365);   // DETACHED_TTL_CAP_HOURS
  });

  it('caps memory thresholds at physical RAM (absolute upper cap)', () => {
    const c0 = createDefaultConfig();
    const totalMemMb = Math.floor(os.totalmem() / 1024 / 1024);
    writeRawConfig({
      ...c0,
      daemon: { ...c0.daemon, memWarnMb: 9_999_999, memReapMb: 9_999_999, memBlockMb: 9_999_999 },
    });
    const c = loadConfig();
    expect(c.daemon.memBlockMb).toBe(totalMemMb);
    expect(c.daemon.memBlockMb).toBeLessThanOrEqual(totalMemMb);
  });

  it('REGRESSION #5: memBlockMb below the safe floor → clamped + startup warning (no silent brick)', () => {
    const c0 = createDefaultConfig();
    writeRawConfig({ ...c0, daemon: { ...c0.daemon, memWarnMb: 10, memReapMb: 20, memBlockMb: 30 } });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => { /* silence expected warning */ });
    const c = loadConfig();
    expect(c.daemon.memBlockMb).toBeGreaterThanOrEqual(256); // MEM_BLOCK_FLOOR_MB
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('below the safe floor'));
    warnSpy.mockRestore();
  });

  it('corrects memory order inversion (warn > reap > block) after clamp', () => {
    const c0 = createDefaultConfig();
    // All above their floors so the floor clamp doesn't mask the inversion;
    // the order-correction step must raise reap/block up to warn.
    writeRawConfig({ ...c0, daemon: { ...c0.daemon, memWarnMb: 900, memReapMb: 500, memBlockMb: 300 } });
    const c = loadConfig();
    expect(c.daemon.memWarnMb).toBeLessThanOrEqual(c.daemon.memReapMb);
    expect(c.daemon.memReapMb).toBeLessThanOrEqual(c.daemon.memBlockMb);
    expect(c.daemon.memWarnMb).toBe(900);  // warn stays put
    expect(c.daemon.memReapMb).toBe(900);  // raised to warn
    expect(c.daemon.memBlockMb).toBe(900); // raised to reap
  });
});

describe('createDefaultConfig — lanlink (PR-3)', () => {
  it('includes the OFF-by-default lanlink slice', () => {
    const c = createDefaultConfig();
    expect(c.lanlink).toEqual({ enabled: false, nic: null });
    expect(c.lanlink?.port).toBeUndefined();
  });
});

describe('loadConfig — lanlink backfill (PR-3, non-destructive)', () => {
  // The load-bearing backward-compat guarantee: an OLD config.json (predating the
  // lanlink field) must keep loading, get backfilled to OFF, and NOT lose any
  // sibling field — and a malformed lanlink must never trigger the whole-file
  // reset (that path is reserved for core-structure breakage).

  it('REGRESSION: old config.json with no lanlink → backfilled to OFF, all siblings preserved', () => {
    const c0 = createDefaultConfig();
    const sentinelPipe = '\\\\.\\pipe\\wmux-OLD-CONFIG-SENTINEL';
    const old: Record<string, unknown> = {
      ...c0,
      daemon: { ...c0.daemon, pipeName: sentinelPipe },
      session: { ...c0.session, maxSessions: 137 },
    };
    delete old.lanlink; // an old file simply has no lanlink key
    writeRawConfig(old);

    const c = loadConfig();
    expect(c.lanlink).toEqual({ enabled: false, nic: null }); // backfilled OFF
    expect(c.daemon.pipeName).toBe(sentinelPipe); // sibling preserved
    expect(c.session.maxSessions).toBe(137); // sibling preserved
  });

  it('garbage lanlink (string) → default OFF, pipeName NOT nuked', () => {
    const c0 = createDefaultConfig();
    const sentinelPipe = '\\\\.\\pipe\\wmux-GARBAGE-SENTINEL';
    writeRawConfig({ ...c0, daemon: { ...c0.daemon, pipeName: sentinelPipe }, lanlink: 'totally-not-an-object' });

    const c = loadConfig();
    expect(c.lanlink).toEqual({ enabled: false, nic: null });
    expect(c.daemon.pipeName).toBe(sentinelPipe);
  });

  it('array-shaped lanlink is rejected (not treated as an object) → default OFF', () => {
    const c0 = createDefaultConfig();
    writeRawConfig({ ...c0, lanlink: [] });
    expect(loadConfig().lanlink).toEqual({ enabled: false, nic: null });
  });

  it('per-field coercion: a bad sub-field backfills ONLY itself', () => {
    const c0 = createDefaultConfig();
    writeRawConfig({ ...c0, lanlink: { enabled: 'yes', nic: 12345, port: -1 } });
    const c = loadConfig();
    // enabled non-boolean → default false; nic non-object → null; port out of range → dropped
    expect(c.lanlink).toEqual({ enabled: false, nic: null });
  });

  it('preserves a fully valid lanlink slice verbatim', () => {
    const c0 = createDefaultConfig();
    const lanlink = { enabled: true, nic: { name: 'Ethernet', mac: 'aa:bb:cc:dd:ee:ff' }, port: 41234 };
    writeRawConfig({ ...c0, lanlink });
    expect(loadConfig().lanlink).toEqual(lanlink);
  });
});

// ── app-weight P1-6: idle-CPU knobs (livenessIntervalSec / snapshotIntervalSec) ──
describe('loadConfig — P1 idle-CPU knobs backfill + clamp', () => {
  it('defaults: liveness 15 s, snapshot 30 s', () => {
    const c = createDefaultConfig();
    expect(c.daemon.livenessIntervalSec).toBe(15);
    expect(c.daemon.snapshotIntervalSec).toBe(30);
  });

  it('old config.json without the knobs → backfilled, siblings preserved', () => {
    const c0 = createDefaultConfig();
    const daemonNoKnobs = { ...c0.daemon, idleShutdownMinutes: 12 } as Record<string, unknown>;
    delete daemonNoKnobs.livenessIntervalSec;
    delete daemonNoKnobs.snapshotIntervalSec;
    writeRawConfig({ ...c0, daemon: daemonNoKnobs });
    const c = loadConfig();
    expect(c.daemon.livenessIntervalSec).toBe(15);
    expect(c.daemon.snapshotIntervalSec).toBe(30);
    expect(c.daemon.idleShutdownMinutes).toBe(12);
  });

  it('valid values pass through; out-of-range clamp to [5,120] / [10,600]', () => {
    const c0 = createDefaultConfig();
    writeRawConfig({ ...c0, daemon: { ...c0.daemon, livenessIntervalSec: 30, snapshotIntervalSec: 60 } });
    let c = loadConfig();
    expect(c.daemon.livenessIntervalSec).toBe(30);
    expect(c.daemon.snapshotIntervalSec).toBe(60);

    writeRawConfig({ ...c0, daemon: { ...c0.daemon, livenessIntervalSec: 0, snapshotIntervalSec: 100000 } });
    c = loadConfig();
    expect(c.daemon.livenessIntervalSec).toBe(5);   // floor — no "off"
    expect(c.daemon.snapshotIntervalSec).toBe(600); // cap — recovery staleness bound
  });

  it('garbage in a knob backfills only that field', () => {
    const c0 = createDefaultConfig();
    writeRawConfig({ ...c0, daemon: { ...c0.daemon, livenessIntervalSec: 'fast' as unknown as number, pipeName: '\\\\.\\pipe\\keepme2' } });
    const c = loadConfig();
    expect(c.daemon.livenessIntervalSec).toBe(15);
    expect(c.daemon.pipeName).toBe('\\\\.\\pipe\\keepme2');
  });
});

describe('loadConfig — channel retention coercion', () => {
  it('rounds a deliberate sub-hour value UP to 1h (never down to "off")', () => {
    // Flooring 0.5 to 0 would read an operator asking for an AGGRESSIVE purge
    // schedule as "disabled" — the exact opposite of the stated intent.
    const c0 = createDefaultConfig();
    writeRawConfig({
      ...c0,
      channels: { trashTtlHours: 0.5, autoTrashArchivedHours: 0.25 },
    });

    const c = loadConfig();
    expect(c.channels?.trashTtlHours).toBe(1);
    expect(c.channels?.autoTrashArchivedHours).toBe(1);
  });

  it('keeps an exact 0 as OFF, and coerces negatives to OFF', () => {
    const c0 = createDefaultConfig();
    writeRawConfig({ ...c0, channels: { trashTtlHours: 0, autoTrashArchivedHours: -5 } });
    const c = loadConfig();
    expect(c.channels?.trashTtlHours).toBe(0);
    expect(c.channels?.autoTrashArchivedHours).toBe(0);
  });

  it('coerces non-numeric garbage to OFF, never back to the delete-by-default', () => {
    // The asymmetry that matters: a hand-edited `"30"` (JSON string), a null, or a
    // nested object must NOT silently restore the 30-day purge schedule the operator
    // never asked for. `0` — keep everything — is the only safe reading of garbage.
    const c0 = createDefaultConfig();
    for (const garbage of ['30', null, { hours: 30 }, [], true, 'off']) {
      writeRawConfig({
        ...c0,
        channels: { trashTtlHours: garbage, autoTrashArchivedHours: garbage },
      });
      const c = loadConfig();
      expect(c.channels?.trashTtlHours, `trashTtlHours for ${JSON.stringify(garbage)}`).toBe(0);
      expect(
        c.channels?.autoTrashArchivedHours,
        `autoTrashArchivedHours for ${JSON.stringify(garbage)}`,
      ).toBe(0);
    }
  });
});

describe('createDefaultConfig — browser.cdp (#613)', () => {
  it('includes the ON-by-default browser.cdp slice', () => {
    const c = createDefaultConfig();
    expect(c.browser).toEqual({ cdp: { enabled: true } });
  });
});

describe('loadConfig — browser.cdp backfill (#613, non-destructive)', () => {
  // Same backward-compat guarantee as lanlink: an OLD config.json (predating the
  // browser field) must keep loading, get backfilled to the ON default, and NOT
  // lose any sibling field. A malformed slice degrades to ON (never silently
  // disabling browser automation). An explicit `false` is honoured verbatim —
  // that is the opt-out path the issue exists to provide.

  it('REGRESSION: old config.json with no browser → backfilled to ON, all siblings preserved', () => {
    const c0 = createDefaultConfig();
    const sentinelPipe = '\\\\.\\pipe\\wmux-OLD-CONFIG-SENTINEL';
    const old: Record<string, unknown> = {
      ...c0,
      daemon: { ...c0.daemon, pipeName: sentinelPipe },
    };
    delete old.browser; // an old file simply has no browser key
    writeRawConfig(old);

    const c = loadConfig();
    expect(c.browser).toEqual({ cdp: { enabled: true } }); // backfilled ON
    expect(c.daemon.pipeName).toBe(sentinelPipe); // sibling preserved
  });

  it('garbage browser (string) → default ON, pipeName NOT nuked', () => {
    const c0 = createDefaultConfig();
    const sentinelPipe = '\\\\.\\pipe\\wmux-GARBAGE-SENTINEL';
    writeRawConfig({ ...c0, daemon: { ...c0.daemon, pipeName: sentinelPipe }, browser: 'totally-not-an-object' });
    const c = loadConfig();
    expect(c.daemon.pipeName).toBe(sentinelPipe);
    expect(c.browser).toEqual({ cdp: { enabled: true } });
  });

  it('array-shaped browser is rejected (not treated as an object) → default ON', () => {
    const c0 = createDefaultConfig();
    writeRawConfig({ ...c0, browser: [] });
    expect(loadConfig().browser).toEqual({ cdp: { enabled: true } });
  });

  it('non-boolean enabled → default ON', () => {
    const c0 = createDefaultConfig();
    writeRawConfig({ ...c0, browser: { cdp: { enabled: 'yes' } } });
    expect(loadConfig().browser).toEqual({ cdp: { enabled: true } });
  });

  it('★ honours browser.cdp.enabled = false verbatim (the opt-out path)', () => {
    const c0 = createDefaultConfig();
    writeRawConfig({ ...c0, browser: { cdp: { enabled: false } } });
    expect(loadConfig().browser).toEqual({ cdp: { enabled: false } });
  });
});

describe("readNotifySinks — the notify path's read-only view", () => {
  const configFile = (): string => path.join(getWmuxDir(), 'config.json');

  beforeEach(() => {
    // The mtime cache is module state, and each test writes a fresh
    // config.json into a NEW temp dir — without this, test N could be served
    // test N-1's entry.
    resetNotifySinksCache();
  });

  it('reads and coerces the slice', () => {
    const c0 = createDefaultConfig();
    writeRawConfig({
      ...c0,
      notifySinks: [
        { type: 'ntfy', url: 'https://ntfy.sh/topic', events: ['approval'] },
        { type: 'webhook', url: 'file:///etc/passwd' },
      ],
    });
    expect(readNotifySinks()).toEqual([
      { type: 'ntfy', url: 'https://ntfy.sh/topic', events: ['approval'] },
    ]);
  });

  it('★ NEVER rewrites config.json — not even when it cannot be parsed', () => {
    // The whole reason this function exists rather than reusing loadConfig.
    // loadConfig repairs a broken file by replacing it with defaults, which is
    // right at boot and catastrophic on a per-notification path: one transient
    // failure would silently discard the operator's entire configuration.
    const garbage = '{ this is not json';
    fs.mkdirSync(getWmuxDir(), { recursive: true });
    fs.writeFileSync(configFile(), garbage, 'utf-8');

    expect(readNotifySinks()).toEqual([]);
    expect(fs.readFileSync(configFile(), 'utf-8')).toBe(garbage);
  });

  it('★ does not CREATE config.json when none exists', () => {
    expect(readNotifySinks()).toEqual([]);
    expect(fs.existsSync(configFile())).toBe(false);
  });

  it('picks up an edit rather than serving the cache forever', () => {
    const c0 = createDefaultConfig();
    writeRawConfig({ ...c0, notifySinks: [{ type: 'ntfy', url: 'https://ntfy.sh/one' }] });
    expect(readNotifySinks()).toHaveLength(1);

    // Two sinks, so the (mtimeMs, size) cache key changes even if the clock
    // has not ticked between the two writes.
    writeRawConfig({
      ...c0,
      notifySinks: [
        { type: 'ntfy', url: 'https://ntfy.sh/one' },
        { type: 'webhook', url: 'https://hooks.example/two' },
      ],
    });
    expect(readNotifySinks()).toHaveLength(2);
  });
});

describe('pushPresenceSuppression — per-field backfill', () => {
  it('ships ON with the default freshness window', () => {
    expect(createDefaultConfig().pushPresenceSuppression).toEqual({
      enabled: true,
      staleAfterMs: DESKTOP_PRESENCE_STALE_AFTER_MS,
    });
  });

  it('backfills an absent slice (old config.json) to ON without touching siblings', () => {
    const c0 = createDefaultConfig();
    const withoutSlice = { ...c0 };
    delete withoutSlice.pushPresenceSuppression;
    writeRawConfig(withoutSlice);
    const loaded = loadConfig();
    expect(loaded.pushPresenceSuppression?.enabled).toBe(true);
    expect(loaded.daemon.pipeName).toBe(c0.daemon.pipeName);
  });

  it('honours enabled:false verbatim (the opt-out path)', () => {
    const c0 = createDefaultConfig();
    writeRawConfig({ ...c0, pushPresenceSuppression: { enabled: false } });
    expect(loadConfig().pushPresenceSuppression?.enabled).toBe(false);
  });

  it('resolves a non-boolean enabled toward SENDING, not toward the ON default', () => {
    const c0 = createDefaultConfig();
    writeRawConfig({ ...c0, pushPresenceSuppression: { enabled: 'yes' } });
    expect(loadConfig().pushPresenceSuppression?.enabled).toBe(false);
  });

  it('clamps a huge staleAfterMs — permanent suppression is not a preference', () => {
    const c0 = createDefaultConfig();
    writeRawConfig({
      ...c0,
      pushPresenceSuppression: { enabled: true, staleAfterMs: 24 * 60 * 60_000 },
    });
    expect(loadConfig().pushPresenceSuppression?.staleAfterMs).toBe(DESKTOP_PRESENCE_STALE_CAP_MS);
  });
});

describe('readPushPresenceSuppression', () => {
  it('reads the slice without rewriting the file', () => {
    const c0 = createDefaultConfig();
    writeRawConfig({ ...c0, pushPresenceSuppression: { enabled: true, staleAfterMs: 1234 } });
    const configPath = path.join(getWmuxDir(), 'config.json');
    const before = fs.readFileSync(configPath, 'utf-8');
    expect(readPushPresenceSuppression()).toEqual({ enabled: true, staleAfterMs: 1234 });
    expect(fs.readFileSync(configPath, 'utf-8')).toBe(before);
  });

  it('falls back to SENDING when the file is missing', () => {
    expect(readPushPresenceSuppression().enabled).toBe(false);
  });

  it('falls back to SENDING on malformed JSON, and does NOT repair the file', () => {
    const wmuxDir = getWmuxDir();
    fs.mkdirSync(wmuxDir, { recursive: true });
    const configPath = path.join(wmuxDir, 'config.json');
    fs.writeFileSync(configPath, '{ not json', 'utf-8');

    expect(readPushPresenceSuppression().enabled).toBe(false);
    // loadConfig would have overwritten the user's file with defaults here.
    expect(fs.readFileSync(configPath, 'utf-8')).toBe('{ not json');
  });

  it('treats a readable file that predates the feature as ON', () => {
    const c0 = createDefaultConfig();
    const withoutSlice = { ...c0 };
    delete withoutSlice.pushPresenceSuppression;
    writeRawConfig(withoutSlice);
    expect(readPushPresenceSuppression().enabled).toBe(true);
  });
});

describe('loadConfig — one-time PowerShell gate migration (#1939)', () => {
  /** A config.json written before the migration existed. */
  function preMigrationConfig(gate: unknown): Record<string, unknown> {
    const old: Record<string, unknown> = { ...createDefaultConfig(), gate };
    delete old.appliedMigrations;
    return old;
  }
  function readDisk(): Record<string, unknown> {
    return JSON.parse(fs.readFileSync(path.join(getWmuxDir(), 'config.json'), 'utf-8'));
  }

  it('a fresh config already carries the migration id', () => {
    expect(createDefaultConfig().appliedMigrations).toEqual([GATE_POWERSHELL_MIGRATION]);
    expect(createDefaultConfig().gate?.gatedTools).toContain('PowerShell');
  });

  it('adds PowerShell where Bash is gated, and persists it with the marker', () => {
    writeRawConfig(preMigrationConfig({ gatedTools: ['Bash', 'Write'] }));
    expect(loadConfig().gate?.gatedTools).toEqual(['Bash', 'PowerShell', 'Write']);
    const disk = readDisk();
    expect(disk.gate).toEqual({ gatedTools: ['Bash', 'PowerShell', 'Write'] });
    expect(disk.appliedMigrations).toEqual([GATE_POWERSHELL_MIGRATION]);
  });

  it('does not add PowerShell where Bash is not gated, but still records the marker', () => {
    writeRawConfig(preMigrationConfig({ gatedTools: ['Write'] }));
    expect(loadConfig().gate?.gatedTools).toEqual(['Write']);
    expect(readDisk().appliedMigrations).toEqual([GATE_POWERSHELL_MIGRATION]);
    // A gate the user turned off stays off.
    writeRawConfig(preMigrationConfig({ gatedTools: [] }));
    expect(loadConfig().gate?.gatedTools).toEqual([]);
  });

  it('runs once: a PowerShell removed afterwards with `wmux gate --remove` stays removed', () => {
    writeRawConfig(preMigrationConfig({ gatedTools: ['Bash'] }));
    expect(loadConfig().gate?.gatedTools).toEqual(['Bash', 'PowerShell']);

    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      handleGate('--remove', ['PowerShell'], true);
    } finally {
      log.mockRestore();
    }

    expect(loadConfig().gate?.gatedTools).toEqual(['Bash']);
    expect(loadConfig().gate?.gatedTools).toEqual(['Bash']);
    expect(readDisk().appliedMigrations).toEqual([GATE_POWERSHELL_MIGRATION]);
  });

  it('leaves an absent gate slice absent on disk, so it keeps tracking the defaults', () => {
    const old = preMigrationConfig(undefined);
    delete old.gate;
    writeRawConfig(old);
    expect(loadConfig().gate?.gatedTools).toContain('PowerShell');
    const disk = readDisk();
    expect('gate' in disk).toBe(false);
    expect(disk.appliedMigrations).toEqual([GATE_POWERSHELL_MIGRATION]);
  });

  it('a malformed gate slice still degrades to the defaults (gate stays on)', () => {
    writeRawConfig(preMigrationConfig('garbage'));
    expect(loadConfig().gate?.gatedTools).toContain('PowerShell');
  });

  it('a malformed ledger is repaired, keeping the string ids it had', () => {
    writeRawConfig({ ...preMigrationConfig({ gatedTools: ['Bash'] }), appliedMigrations: ['other', 7] });
    expect(loadConfig().gate?.gatedTools).toEqual(['Bash', 'PowerShell']);
    expect(readDisk().appliedMigrations).toEqual(['other', GATE_POWERSHELL_MIGRATION]);

    writeRawConfig({ ...preMigrationConfig({ gatedTools: ['Bash'] }), appliedMigrations: 'nope' });
    expect(loadConfig().gate?.gatedTools).toEqual(['Bash', 'PowerShell']);
    expect(readDisk().appliedMigrations).toEqual([GATE_POWERSHELL_MIGRATION]);
  });

  it('tries a failed save once per process, while the migrated list still applies in memory', () => {
    writeRawConfig(preMigrationConfig({ gatedTools: ['Bash'] }));
    const rename = vi.spyOn(fs, 'renameSync').mockImplementation(() => {
      throw new Error('EACCES');
    });
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      for (let i = 0; i < 3; i++) expect(loadConfig().gate?.gatedTools).toEqual(['Bash', 'PowerShell']);
      expect(rename).toHaveBeenCalledTimes(1);
      expect(error).toHaveBeenCalledTimes(1);
    } finally {
      rename.mockRestore();
      error.mockRestore();
      resetGateMigrationSaveFailure();
    }
    expect(readDisk().appliedMigrations).toBeUndefined();
  });

  it('does not touch a list once the marker is there', () => {
    writeRawConfig({
      ...preMigrationConfig({ gatedTools: ['Bash'] }),
      appliedMigrations: [GATE_POWERSHELL_MIGRATION],
    });
    expect(loadConfig().gate?.gatedTools).toEqual(['Bash']);
  });
});
